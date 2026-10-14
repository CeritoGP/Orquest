import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  BatchItemAccepted,
  BatchItemRejected,
  DashboardEvent,
  JobBatchSubmitResponse,
  JobDiffQueryOutput,
  JobDiffResponse,
  JobErrorCode,
  JobEvent,
  JobEventDraft,
  JobEventKind,
  JobInput,
  JobInputOutput,
  JobListQuery,
  JobRecord,
  JobResult,
  JobRetryInput,
  JobSendMessageInput,
  JobWaitQuery,
  JobWaitResponse,
  PaginatedResult,
  PaginationQuery,
} from "@orquest/contracts";
import {
  JobBatchSubmitInputSchema,
  JobInputSchema,
  JobRetryInputSchema,
  JobSendMessageInputSchema,
  terminalJobStatuses,
} from "@orquest/contracts";
import {
  blockJob,
  cancelJob,
  completeJob,
  createContinuationJob,
  createJob,
  createRetryJob,
  defaultExecutionProfiles,
  failJob,
  requestCancelJob,
  RunnerError,
  parseVerificationCommand,
  runVerificationCommand,
  transitionJob,
  validateWorkspacePath,
  WorktreeManager,
} from "@orquest/core";
import type { ExecutionProfiles, JobRunner, RunnerEvent } from "@orquest/core";
import { OrquestDatabase } from "@orquest/persistence";

function rawJobInput(value: unknown): JobInput | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JobInput : undefined;
}

export class JobNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(id: string) {
    super(`Job not found: ${id}`);
    this.name = "JobNotFoundError";
  }
}

export class JobConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;
  constructor(message: string, code = "JOB_ACTIVE") {
    super(message);
    this.name = "JobConflictError";
    this.code = code;
  }
}

export class JobValidationError extends Error {
  readonly statusCode = 400;
  readonly code: string;
  constructor(message: string, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "JobValidationError";
    this.code = code;
  }
}

export class JobService {
  readonly #events = new EventEmitter();
  readonly #activeJobs = new Map<string, AbortController>();
  readonly #queue: string[] = [];
  #running = 0;
  #closed = false;

  close(): void {
    this.#closed = true;
    for (const controller of this.#activeJobs.values()) {
      controller.abort();
    }
    this.#activeJobs.clear();
    this.#queue.length = 0;
  }

  constructor(
    private readonly database: OrquestDatabase,
    private readonly runner: JobRunner,
    private readonly maxConcurrency = 2,
    private readonly allowedRoots: readonly string[] = [],
    private readonly isRealRunner = false,
    private readonly worktreeManager?: WorktreeManager,
    private readonly profiles: ExecutionProfiles = defaultExecutionProfiles,
  ) {
    this.recoverPersistedJobs();
  }

  private resolveProfile(input: JobInputOutput, rawInput?: JobInput): JobInputOutput {
    const profile = this.profiles.get(input.profileId);
    if (profile === undefined) {
      throw new JobValidationError(`Unknown execution profile: ${input.profileId}`, "UNKNOWN_PROFILE");
    }
    return {
      ...input,
      agent: rawInput?.agent !== undefined ? input.agent : input.agent ?? profile.agent,
      model: rawInput?.model !== undefined ? input.model : profile.model ?? input.model,
      effort: rawInput?.effort !== undefined ? input.effort : profile.effort ?? input.effort,
      accessMode: rawInput?.accessMode !== undefined ? input.accessMode : profile.accessMode ?? input.accessMode,
    };
  }
  private recoverPersistedJobs(): void {
    for (const job of this.database.listJobs()) {
      if (job.status === "QUEUED") {
        this.#queue.push(job.id);
        continue;
      }
      if (job.status === "READY") {
        this.scheduleReadyJob(job);
        continue;
      }
      if (["RUNNING", "VERIFYING", "CANCELING"].includes(job.status)) {
        const failed = failJob(job, "Daemon restarted while the worker process was active", "UNKNOWN_FAILURE");
        this.database.saveJob(failed);
        this.recordAndPublish(failed, "job.failed", "daemon", failed.errorMessage ?? "Worker interrupted by daemon restart", {
          recoveredAfterRestart: true,
        });
        this.releaseDependents(failed.id);
      }
    }
    void this.pump();
  }
  private prepareJob(job: JobRecord): JobRecord {
    let prepared = job;

    if (job.reviewOfJobId !== undefined && job.reviewOfJobId !== null) {
      if (job.accessMode !== "read-only") {
        throw new JobValidationError("Reviewer jobs must use read-only access", "INVALID_REVIEW_ACCESS");
      }
      const source = this.database.getJob(job.reviewOfJobId);
      if (source === null) {
        throw new JobValidationError(`Review source job not found: ${job.reviewOfJobId}`, "REVIEW_SOURCE_NOT_FOUND");
      }
      if (source.accessMode !== "worktree" || source.worktreePath === null) {
        throw new JobValidationError("Review source must be an isolated worktree job", "REVIEW_SOURCE_NOT_ISOLATED");
      }
      if (source.workspacePath !== job.workspacePath) {
        throw new JobValidationError("Reviewer and source job must use the same workspace", "REVIEW_WORKSPACE_MISMATCH");
      }
      prepared = {
        ...job,
        worktreePath: source.worktreePath,
        branchName: source.branchName,
        baseCommit: source.baseCommit,
        dependsOnJobIds: [...new Set([...job.dependsOnJobIds, source.id])],
      };
    } else if (job.accessMode === "worktree") {
      if (this.worktreeManager === undefined) {
        throw new JobValidationError("Worktree execution is not configured", "WORKTREE_UNAVAILABLE");
      }
      try {
        prepared = { ...job, ...this.worktreeManager.create(job.workspacePath, job.id) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create isolated worktree";
        throw new JobValidationError(message, "WORKTREE_PREPARATION_FAILED");
      }
    }

    for (const command of prepared.verificationCommands) {
      try {
        parseVerificationCommand(command);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid verification command";
        throw new JobValidationError(message, "VERIFICATION_COMMAND_NOT_ALLOWED");
      }
    }
    for (const dependencyId of prepared.dependsOnJobIds) {
      if (dependencyId === prepared.id) {
        throw new JobValidationError("A job cannot depend on itself", "INVALID_DEPENDENCY");
      }
      if (this.database.getJob(dependencyId) === null) {
        throw new JobValidationError(`Dependency job not found: ${dependencyId}`, "DEPENDENCY_NOT_FOUND");
      }
    }
    return prepared;
  }

  private persistAndSchedule(job: JobRecord, createdMessage: string): JobRecord {
    const storedJob = this.database.saveJob(job);
    this.recordAndPublish(storedJob, "job.created", "daemon", createdMessage);
    return this.scheduleReadyJob(storedJob);
  }

  private scheduleReadyJob(job: JobRecord): JobRecord {
    const dependencies = job.dependsOnJobIds.map((id) => this.database.getJob(id));
    const unavailableIndex = dependencies.findIndex((dependency) => dependency === null);
    if (unavailableIndex >= 0) {
      throw new JobValidationError(
        `Dependency job not found: ${job.dependsOnJobIds[unavailableIndex]}`,
        "DEPENDENCY_NOT_FOUND",
      );
    }

    const resolved = dependencies.filter((dependency): dependency is JobRecord => dependency !== null);
    const failed = resolved.find((dependency) =>
      dependency.status === "FAILED" || dependency.status === "CANCELED" || dependency.status === "BLOCKED",
    );
    if (failed !== undefined) {
      const blocked = blockJob(
        job,
        "DEPENDENCY_FAILED",
        `Dependency #${failed.id.slice(0, 8)} ended in ${failed.status}`,
      );
      this.database.saveJob(blocked);
      this.recordAndPublish(blocked, "job.blocked", "daemon", blocked.errorMessage ?? "Dependency failed", {
        dependencyJobId: failed.id,
        dependencyStatus: failed.status,
      });
      this.releaseDependents(blocked.id);
      return blocked;
    }

    const pending = resolved.filter((dependency) => dependency.status !== "DONE");
    if (pending.length > 0) {
      this.recordAndPublish(job, "job.progress", "daemon", `Waiting for ${pending.length} dependency job(s)`, {
        pendingDependencyJobIds: pending.map((dependency) => dependency.id),
      });
      return job;
    }

    const queued = transitionJob(job, "QUEUED");
    this.database.saveJob(queued);
    this.recordAndPublish(queued, "job.queued", "daemon", "Job queued");
    this.#queue.push(queued.id);
    void this.pump();
    return queued;
  }

  private releaseDependents(dependencyJobId: string): void {
    for (const dependent of this.database.listDependentJobs(dependencyJobId)) {
      if (dependent.status === "READY") this.scheduleReadyJob(dependent);
    }
  }
  submit(rawInput: unknown): JobRecord {
    const input = this.resolveProfile(JobInputSchema.parse(rawInput), rawJobInput(rawInput));
    const canonicalWorkspace = validateWorkspacePath(input.workspacePath, this.allowedRoots, this.isRealRunner);

    if (input.idempotencyKey) {
      const existing = this.database.findJobByIdempotencyKey(input.idempotencyKey, canonicalWorkspace);
      if (existing) return existing;
    }

    const job = this.prepareJob(createJob({
      ...input,
      workspacePath: canonicalWorkspace,
    }));
    return this.persistAndSchedule(job, "Job created");
  }

  submitBatch(rawInput: unknown): JobBatchSubmitResponse {
    const input = JobBatchSubmitInputSchema.parse(rawInput);
    const rawJobs = typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput) && "jobs" in rawInput && Array.isArray(rawInput.jobs) ? rawInput.jobs : [];
    const accepted: BatchItemAccepted[] = [];
    const rejected: BatchItemRejected[] = [];

    for (let i = 0; i < input.jobs.length; i++) {
      const item = input.jobs[i];
      if (!item) continue;
      const sourceItem = rawJobInput(rawJobs[i]);
      let resolvedItem: JobInputOutput;
      try {
        resolvedItem = this.resolveProfile(item, sourceItem);
      } catch (error) {
        rejected.push({
          index: i,
          error: error instanceof Error ? error.message : "Invalid execution profile",
          code: error instanceof JobValidationError ? error.code : "UNKNOWN_PROFILE",
          input: item,
        });
        continue;
      }


      let canonicalWorkspace: string;
      try {
        canonicalWorkspace = validateWorkspacePath(resolvedItem.workspacePath, this.allowedRoots, this.isRealRunner);
      } catch (err) {
        rejected.push({
          index: i,
          error: err instanceof Error ? err.message : "Invalid workspace path",
          code: "INVALID_WORKSPACE",
          input: item,
        });
        continue;
      }

      if (item.idempotencyKey) {
        const existing = this.database.findJobByIdempotencyKey(item.idempotencyKey, canonicalWorkspace);
        if (existing) {
          accepted.push({
            index: i,
            job: existing,
            idempotentReplay: true,
          });
          continue;
        }
      }

      let job: JobRecord;
      try {
        job = this.prepareJob(createJob({
          ...resolvedItem,
          workspacePath: canonicalWorkspace,
        }));
      } catch (error) {
        rejected.push({
          index: i,
          error: error instanceof Error ? error.message : "Unable to prepare job",
          code: error instanceof JobValidationError ? error.code : "WORKTREE_PREPARATION_FAILED",
          input: item,
        });
        continue;
      }
      const scheduled = this.persistAndSchedule(job, "Job created");
      accepted.push({
        index: i,
        job: scheduled,
        idempotentReplay: false,
      });
    }

    void this.pump();
    return { accepted, rejected };
  }

  submitContinuation(parentJobId: string, rawInput: JobSendMessageInput): { job: JobRecord; idempotentReplay: boolean } {
    const input = JobSendMessageInputSchema.parse(rawInput);
    const parentJob = this.database.getJob(parentJobId);
    if (!parentJob) {
      throw new JobNotFoundError(parentJobId);
    }

    if (!terminalJobStatuses.has(parentJob.status)) {
      throw new JobConflictError(`Cannot continue active job (current status: ${parentJob.status})`, "JOB_ACTIVE");
    }

    if (!parentJob.conversationId || parentJob.conversationId.trim() === "") {
      throw new JobValidationError(`Cannot continue job ${parentJobId}: missing conversationId`, "MISSING_CONVERSATION_ID");
    }

    if (input.idempotencyKey) {
      const existing = this.database.findJobByIdempotencyKey(input.idempotencyKey, parentJob.workspacePath);
      if (existing) {
        return { job: existing, idempotentReplay: true };
      }
    }

    const continuationOptions = input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : undefined;
    const child = createContinuationJob(parentJob, input.message, continuationOptions);
    const scheduled = this.persistAndSchedule(child, "Continuation job created");
    return { job: scheduled, idempotentReplay: false };
  }

  submitRetry(originalJobId: string, rawInput: JobRetryInput): { job: JobRecord; idempotentReplay: boolean } {
    const input = JobRetryInputSchema.parse(rawInput);
    const originalJob = this.database.getJob(originalJobId);
    if (!originalJob) {
      throw new JobNotFoundError(originalJobId);
    }

    if (!terminalJobStatuses.has(originalJob.status) && originalJob.status !== "BLOCKED") {
      throw new JobConflictError(`Cannot retry active job (current status: ${originalJob.status})`, "JOB_ACTIVE");
    }

    if (input.idempotencyKey) {
      const existing = this.database.findJobByIdempotencyKey(input.idempotencyKey, originalJob.workspacePath);
      if (existing) {
        return { job: existing, idempotentReplay: true };
      }
    }

    const retryOptions: Parameters<typeof createRetryJob>[1] = {
      ...(input.task !== undefined ? { task: input.task } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.verificationCommands !== undefined ? { verificationCommands: input.verificationCommands } : {}),
    };
    const retryJob = this.prepareJob(createRetryJob(originalJob, retryOptions));
    const scheduled = this.persistAndSchedule(retryJob, "Retry job created");
    return { job: scheduled, idempotentReplay: false };
  }

  getJob(id: string): JobRecord | null {
    return this.database.getJob(id);
  }

  getDiff(id: string, query: JobDiffQueryOutput): JobDiffResponse {
    const job = this.database.getJob(id);
    if (job === null) throw new JobNotFoundError(id);
    if (this.worktreeManager === undefined) {
      return { jobId: id, available: false, reason: "Worktree execution is not configured", files: [], diff: "", nextCursor: null, hasMore: false };
    }
    return this.worktreeManager.getDiff(job, query);
  }

  listJobs(): JobRecord[] {
    return this.database.listJobs();
  }

  queryJobs(query: JobListQuery): PaginatedResult<JobRecord> {
    return this.database.queryJobs(query);
  }

  getEvents(id: string, afterSequence: number, limit: number): JobEvent[] {
    return this.database.listEvents(id, afterSequence, limit);
  }

  listEventsPaginated(id: string, query?: PaginationQuery): PaginatedResult<JobEvent> {
    return this.database.listEventsPaginated(id, query);
  }

  getLatestEventSequence(id: string): number {
    return this.database.getLatestEventSequence(id);
  }

  async waitJob(jobId: string, query?: JobWaitQuery, signal?: AbortSignal): Promise<JobWaitResponse> {
    const job = this.database.getJob(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const timeoutSeconds = Math.max(1, Math.min(60, query?.timeoutSeconds ?? 30));
    const after = query?.after;
    const initialLatest = this.database.getLatestEventSequence(jobId);

    if ((terminalJobStatuses.has(job.status) || job.status === "BLOCKED") || (after !== undefined && initialLatest > after)) {
      return {
        job,
        timedOut: false,
        latestEventSequence: initialLatest,
      };
    }

    return new Promise<JobWaitResponse>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      const finish = (response: JobWaitResponse) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (unsubscribe) unsubscribe();
        resolve(response);
      };

      if (signal?.aborted) {
        finish({
          job: this.database.getJob(jobId) ?? job,
          timedOut: true,
          latestEventSequence: this.database.getLatestEventSequence(jobId),
        });
        return;
      }

      signal?.addEventListener(
        "abort",
        () => {
          finish({
            job: this.database.getJob(jobId) ?? job,
            timedOut: true,
            latestEventSequence: this.database.getLatestEventSequence(jobId),
          });
        },
        { once: true },
      );

      unsubscribe = this.subscribe((event) => {
        if (settled) return;
        if (event.job.id !== jobId) return;

        const currentSeq = event.event.sequence;
        const isTerminal = terminalJobStatuses.has(event.job.status) || event.job.status === "BLOCKED";
        const hasNewEvent = after !== undefined ? currentSeq > after : true;

        if (isTerminal || hasNewEvent) {
          finish({
            job: event.job,
            timedOut: false,
            latestEventSequence: currentSeq,
          });
        }
      });

      timer = setTimeout(() => {
        const latestJob = this.database.getJob(jobId) ?? job;
        const latestSeq = this.database.getLatestEventSequence(jobId);
        finish({
          job: latestJob,
          timedOut: true,
          latestEventSequence: latestSeq,
        });
      }, timeoutSeconds * 1000);
    });
  }

  cancel(id: string): JobRecord | null {
    const controller = this.#activeJobs.get(id);
    const job = this.database.getJob(id);
    if (job === null || job.status === "DONE" || job.status === "FAILED" || job.status === "CANCELED") {
      return job;
    }

    if (controller !== undefined && (job.status === "RUNNING" || job.status === "VERIFYING")) {
      const canceling = requestCancelJob(job);
      this.database.saveJob(canceling);
      this.recordAndPublish(canceling, "job.canceling", "user", "Cancellation requested");
      controller.abort();
      return canceling;
    }

    const canceled = cancelJob(job);
    this.database.saveJob(canceled);
    this.recordAndPublish(canceled, "job.canceled", "user", "Job canceled before execution");
    this.releaseDependents(canceled.id);
    return canceled;
  }

  subscribe(listener: (event: DashboardEvent) => void): () => void {
    this.#events.on("job.updated", listener);
    return () => this.#events.off("job.updated", listener);
  }

  private async pump(): Promise<void> {
    while (this.#running < this.maxConcurrency) {
      if (this.#closed) return;
      const nextId = this.#queue.shift();
      if (nextId === undefined) return;
      const job = this.database.getJob(nextId);
      if (job === null || job.status !== "QUEUED") continue;
      this.#running += 1;
      void this.run(job).finally(() => {
        this.#running -= 1;
        void this.pump();
      });
    }
  }

  private async run(initialJob: JobRecord): Promise<void> {
    if (this.#closed) return;
    const controller = new AbortController();
    this.#activeJobs.set(initialJob.id, controller);
    let job = transitionJob(initialJob, "RUNNING");
    this.database.saveJob(job);
    this.recordAndPublish(job, "job.started", "daemon", "Worker started");

    try {
      const result = await this.runner.execute(
        job,
        (event) => {
          if (this.#closed) return;
          job = this.handleRunnerEvent(job, event);
        },
        controller.signal,
      );

      if (this.#closed) return;
      if (controller.signal.aborted) {
        const current = this.database.getJob(initialJob.id) ?? job;
        if (current.status === "CANCELING") {
          const canceled = cancelJob(current);
          this.database.saveJob(canceled);
          this.recordAndPublish(canceled, "job.canceled", "user", "Job canceled after worker closed");
        }
        return;
      }

      let finalResult = result;
      if (job.verificationCommands.length > 0) {
        job = transitionJob(job, "VERIFYING");
        this.database.saveJob(job);
        this.recordAndPublish(job, "job.progress", "daemon", "Running verification commands");
        const executionPath = job.worktreePath ?? job.workspacePath;
        const verificationResults = [] as JobResult["tests"];
        for (const command of job.verificationCommands) {
          verificationResults.push(await runVerificationCommand(command, executionPath, controller.signal));
        }
        if (controller.signal.aborted) throw new DOMException("Verification canceled", "AbortError");
        finalResult = { ...result, tests: [...result.tests, ...verificationResults] };
        const failedVerification = verificationResults.find((test) => test.status === "failed");
        if (failedVerification !== undefined) {
          const failed = failJob(job, `Verification failed: ${failedVerification.command}`);
          this.database.saveJob(failed);
          this.recordAndPublish(failed, "job.failed", "daemon", failed.errorMessage ?? "Verification failed", {
            tests: verificationResults,
          });
          return;
        }
      }
      if (job.accessMode === "worktree" && this.worktreeManager !== undefined) {
        try {
          finalResult = { ...finalResult, filesChanged: this.worktreeManager.listChangedFiles(job) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to inspect worktree changes";
          finalResult = { ...finalResult, risks: [...finalResult.risks, `Diff inspection failed: ${message}`] };
        }
      }
      job = completeJob(job, finalResult);
      this.database.saveJob(job);
      this.recordAndPublish(job, "job.completed", "runner", "Worker completed", { result: finalResult });
    } catch (error) {
      if (this.#closed) return;
      const current = this.database.getJob(initialJob.id) ?? job;
      if (error instanceof RunnerError && error.code === "CANCEL_TIMEOUT") {
        const failed = failJob(current, error.message, "CANCEL_TIMEOUT");
        this.database.saveJob(failed);
        this.recordAndPublish(failed, "job.failed", "runner", error.message, { errorCode: "CANCEL_TIMEOUT" });
      } else if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        if (current.status === "CANCELING") {
          const canceled = cancelJob(current);
          this.database.saveJob(canceled);
          this.recordAndPublish(canceled, "job.canceled", "user", "Job canceled while running");
        }
      } else if (error instanceof RunnerError && error.isBlocked) {
        const blocked = blockJob(current, error.code, error.message);
        this.database.saveJob(blocked);
        this.recordAndPublish(blocked, "job.blocked", "runner", error.message, { errorCode: error.code });
      } else {
        const code: JobErrorCode = error instanceof RunnerError ? error.code : "UNKNOWN_FAILURE";
        const message = error instanceof Error ? error.message : "Unknown runner error";
        const failed = failJob(current, message, code);
        this.database.saveJob(failed);
        this.recordAndPublish(failed, "job.failed", "runner", message, { errorCode: code });
      }
    } finally {
      this.#activeJobs.delete(initialJob.id);
      if (!this.#closed) {
        const settled = this.database.getJob(initialJob.id);
        if (settled !== null && (terminalJobStatuses.has(settled.status) || settled.status === "BLOCKED")) {
          this.releaseDependents(settled.id);
        }
      }
    }
  }

  private handleRunnerEvent(job: JobRecord, event: RunnerEvent): JobRecord {
    if (this.#closed) return job;
    const conversationId = typeof event.payload?.conversationId === "string" ? event.payload.conversationId : undefined;
    const current =
      conversationId !== undefined && conversationId !== job.conversationId
        ? { ...job, conversationId, updatedAt: new Date().toISOString() }
        : job;

    if (current !== job) {
      this.database.saveJob(current);
    }
    this.recordAndPublish(current, event.kind, "runner", event.message, event.payload, event.id ?? null);
    return current;
  }

  private recordAndPublish(
    job: JobRecord,
    kind: JobEventKind,
    source: JobEvent["source"],
    message: string,
    payload: Record<string, unknown> = {},
    deduplicationKey: string | null = null,
  ): void {
    const event = this.record(job, kind, source, message, payload, deduplicationKey);
    if (event !== null) this.publish(job, event);
  }

  private record(
    job: JobRecord,
    kind: JobEventKind,
    source: JobEvent["source"],
    message: string,
    payload: Record<string, unknown> = {},
    deduplicationKey: string | null = null,
  ): JobEvent | null {
    const draft: JobEventDraft = {
      id: randomUUID(),
      jobId: job.id,
      timestamp: new Date().toISOString(),
      kind,
      source,
      message: message.slice(0, 10_000),
      payload,
      deduplicationKey,
    };
    return this.database.appendEvent(draft);
  }

  private publish(job: JobRecord, event: JobEvent): void {
    this.#events.emit("job.updated", { type: "job.updated", job, event } satisfies DashboardEvent);
  }
}
