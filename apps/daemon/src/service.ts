import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type {
  BatchItemAccepted,
  BatchItemRejected,
  DashboardEvent,
  Effort,
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
  MetadataSource,
  PaginatedResult,
  PaginationQuery,
  ProviderMessageIdentity,
  TaskMessage,
} from "@orquest/contracts";
import {
  EffortSchema,
  JobBatchSubmitInputSchema,
  JobInputSchema,
  JobRetryInputSchema,
  JobSendMessageInputSchema,
  ProviderMessageIdentitySchema,
  terminalJobStatuses,
} from "@orquest/contracts";
import {
  AgyRunner,
  extractProviderMessageIdentity,
  extractRuntimeExecutionMetadata,
  isPrivateReasoningEvent,
  mergeProviderIdentity,
  NO_SUMMARY_FALLBACK,
  redactSecret,
  redactString,
  stripPrivateReasoning,
} from "@orquest/agy-adapter";
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
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JobInput) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deterministicUuid(namespace: string): string {
  const hex = createHash("sha256").update(namespace, "utf8").digest("hex");
  const timeLow = hex.slice(0, 8);
  const timeMid = hex.slice(8, 12);
  const timeHiAndVersion = `4${hex.slice(13, 16)}`;
  const variantNibble = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const clockSeq = `${variantNibble}${hex.slice(17, 20)}`;
  const node = hex.slice(20, 32);
  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clockSeq}-${node}`;
}

interface ReconciledAssistantEntry {
  id: string;
  messageKey: string;
  createdAt: string;
  content: string;
  final: boolean;
  observedIdentity: ProviderMessageIdentity | null;
  enrichedIdentity: ProviderMessageIdentity | null;
  seenRawDeltas: Set<string>;
}

interface AttemptConversationState {
  provider: string;
  conversationId: string | null;
  turnId: string | null;
  userMessageEnriched: boolean;
  assistantMessages: Map<string, ReconciledAssistantEntry>;
  lastAssistantKey: string | null;
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
  readonly #userMessagesByJobId = new Map<string, TaskMessage>();
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

  private defaultProviderName(): string {
    return this.isRealRunner || this.runner instanceof AgyRunner ? "agy" : "fake-agy";
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

  private findUserInstructionMessage(job: JobRecord): TaskMessage | null {
    const cached = this.#userMessagesByJobId.get(job.id);
    if (cached !== undefined) return cached;
    if (job.taskSessionId === null) return null;
    try {
      const page = this.database.queryTaskMessages(job.taskSessionId, { limit: 100, direction: "backward" });
      const found = page.items.find((item) => item.jobId === job.id && item.role === "user") ?? null;
      if (found !== null) {
        this.#userMessagesByJobId.set(job.id, found);
      }
      return found;
    } catch {
      return null;
    }
  }

  private updateUserInstructionDeliveryStatus(job: JobRecord, deliveryStatus: TaskMessage["deliveryStatus"]): void {
    if (this.#closed) return;
    const existing = this.findUserInstructionMessage(job);
    if (existing === null || existing.deliveryStatus === deliveryStatus) return;
    const updated: TaskMessage = {
      ...existing,
      deliveryStatus,
      updatedAt: new Date().toISOString(),
    };
    this.database.saveTaskMessage(updated);
    this.#userMessagesByJobId.set(job.id, updated);
  }

  private persistAndSchedule(job: JobRecord, createdMessage: string): JobRecord {
    const linkedId = job.retryOfJobId ?? job.parentJobId;
    const ancestor = linkedId !== null && linkedId !== undefined ? this.database.getJob(linkedId) : null;
    const taskSessionId = ancestor?.taskSessionId ?? job.taskSessionId ?? job.id;
    const alignedJob: JobRecord = {
      ...job,
      taskSessionId,
    };
    const intent: TaskMessage["intent"] =
      alignedJob.parentJobId !== null && alignedJob.parentJobId !== undefined ? "continue" : "initial";
    const initialMessage: TaskMessage = {
      id: deterministicUuid(`${alignedJob.id}:user:instruction`),
      taskSessionId,
      jobId: alignedJob.id,
      role: "user",
      deliveryStatus: "pending",
      source: "client",
      recipient: "worker",
      intent,
      target: { kind: "attempt", jobId: alignedJob.id },
      providerIdentity: null,
      orchestratorContext: null,
      content: redactString(alignedJob.task).slice(0, 20_000),
      createdAt: alignedJob.createdAt,
      updatedAt: alignedJob.updatedAt,
    };
    const createdEventDraft: JobEventDraft = {
      id: randomUUID(),
      jobId: alignedJob.id,
      timestamp: new Date().toISOString(),
      kind: "job.created",
      source: "daemon",
      message: redactString(createdMessage).slice(0, 10_000),
      payload: {},
      deduplicationKey: null,
    };

    const { job: storedJob, message: storedMessage, event: createdEvent } =
      this.database.saveInitialJobWithTaskMessageAndEvent(alignedJob, initialMessage, createdEventDraft);
    this.#userMessagesByJobId.set(storedJob.id, storedMessage);
    this.publish(storedJob, createdEvent);
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
    const failed = resolved.find(
      (dependency) =>
        dependency.status === "FAILED" || dependency.status === "CANCELED" || dependency.status === "BLOCKED",
    );
    if (failed !== undefined) {
      const blocked = blockJob(
        job,
        "DEPENDENCY_FAILED",
        `Dependency #${failed.id.slice(0, 8)} ended in ${failed.status}`,
      );
      this.database.saveJob(blocked);
      this.updateUserInstructionDeliveryStatus(blocked, "failed");
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

    const job = this.prepareJob(
      createJob({
        ...input,
        workspacePath: canonicalWorkspace,
      }),
    );
    return this.persistAndSchedule(job, "Job created");
  }

  submitBatch(rawInput: unknown): JobBatchSubmitResponse {
    const input = JobBatchSubmitInputSchema.parse(rawInput);
    const rawJobs =
      typeof rawInput === "object" &&
      rawInput !== null &&
      !Array.isArray(rawInput) &&
      "jobs" in rawInput &&
      Array.isArray(rawInput.jobs)
        ? rawInput.jobs
        : [];
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
        job = this.prepareJob(
          createJob({
            ...resolvedItem,
            workspacePath: canonicalWorkspace,
          }),
        );
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
      return {
        jobId: id,
        available: false,
        reason: "Worktree execution is not configured",
        files: [],
        diff: "",
        nextCursor: null,
        hasMore: false,
      };
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

    if (terminalJobStatuses.has(job.status) || job.status === "BLOCKED" || (after !== undefined && initialLatest > after)) {
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
    this.updateUserInstructionDeliveryStatus(canceled, "failed");
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

  private createAttemptConversationState(): AttemptConversationState {
    return {
      provider: this.defaultProviderName(),
      conversationId: null,
      turnId: null,
      userMessageEnriched: false,
      assistantMessages: new Map(),
      lastAssistantKey: null,
    };
  }

  private async run(initialJob: JobRecord): Promise<void> {
    if (this.#closed) return;
    const controller = new AbortController();
    this.#activeJobs.set(initialJob.id, controller);
    const attemptState = this.createAttemptConversationState();
    let job = transitionJob(initialJob, "RUNNING");
    job = this.database.saveJob(job);
    this.updateUserInstructionDeliveryStatus(job, "sent");
    this.recordAndPublish(job, "job.started", "daemon", "Worker started");

    try {
      const rawResult = await this.runner.execute(
        job,
        (event) => {
          if (this.#closed || controller.signal.aborted) return;
          job = this.handleRunnerEvent(job, event, attemptState);
        },
        controller.signal,
      );

      if (this.#closed) return;
      if (controller.signal.aborted) {
        const current = this.database.getJob(initialJob.id) ?? job;
        this.finalizeAttemptConversation(current, attemptState);
        if (current.status === "CANCELING") {
          const canceled = cancelJob(current);
          this.database.saveJob(canceled);
          this.recordAndPublish(canceled, "job.canceled", "user", "Job canceled after worker closed");
        }
        return;
      }

      const reconciled = this.reconcileFinalResult(job, rawResult, attemptState);
      job = reconciled.job;
      let finalResult = reconciled.result;

      if (job.verificationCommands.length > 0) {
        job = transitionJob(job, "VERIFYING");
        job = this.database.saveJob(job);
        this.recordAndPublish(job, "job.progress", "daemon", "Running verification commands");
        const executionPath = job.worktreePath ?? job.workspacePath;
        const verificationResults = [] as JobResult["tests"];
        for (const command of job.verificationCommands) {
          verificationResults.push(await runVerificationCommand(command, executionPath, controller.signal));
        }
        if (controller.signal.aborted) throw new DOMException("Verification canceled", "AbortError");
        const sanitizedVerification = verificationResults.map((test) => ({
          ...test,
          command: redactString(test.command),
          output: redactString(test.output),
        }));
        finalResult = { ...finalResult, tests: [...finalResult.tests, ...sanitizedVerification] };
        const failedVerification = sanitizedVerification.find((test) => test.status === "failed");
        if (failedVerification !== undefined) {
          this.finalizeAttemptConversation(job, attemptState);
          const failed = failJob(job, `Verification failed: ${failedVerification.command}`);
          this.database.saveJob(failed);
          this.recordAndPublish(failed, "job.failed", "daemon", failed.errorMessage ?? "Verification failed", {
            tests: sanitizedVerification,
          });
          return;
        }
      }
      if (job.accessMode === "worktree" && this.worktreeManager !== undefined) {
        try {
          finalResult = { ...finalResult, filesChanged: this.worktreeManager.listChangedFiles(job) };
        } catch (error) {
          const message = error instanceof Error ? redactString(error.message) : "Unable to inspect worktree changes";
          finalResult = { ...finalResult, risks: [...finalResult.risks, `Diff inspection failed: ${message}`] };
        }
      }
      this.finalizeAttemptConversation(job, attemptState);
      job = completeJob(job, finalResult);
      job = this.database.saveJob(job);
      this.recordAndPublish(job, "job.completed", "runner", "Worker completed", { result: finalResult });
    } catch (error) {
      if (this.#closed) return;
      const current = this.database.getJob(initialJob.id) ?? job;
      this.finalizeAttemptConversation(current, attemptState);
      if (error instanceof RunnerError && error.code === "CANCEL_TIMEOUT") {
        const redactedError = redactString(error.message);
        const failed = failJob(current, redactedError, "CANCEL_TIMEOUT");
        this.database.saveJob(failed);
        this.recordAndPublish(failed, "job.failed", "runner", redactedError, { errorCode: "CANCEL_TIMEOUT" });
      } else if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        if (current.status === "CANCELING") {
          const canceled = cancelJob(current);
          this.database.saveJob(canceled);
          this.recordAndPublish(canceled, "job.canceled", "user", "Job canceled while running");
        }
      } else if (error instanceof RunnerError && error.isBlocked) {
        const redactedError = redactString(error.message);
        const blocked = blockJob(current, error.code, redactedError);
        this.database.saveJob(blocked);
        this.recordAndPublish(blocked, "job.blocked", "runner", redactedError, { errorCode: error.code });
      } else {
        const code: JobErrorCode = error instanceof RunnerError ? error.code : "UNKNOWN_FAILURE";
        const message = redactString(error instanceof Error ? error.message : "Unknown runner error");
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

  private extractEventRuntimeMetadata(payload: Record<string, unknown>): {
    effectiveModel: string | null;
    effectiveEffort: Effort | null;
  } {
    if (isRecord(payload.executionMetadata)) {
      const meta = payload.executionMetadata;
      const rawModel = typeof meta.effectiveModel === "string" ? meta.effectiveModel.trim() : null;
      const effectiveModel =
        rawModel !== null && rawModel.length > 0 && !/^(?:auto|default|unknown|none|unspecified|null)$/i.test(rawModel)
          ? redactString(rawModel).slice(0, 160)
          : null;
      const parsedEffort = EffortSchema.safeParse(meta.effectiveEffort);
      const effectiveEffort = parsedEffort.success ? parsedEffort.data : null;
      if (effectiveModel !== null || effectiveEffort !== null) {
        return { effectiveModel, effectiveEffort };
      }
    }
    const extracted = extractRuntimeExecutionMetadata(payload);
    return {
      effectiveModel: extracted.effectiveModel,
      effectiveEffort: extracted.effectiveEffort,
    };
  }

  private parseIdentityCandidate(value: unknown): ProviderMessageIdentity | null {
    if (!isRecord(value)) return null;
    const parsed = ProviderMessageIdentitySchema.safeParse(value);
    if (!parsed.success) return null;
    const identity = parsed.data;
    if (identity.conversationId === null && identity.turnId === null && identity.messageId === null) {
      return null;
    }
    return {
      provider: redactString(identity.provider),
      conversationId: identity.conversationId !== null ? redactString(identity.conversationId) : null,
      turnId: identity.turnId !== null ? redactString(identity.turnId) : null,
      messageId: identity.messageId !== null ? redactString(identity.messageId) : null,
    };
  }

  private handleRunnerEvent(job: JobRecord, event: RunnerEvent, attemptState: AttemptConversationState): JobRecord {
    if (this.#closed) return job;
    if (isRecord(event.payload) && isPrivateReasoningEvent(event.payload)) {
      return job;
    }

    const sanitizedPayload = isRecord(event.payload)
      ? (redactSecret(stripPrivateReasoning(event.payload)) as Record<string, unknown>)
      : {};
    const sanitizedMessage = redactString(event.message);

    const reportedConvId =
      typeof sanitizedPayload.conversationId === "string" && sanitizedPayload.conversationId.trim().length > 0
        ? sanitizedPayload.conversationId.trim()
        : typeof sanitizedPayload.conversation_id === "string" && sanitizedPayload.conversation_id.trim().length > 0
          ? sanitizedPayload.conversation_id.trim()
          : undefined;
    if (reportedConvId !== undefined) {
      attemptState.conversationId = reportedConvId;
    }

    const reportedTurnId =
      typeof sanitizedPayload.turnId === "string" && sanitizedPayload.turnId.trim().length > 0
        ? sanitizedPayload.turnId.trim()
        : typeof sanitizedPayload.turn_id === "string" && sanitizedPayload.turn_id.trim().length > 0
          ? sanitizedPayload.turn_id.trim()
          : undefined;
    if (reportedTurnId !== undefined) {
      attemptState.turnId = reportedTurnId;
    }

    const runtimeMeta = this.extractEventRuntimeMetadata(sanitizedPayload);
    const nextConversationId = reportedConvId ?? job.conversationId;
    const nextEffectiveModel = runtimeMeta.effectiveModel ?? job.effectiveModel;
    const nextEffectiveEffort = runtimeMeta.effectiveEffort ?? job.effectiveEffort;
    const nextMetadataSource: MetadataSource =
      nextEffectiveModel !== null || nextEffectiveEffort !== null ? "runtime" : job.executionMetadataSource;

    let current = job;
    if (
      nextConversationId !== job.conversationId ||
      nextEffectiveModel !== job.effectiveModel ||
      nextEffectiveEffort !== job.effectiveEffort ||
      nextMetadataSource !== job.executionMetadataSource
    ) {
      current = this.database.saveJob({
        ...job,
        conversationId: nextConversationId,
        effectiveModel: nextEffectiveModel,
        effectiveEffort: nextEffectiveEffort,
        executionMetadataSource: nextMetadataSource,
        updatedAt: new Date().toISOString(),
      });
    }

    if (event.kind === "job.message") {
      const shouldEmit = this.reconcileRunnerMessage(current, event, sanitizedMessage, sanitizedPayload, attemptState);
      if (!shouldEmit) {
        return current;
      }
    }

    this.recordAndPublish(current, event.kind, "runner", sanitizedMessage, sanitizedPayload, event.id ?? null);
    return current;
  }

  private reconcileRunnerMessage(
    job: JobRecord,
    event: RunnerEvent,
    sanitizedMessage: string,
    sanitizedPayload: Record<string, unknown>,
    attemptState: AttemptConversationState,
  ): boolean {
    if (this.#closed || job.taskSessionId === null) return true;

    const workerMessage = isRecord(sanitizedPayload.workerMessage) ? sanitizedPayload.workerMessage : undefined;
    let messageKey: string;
    let nextContent: string;
    let isFinal: boolean;
    let observedIdentity: ProviderMessageIdentity | null;

    if (workerMessage !== undefined) {
      messageKey =
        typeof workerMessage.messageKey === "string" && workerMessage.messageKey.trim().length > 0
          ? workerMessage.messageKey.trim()
          : "response:default";
      nextContent =
        typeof workerMessage.content === "string"
          ? redactString(workerMessage.content).slice(0, 20_000)
          : sanitizedMessage.slice(0, 20_000);
      isFinal = workerMessage.final === true;
      observedIdentity = this.parseIdentityCandidate(workerMessage.providerIdentity);
      if (observedIdentity !== null) {
        attemptState.provider = observedIdentity.provider;
        if (observedIdentity.conversationId !== null) attemptState.conversationId = observedIdentity.conversationId;
        if (observedIdentity.turnId !== null) attemptState.turnId = observedIdentity.turnId;
      }
    } else {
      const rawMsgId =
        typeof sanitizedPayload.messageId === "string"
          ? sanitizedPayload.messageId.trim()
          : typeof sanitizedPayload.message_id === "string"
            ? sanitizedPayload.message_id.trim()
            : undefined;
      const rawStepIdx = sanitizedPayload.stepIndex ?? sanitizedPayload.step_index;
      messageKey =
        typeof sanitizedPayload.messageKey === "string" && sanitizedPayload.messageKey.trim().length > 0
          ? sanitizedPayload.messageKey.trim()
          : rawMsgId !== undefined && rawMsgId.length > 0
            ? `msg:${rawMsgId}`
            : rawStepIdx !== undefined && rawStepIdx !== null
              ? `step:${String(rawStepIdx)}`
              : "response:default";
      isFinal =
        sanitizedPayload.final === true ||
        sanitizedPayload.state === "DONE" ||
        sanitizedPayload.state === "COMPLETED";
      observedIdentity = extractProviderMessageIdentity(
        sanitizedPayload,
        attemptState.provider,
        attemptState.conversationId ?? undefined,
        attemptState.turnId ?? undefined,
      );

      const existingEntry = attemptState.assistantMessages.get(messageKey);
      const explicitChunkId =
        sanitizedPayload.deltaIndex ??
        sanitizedPayload.delta_index ??
        sanitizedPayload.chunkIndex ??
        sanitizedPayload.chunk_index ??
        event.id;
      const deltaSig =
        explicitChunkId !== undefined && explicitChunkId !== null
          ? `id:${String(explicitChunkId)}:${sanitizedMessage}`
          : `${isFinal ? "done" : "delta"}:${sanitizedMessage}`;

      if (existingEntry !== undefined) {
        if (existingEntry.seenRawDeltas.has(deltaSig)) {
          return false;
        }
        if (existingEntry.final && !isFinal && existingEntry.content.includes(sanitizedMessage)) {
          return false;
        }
        existingEntry.seenRawDeltas.add(deltaSig);

        if (isFinal && (sanitizedMessage === existingEntry.content || sanitizedMessage.startsWith(existingEntry.content))) {
          nextContent = sanitizedMessage.slice(0, 20_000);
        } else if (isFinal && existingEntry.content.endsWith(sanitizedMessage)) {
          nextContent = existingEntry.content;
        } else if (sanitizedMessage === existingEntry.content) {
          nextContent = existingEntry.content;
        } else {
          nextContent = `${existingEntry.content}${sanitizedMessage}`.slice(0, 20_000);
        }
      } else {
        nextContent = sanitizedMessage.slice(0, 20_000);
      }
    }

    if (nextContent.trim().length === 0) {
      return false;
    }

    this.upsertAssistantTaskMessage(job, messageKey, nextContent, isFinal, observedIdentity, attemptState);
    return true;
  }

  private upsertAssistantTaskMessage(
    job: JobRecord,
    messageKey: string,
    content: string,
    isFinal: boolean,
    observedIdentity: ProviderMessageIdentity | null,
    attemptState: AttemptConversationState,
  ): void {
    if (this.#closed || job.taskSessionId === null) return;
    const nowIso = new Date().toISOString();
    const boundedContent = content.slice(0, 20_000);
    const existing = attemptState.assistantMessages.get(messageKey);

    if (existing === undefined) {
      const id = deterministicUuid(`${job.id}:assistant:${messageKey}`);
      const initialRawSig = `${isFinal ? "done" : "delta"}:${boundedContent}`;
      const record: TaskMessage = {
        id,
        taskSessionId: job.taskSessionId,
        jobId: job.id,
        role: "assistant",
        deliveryStatus: "received",
        source: "runtime",
        recipient: "user",
        intent: "response",
        target: { kind: "attempt", jobId: job.id },
        providerIdentity: null,
        orchestratorContext: null,
        content: boundedContent,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.database.saveTaskMessage(record);
      attemptState.assistantMessages.set(messageKey, {
        id,
        messageKey,
        createdAt: nowIso,
        content: boundedContent,
        final: isFinal,
        observedIdentity,
        enrichedIdentity: null,
        seenRawDeltas: new Set([initialRawSig]),
      });
      attemptState.lastAssistantKey = messageKey;
      return;
    }

    existing.observedIdentity = mergeProviderIdentity(existing.observedIdentity, observedIdentity);
    existing.final = existing.final || isFinal;
    attemptState.lastAssistantKey = messageKey;

    if (existing.content !== boundedContent) {
      existing.content = boundedContent;
      const updatedRecord: TaskMessage = {
        id: existing.id,
        taskSessionId: job.taskSessionId,
        jobId: job.id,
        role: "assistant",
        deliveryStatus: "received",
        source: "runtime",
        recipient: "user",
        intent: "response",
        target: { kind: "attempt", jobId: job.id },
        providerIdentity: existing.enrichedIdentity,
        orchestratorContext: null,
        content: existing.content,
        createdAt: existing.createdAt,
        updatedAt: nowIso,
      };
      this.database.saveTaskMessage(updatedRecord);
    }
  }

  private reconcileFinalResult(
    job: JobRecord,
    rawResult: JobResult,
    attemptState: AttemptConversationState,
  ): { job: JobRecord; result: JobResult } {
    const reportedConvId =
      rawResult.conversationId !== undefined && rawResult.conversationId.trim().length > 0
        ? redactString(rawResult.conversationId.trim())
        : undefined;
    if (reportedConvId !== undefined) {
      attemptState.conversationId = reportedConvId;
    }

    let currentJob = job;
    if (reportedConvId !== undefined && reportedConvId !== job.conversationId) {
      currentJob = this.database.saveJob({
        ...job,
        conversationId: reportedConvId,
        updatedAt: new Date().toISOString(),
      });
    }

    const sanitizedSummary = redactString(rawResult.summary);
    const isPlaceholderNoSummary = sanitizedSummary === NO_SUMMARY_FALLBACK;
    const lastEntry =
      attemptState.lastAssistantKey !== null
        ? attemptState.assistantMessages.get(attemptState.lastAssistantKey)
        : undefined;

    let finalSummary = sanitizedSummary;

    if (isPlaceholderNoSummary) {
      if (lastEntry !== undefined && lastEntry.content.trim().length > 0) {
        lastEntry.final = true;
        finalSummary = lastEntry.content;
      }
    } else if (lastEntry !== undefined) {
      if (sanitizedSummary === lastEntry.content) {
        lastEntry.final = true;
      } else if (sanitizedSummary.startsWith(lastEntry.content) || !lastEntry.final) {
        this.upsertAssistantTaskMessage(
          currentJob,
          lastEntry.messageKey,
          sanitizedSummary,
          true,
          lastEntry.observedIdentity,
          attemptState,
        );
      } else if (lastEntry.content.startsWith(sanitizedSummary)) {
        lastEntry.final = true;
        finalSummary = lastEntry.content;
      } else {
        this.upsertAssistantTaskMessage(currentJob, "result:final", sanitizedSummary, true, null, attemptState);
      }
    } else if (sanitizedSummary.trim().length > 0) {
      this.upsertAssistantTaskMessage(currentJob, "result:final", sanitizedSummary, true, null, attemptState);
    }

    const sanitizedResult: JobResult = {
      ...rawResult,
      summary: finalSummary,
      tests: rawResult.tests.map((test) => ({
        ...test,
        command: redactString(test.command),
        output: redactString(test.output),
      })),
      filesChanged: [...rawResult.filesChanged],
      risks: rawResult.risks.map(redactString),
      ...(reportedConvId !== undefined ? { conversationId: reportedConvId } : {}),
    };

    return { job: currentJob, result: sanitizedResult };
  }

  private finalizeAttemptConversation(job: JobRecord, attemptState: AttemptConversationState): void {
    if (this.#closed || job.taskSessionId === null) return;
    const nowIso = new Date().toISOString();

    if (!attemptState.userMessageEnriched && (attemptState.conversationId !== null || attemptState.turnId !== null)) {
      const userMessage = this.findUserInstructionMessage(job);
      if (userMessage !== null && (userMessage.providerIdentity === null || userMessage.providerIdentity === undefined)) {
        const userIdentity: ProviderMessageIdentity = {
          provider: attemptState.provider,
          conversationId: attemptState.conversationId,
          turnId: attemptState.turnId,
          messageId: null,
        };
        const enriched = this.database.enrichTaskMessageProviderIdentity(userMessage.id, userIdentity, nowIso);
        this.#userMessagesByJobId.set(job.id, enriched);
        attemptState.userMessageEnriched = true;
      }
    }

    for (const entry of attemptState.assistantMessages.values()) {
      if (entry.enrichedIdentity !== null) continue;
      const fallbackIdentity: ProviderMessageIdentity | null =
        attemptState.conversationId !== null || attemptState.turnId !== null
          ? {
              provider: attemptState.provider,
              conversationId: attemptState.conversationId,
              turnId: attemptState.turnId,
              messageId: null,
            }
          : null;
      const merged = mergeProviderIdentity(entry.observedIdentity, fallbackIdentity);
      if (merged !== null && (merged.conversationId !== null || merged.turnId !== null || merged.messageId !== null)) {
        this.database.enrichTaskMessageProviderIdentity(entry.id, merged, nowIso);
        entry.enrichedIdentity = merged;
      }
    }
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
    const sanitizedPayload = redactSecret(stripPrivateReasoning(payload));
    const draft: JobEventDraft = {
      id: randomUUID(),
      jobId: job.id,
      timestamp: new Date().toISOString(),
      kind,
      source,
      message: redactString(message).slice(0, 10_000),
      payload: isRecord(sanitizedPayload) ? sanitizedPayload : {},
      deduplicationKey,
    };
    return this.database.appendEvent(draft);
  }

  private publish(job: JobRecord, event: JobEvent): void {
    this.#events.emit("job.updated", { type: "job.updated", job, event } satisfies DashboardEvent);
  }
}
