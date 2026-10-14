import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardEvent, JobInput, JobRecord, JobResult } from "@orquest/contracts";
import { NO_SUMMARY_FALLBACK } from "@orquest/agy-adapter";
import { createJob, type JobRunner } from "@orquest/core";
import { FakeAgyRunner } from "@orquest/fake-agy";
import { OrquestDatabase } from "@orquest/persistence";
import { JobService } from "./service.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function jobInput(workspacePath: string): JobInput {
  return {
    title: "Inspect repository",
    task: "List the important files.",
    workspacePath,
    profileId: "quick",
    accessMode: "read-only",
    model: "auto",
    effort: "medium",
    acceptanceCriteria: [],
    verificationCommands: [],
    priority: 50,
  };
}

async function waitForCompletion(service: JobService, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const job = service.getJob(jobId);
    if (job?.status === "DONE") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Job did not complete within the test timeout");
}

async function waitForStatus(service: JobService, jobId: string, status: JobRecord["status"]): Promise<JobRecord> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = service.getJob(jobId);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job did not reach ${status} within the test timeout`);
}

class ControlledRunner implements JobRunner {
  readonly started: string[] = [];
  readonly #pending = new Map<string, { resolve: (result: JobResult) => void; reject: (error: Error) => void }>();

  execute(job: JobRecord, _emit: Parameters<JobRunner["execute"]>[1], signal: AbortSignal): Promise<JobResult> {
    this.started.push(job.id);
    return new Promise((resolve, reject) => {
      this.#pending.set(job.id, { resolve, reject });
      signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true });
    });
  }

  succeed(jobId: string): void {
    const pending = this.#pending.get(jobId);
    if (pending === undefined) throw new Error(`Runner has not started job ${jobId}`);
    this.#pending.delete(jobId);
    pending.resolve({ summary: `Completed ${jobId}`, tests: [], filesChanged: [], risks: [] });
  }

  fail(jobId: string): void {
    const pending = this.#pending.get(jobId);
    if (pending === undefined) throw new Error(`Runner has not started job ${jobId}`);
    this.#pending.delete(jobId);
    pending.reject(new Error(`Failed ${jobId}`));
  }
}

class DuplicateEventRunner implements JobRunner {
  async execute(_job: JobRecord, emit: Parameters<JobRunner["execute"]>[1], signal: AbortSignal): Promise<JobResult> {
    void signal;
    const event = { id: "same-event", kind: "job.progress" as const, message: "Duplicate progress" };
    emit(event);
    emit(event);
    return {
      summary: "Completed after emitting a duplicate event.",
      tests: [],
      filesChanged: [],
      risks: [],
    };
  }
}

describe("JobService", () => {
  it("persists the event timeline and completed job across a database restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-test-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "orquest.db");
    const database = new OrquestDatabase(databasePath);
    const service = new JobService(database, new FakeAgyRunner(), 1);
    const job = service.submit(jobInput(directory));

    const completed = await waitForCompletion(service, job.id);
    const events = service.getEvents(job.id, 0, 50);

    expect(completed.status).toBe("DONE");
    expect(events.map((event) => event.kind)).toContain("job.tool");
    expect(events.at(-1)?.kind).toBe("job.completed");
    database.close();

    const rehydratedDatabase = new OrquestDatabase(databasePath);
    const rehydratedService = new JobService(rehydratedDatabase, new FakeAgyRunner(), 1);
    expect(rehydratedService.getJob(job.id)?.status).toBe("DONE");
    expect(rehydratedService.getEvents(job.id, 0, 50).map((event) => event.id)).toEqual(events.map((event) => event.id));
    rehydratedDatabase.close();
  });

  it("persists and publishes a replayed runner event only once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const service = new JobService(database, new DuplicateEventRunner(), 1);
    const published: DashboardEvent[] = [];
    const unsubscribe = service.subscribe((event) => published.push(event));

    const job = service.submit(jobInput(directory));
    await waitForCompletion(service, job.id);

    expect(service.getEvents(job.id, 0, 50).filter((event) => event.deduplicationKey === "same-event")).toHaveLength(1);
    expect(published.filter((event) => event.event.deduplicationKey === "same-event")).toHaveLength(1);
    unsubscribe();
    database.close();
  });

  it("holds dependent jobs until prerequisites complete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-dependency-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const runner = new ControlledRunner();
    const service = new JobService(database, runner, 1);

    const prerequisite = service.submit(jobInput(directory));
    await waitForStatus(service, prerequisite.id, "RUNNING");
    const dependent = service.submit({ ...jobInput(directory), title: "Dependent inspection", dependsOnJobIds: [prerequisite.id] });

    expect(dependent.status).toBe("READY");
    expect(runner.started).toEqual([prerequisite.id]);

    runner.succeed(prerequisite.id);
    await waitForStatus(service, dependent.id, "RUNNING");
    expect(runner.started).toEqual([prerequisite.id, dependent.id]);
    runner.succeed(dependent.id);
    await waitForStatus(service, dependent.id, "DONE");
    service.close();
    database.close();
  });

  it("blocks dependents after a failed prerequisite and treats BLOCKED as settled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-dependency-failure-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const runner = new ControlledRunner();
    const service = new JobService(database, runner, 1);

    const prerequisite = service.submit(jobInput(directory));
    await waitForStatus(service, prerequisite.id, "RUNNING");
    const dependent = service.submit({ ...jobInput(directory), title: "Blocked dependent", dependsOnJobIds: [prerequisite.id] });
    runner.fail(prerequisite.id);

    const blocked = await waitForStatus(service, dependent.id, "BLOCKED");
    expect(blocked.errorCode).toBe("DEPENDENCY_FAILED");
    const waited = await service.waitJob(dependent.id, { timeoutSeconds: 1 });
    expect(waited.timedOut).toBe(false);
    service.close();
    database.close();
  });

  it("runs a read-only reviewer against the implementer's isolated worktree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-review-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const runner = new ControlledRunner();
    const service = new JobService(database, runner, 1);
    const finishedAt = new Date().toISOString();
    const writer = {
      ...createJob({ ...jobInput(directory), title: "Writer", accessMode: "worktree", profileId: "implementer" }),
      status: "DONE" as const,
      worktreePath: join(directory, "writer-worktree"),
      branchName: "orquest/writer",
      baseCommit: "a".repeat(40),
      finishedAt,
      updatedAt: finishedAt,
    };
    database.saveJob(writer);

    const reviewer = service.submit({
      ...jobInput(directory),
      title: "Review writer changes",
      profileId: "reviewer",
      accessMode: "read-only",
      reviewOfJobId: writer.id,
    });

    expect(reviewer.worktreePath).toBe(writer.worktreePath);
    expect(reviewer.dependsOnJobIds).toContain(writer.id);
    expect(reviewer.accessMode).toBe("read-only");
    await waitForStatus(service, reviewer.id, "RUNNING");
    runner.succeed(reviewer.id);
    await waitForStatus(service, reviewer.id, "DONE");
    service.close();
    database.close();
  });

  it("recovers queued work and marks interrupted workers failed after a daemon restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-recovery-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const queued = { ...createJob({ ...jobInput(directory), title: "Queued before restart" }), status: "QUEUED" as const };
    const runningAt = new Date().toISOString();
    const interrupted = {
      ...createJob({ ...jobInput(directory), title: "Interrupted before restart" }),
      status: "RUNNING" as const,
      startedAt: runningAt,
    };
    database.saveJob(queued);
    database.saveJob(interrupted);

    const runner = new ControlledRunner();
    const service = new JobService(database, runner, 1);
    await waitForStatus(service, queued.id, "RUNNING");
    expect(service.getJob(interrupted.id)?.status).toBe("FAILED");
    expect(service.getJob(interrupted.id)?.errorMessage).toContain("Daemon restarted");
    runner.succeed(queued.id);
    await waitForStatus(service, queued.id, "DONE");
    service.close();
    database.close();
  });

  it("runs allowed verification commands and stores their results", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-verification-test-"));
    tempDirectories.push(directory);
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const service = new JobService(database, new FakeAgyRunner(), 1);
    const job = service.submit({ ...jobInput(directory), verificationCommands: ["git diff --check"] });

    const completed = await waitForCompletion(service, job.id);
    expect(completed.result?.tests).toContainEqual(
      expect.objectContaining({
        command: "git diff --check",
        status: "passed",
      }),
    );
    service.close();
    database.close();
  });

  it("rejects verification commands outside the explicit allowlist", () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-verification-policy-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const service = new JobService(database, new FakeAgyRunner(), 1);

    expect(() => service.submit({ ...jobInput(directory), verificationCommands: ["cmd /c dir"] })).toThrow("not allowed");
    service.close();
    database.close();
  });

  it("keeps explicit values over profile defaults for single and batch submissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-profile-overrides-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const service = new JobService(database, new FakeAgyRunner(), 1);
    const explicit = {
      ...jobInput(directory),
      profileId: "implementer",
      model: "custom-model",
      effort: "medium" as const,
      accessMode: "read-only" as const,
    };

    const single = service.submit(explicit);
    const batch = service.submitBatch({ jobs: [{ ...explicit, title: "Inspect override batch" }] });
    expect(single).toMatchObject({ model: "custom-model", effort: "medium", accessMode: "read-only" });
    expect(batch.accepted[0]?.job).toMatchObject({ model: "custom-model", effort: "medium", accessMode: "read-only" });
    await waitForCompletion(service, single.id);
    await waitForCompletion(service, batch.accepted[0]?.job.id ?? "");
    service.close();
    database.close();
  });

  it("applies built-in profile defaults before queuing a worker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-profile-resolution-test-"));
    tempDirectories.push(directory);
    const database = new OrquestDatabase(join(directory, "orquest.db"));
    const service = new JobService(database, new FakeAgyRunner(), 1);

    const reviewer = service.submit({
      title: "Inspect profile defaults",
      task: "List the important files.",
      workspacePath: directory,
      profileId: "reviewer",
    });
    expect(reviewer.effort).toBe("high");
    expect(reviewer.accessMode).toBe("read-only");
    await waitForCompletion(service, reviewer.id);
    service.close();
    database.close();
  });

  describe("D03 worker conversation persistence, reconciliation, and metadata", () => {
    it("reconciles fragmented and repeated stream deltas with the final summary without creating duplicate messages", async () => {
      const directory = mkdtempSync(join(tmpdir(), "orquest-d03-fragmented-"));
      tempDirectories.push(directory);
      const database = new OrquestDatabase(join(directory, "orquest.db"));
      const runner = new FakeAgyRunner({
        stepDelayMs: 5,
        conversationId: "conv-frag-1",
        turnId: "turn-frag-1",
        messageId: "msg-frag-1",
        replayStream: true,
        steps: [
          {
            id: "delta-1",
            kind: "job.message",
            messageKey: "msg:msg-frag-1",
            messageId: "msg-frag-1",
            textDelta: "Análisis inicial, ",
            repeat: 2,
          },
          {
            id: "delta-2",
            kind: "job.message",
            messageKey: "msg:msg-frag-1",
            messageId: "msg-frag-1",
            textDelta: "detalle intermedio ",
            repeat: 2,
          },
          {
            id: "delta-3",
            kind: "job.message",
            messageKey: "msg:msg-frag-1",
            messageId: "msg-frag-1",
            textDelta: "y conclusión final.",
            final: true,
          },
        ],
        finalSummary: "Análisis inicial, detalle intermedio y conclusión final.",
      });
      const service = new JobService(database, runner, 1);

      const submitted = service.submit(jobInput(directory));
      const completed = await waitForCompletion(service, submitted.id);

      const page = database.queryTaskMessages(completed.taskSessionId!, { limit: 20 });
      expect(page.items).toHaveLength(2);
      const [userMessage, assistantMessage] = page.items;
      expect(userMessage).toMatchObject({
        role: "user",
        deliveryStatus: "sent",
        source: "client",
        recipient: "worker",
        intent: "initial",
        target: { kind: "attempt", jobId: completed.id },
        content: "List the important files.",
        providerIdentity: {
          provider: "fake-agy",
          conversationId: "conv-frag-1",
          turnId: "turn-frag-1",
          messageId: null,
        },
      });
      expect(assistantMessage).toMatchObject({
        role: "assistant",
        deliveryStatus: "received",
        source: "runtime",
        recipient: "user",
        intent: "response",
        target: { kind: "attempt", jobId: completed.id },
        content: "Análisis inicial, detalle intermedio y conclusión final.",
        providerIdentity: {
          provider: "fake-agy",
          conversationId: "conv-frag-1",
          turnId: "turn-frag-1",
          messageId: "msg-frag-1",
        },
      });
      expect(completed.result?.summary).toBe("Análisis inicial, detalle intermedio y conclusión final.");
      service.close();
      database.close();
    });

    it("handles final results without a summary both with prior streamed deltas and without any assistant text", async () => {
      const directory = mkdtempSync(join(tmpdir(), "orquest-d03-no-summary-"));
      tempDirectories.push(directory);
      const database = new OrquestDatabase(join(directory, "orquest.db"));

      // Case A: Deltas streamed, final result omits summary
      const runnerWithDeltas = new FakeAgyRunner({
        stepDelayMs: 5,
        steps: [
          {
            id: "streamed-1",
            kind: "job.message",
            messageKey: "turn-response",
            textDelta: "Respuesta pública emitida en deltas sin resumen en result.",
          },
        ],
        finalSummary: null,
      });
      const serviceWithDeltas = new JobService(database, runnerWithDeltas, 1);
      const jobA = serviceWithDeltas.submit({ ...jobInput(directory), title: "Streamed without final summary" });
      const completedA = await waitForCompletion(serviceWithDeltas, jobA.id);
      const messagesA = database.queryTaskMessages(completedA.taskSessionId!).items;
      expect(messagesA).toHaveLength(2);
      expect(messagesA[1]?.content).toBe("Respuesta pública emitida en deltas sin resumen en result.");
      expect(completedA.result?.summary).toBe("Respuesta pública emitida en deltas sin resumen en result.");
      serviceWithDeltas.close();

      // Case B: Only tool/progress events, final result omits summary
      const runnerWithoutDeltas = new FakeAgyRunner({
        stepDelayMs: 5,
        steps: [
          {
            id: "tool-only",
            kind: "job.tool",
            message: "read_files",
            payload: { tool: "read_files" },
          },
        ],
        finalSummary: null,
      });
      const serviceWithoutDeltas = new JobService(database, runnerWithoutDeltas, 1);
      const jobB = serviceWithoutDeltas.submit({ ...jobInput(directory), title: "Tool only without summary" });
      const completedB = await waitForCompletion(serviceWithoutDeltas, jobB.id);
      const messagesB = database.queryTaskMessages(completedB.taskSessionId!).items;
      expect(messagesB).toHaveLength(1);
      expect(messagesB[0]?.role).toBe("user");
      expect(completedB.result?.summary).toBe(NO_SUMMARY_FALLBACK);
      serviceWithoutDeltas.close();
      database.close();
    });

    it("preserves partial public messages on mid-stream cancellation and marks pre-execution cancel as failed delivery", async () => {
      const directory = mkdtempSync(join(tmpdir(), "orquest-d03-cancel-"));
      tempDirectories.push(directory);
      const database = new OrquestDatabase(join(directory, "orquest.db"));

      let readyJobId: string | null = null;
      const runner = new FakeAgyRunner({
        stepDelayMs: 5,
        conversationId: "conv-cancel-1",
        turnId: "turn-cancel-1",
        messageId: "msg-cancel-1",
        holdUntilAbort: true,
        onReadyForAbort: (runningJob) => {
          readyJobId = runningJob.id;
        },
        steps: [
          {
            id: "partial-delta",
            kind: "job.message",
            messageKey: "msg:msg-cancel-1",
            messageId: "msg-cancel-1",
            textDelta: "Respuesta parcial antes de cancelar.",
          },
        ],
      });
      const service = new JobService(database, runner, 1);

      const activeJob = service.submit({ ...jobInput(directory), title: "Cancel mid-stream" });
      const queuedJob = service.submit({ ...jobInput(directory), title: "Cancel while queued" });

      for (let attempt = 0; attempt < 60 && readyJobId === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      expect(readyJobId).toBe(activeJob.id);

      service.cancel(queuedJob.id);
      const canceledQueued = await waitForStatus(service, queuedJob.id, "CANCELED");
      const queuedMessages = database.queryTaskMessages(canceledQueued.taskSessionId!).items;
      expect(queuedMessages).toHaveLength(1);
      expect(queuedMessages[0]?.deliveryStatus).toBe("failed");

      service.cancel(activeJob.id);
      const canceledActive = await waitForStatus(service, activeJob.id, "CANCELED");
      const activeMessages = database.queryTaskMessages(canceledActive.taskSessionId!).items;
      expect(activeMessages).toHaveLength(2);
      expect(activeMessages[0]).toMatchObject({
        role: "user",
        deliveryStatus: "sent",
        providerIdentity: {
          provider: "fake-agy",
          conversationId: "conv-cancel-1",
          turnId: "turn-cancel-1",
          messageId: null,
        },
      });
      expect(activeMessages[1]).toMatchObject({
        role: "assistant",
        deliveryStatus: "received",
        content: "Respuesta parcial antes de cancelar.",
        providerIdentity: {
          provider: "fake-agy",
          conversationId: "conv-cancel-1",
          turnId: "turn-cancel-1",
          messageId: "msg-cancel-1",
        },
      });

      service.close();
      database.close();
    });

    it("keeps effective model, effort, and provider identity unknown unless runtime protocol reports concrete values", async () => {
      const directory = mkdtempSync(join(tmpdir(), "orquest-d03-identity-"));
      tempDirectories.push(directory);
      const database = new OrquestDatabase(join(directory, "orquest.db"));

      const unknownRunner = new FakeAgyRunner({
        stepDelayMs: 5,
        unknownIdentity: true,
        reportedModel: "auto",
        reportedEffort: null,
      });
      const unknownService = new JobService(database, unknownRunner, 1);
      const unknownJob = unknownService.submit({
        ...jobInput(directory),
        model: "auto",
        effort: "medium",
      });
      const completedUnknown = await waitForCompletion(unknownService, unknownJob.id);
      expect(completedUnknown.model).toBe("auto");
      expect(completedUnknown.effort).toBe("medium");
      expect(completedUnknown.effectiveModel).toBeNull();
      expect(completedUnknown.effectiveEffort).toBeNull();
      expect(completedUnknown.executionMetadataSource).toBe("unknown");
      expect(completedUnknown.conversationId).toBeNull();

      const unknownMessages = database.queryTaskMessages(completedUnknown.taskSessionId!).items;
      expect(unknownMessages).toHaveLength(2);
      expect(unknownMessages[0]?.providerIdentity).toBeNull();
      expect(unknownMessages[1]?.providerIdentity).toBeNull();
      unknownService.close();

      const runtimeRunner = new FakeAgyRunner({
        stepDelayMs: 5,
        conversationId: "conv-runtime-99",
        turnId: "turn-runtime-99",
        messageId: "msg-runtime-99",
        reportedModel: "gemini-3.8-pro",
        reportedEffort: "high",
      });
      const runtimeService = new JobService(database, runtimeRunner, 1);
      const runtimeJob = runtimeService.submit({
        ...jobInput(directory),
        model: "auto",
        effort: "low",
      });
      const completedRuntime = await waitForCompletion(runtimeService, runtimeJob.id);
      expect(completedRuntime.model).toBe("auto");
      expect(completedRuntime.effort).toBe("low");
      expect(completedRuntime.effectiveModel).toBe("gemini-3.8-pro");
      expect(completedRuntime.effectiveEffort).toBe("high");
      expect(completedRuntime.executionMetadataSource).toBe("runtime");

      const runtimeMessages = database.queryTaskMessages(completedRuntime.taskSessionId!).items;
      expect(runtimeMessages[0]?.providerIdentity).toEqual({
        provider: "fake-agy",
        conversationId: "conv-runtime-99",
        turnId: "turn-runtime-99",
        messageId: null,
      });
      expect(runtimeMessages[1]?.providerIdentity).toEqual({
        provider: "fake-agy",
        conversationId: "conv-runtime-99",
        turnId: "turn-runtime-99",
        messageId: "msg-runtime-99",
      });
      runtimeService.close();
      database.close();
    });

    it("excludes private reasoning and redacts secrets before persisting or publishing events and messages", async () => {
      const directory = mkdtempSync(join(tmpdir(), "orquest-d03-secrets-"));
      tempDirectories.push(directory);
      const database = new OrquestDatabase(join(directory, "orquest.db"));
      const runner = new FakeAgyRunner({
        stepDelayMs: 5,
        steps: [
          {
            id: "private-step",
            kind: "job.message",
            privateReasoning: true,
            textDelta: "Private chain of thought with secret_token=hidden-999",
          },
          {
            id: "public-step",
            kind: "job.message",
            messageKey: "turn-response",
            thought: "Internal reasoning note that must never be persisted",
            textDelta: "Diagnóstico con Authorization: Bearer secret-worker-jwt y api_key=sk-abcdef1234567890",
            payload: {
              accessToken: "raw-access-token-value",
              reasoning_delta: "Hidden reasoning delta",
            },
          },
        ],
        finalSummary: "Diagnóstico con Authorization: Bearer secret-worker-jwt y api_key=sk-abcdef1234567890",
      });
      const service = new JobService(database, runner, 1);
      const published: DashboardEvent[] = [];
      const unsubscribe = service.subscribe((event) => published.push(event));

      const submitted = service.submit({
        ...jobInput(directory),
        task: "Inspect using Authorization: Bearer secret-user-jwt and password=topsecretpassword",
      });
      const completed = await waitForCompletion(service, submitted.id);

      const messages = database.queryTaskMessages(completed.taskSessionId!).items;
      expect(messages).toHaveLength(2);
      const serializedMessages = JSON.stringify(messages);
      const serializedEvents = JSON.stringify(service.getEvents(completed.id, 0, 50));
      const serializedPublished = JSON.stringify(published);

      for (const blob of [serializedMessages, serializedEvents, serializedPublished, JSON.stringify(completed.result)]) {
        expect(blob).not.toContain("secret-user-jwt");
        expect(blob).not.toContain("topsecretpassword");
        expect(blob).not.toContain("secret-worker-jwt");
        expect(blob).not.toContain("sk-abcdef1234567890");
        expect(blob).not.toContain("raw-access-token-value");
        expect(blob).not.toContain("hidden-999");
        expect(blob).not.toContain("Private chain of thought");
        expect(blob).not.toContain("Internal reasoning note");
        expect(blob).not.toContain("Hidden reasoning delta");
      }

      expect(messages[0]?.content).toContain("Authorization: Bearer [REDACTED]");
      expect(messages[0]?.content).toContain("password=[REDACTED]");
      expect(messages[1]?.content).toContain("Authorization: Bearer [REDACTED]");
      expect(messages[1]?.content).toContain("api_key=[REDACTED]");

      unsubscribe();
      service.close();
      database.close();
    });
  });
});
