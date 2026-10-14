import { describe, expect, it } from "vitest";
import {
  blockJob,
  cancelJob,
  completeJob,
  createContinuationJob,
  createJob,
  createRetryJob,
  failJob,
  transitionJob,
} from "./index.js";

describe("job state machine and invariants", () => {
  const input = {
    title: "Inspect repository",
    task: "List relevant files.",
    workspacePath: "C:/repo",
    profileId: "quick",
    accessMode: "read-only" as const,
    model: "auto",
    effort: "medium" as const,
    acceptanceCriteria: ["All files listed"],
    verificationCommands: ["npm.cmd test"],
    priority: 50,
  };

  it("moves a job to a terminal done state through verification", () => {
    const ready = createJob(input, new Date("2026-01-01T00:00:00.000Z"));
    const queued = transitionJob(ready, "QUEUED");
    const running = transitionJob(queued, "RUNNING");
    const done = completeJob(running, { summary: "Complete", tests: [], filesChanged: [], risks: [] });

    expect(done.status).toBe("DONE");
    expect(done.finishedAt).not.toBeNull();
  });

  it("freezes elapsed execution when a running job becomes blocked", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const startedAt = new Date("2026-01-01T00:00:05.000Z");
    const stoppedAt = new Date("2026-01-01T00:00:10.000Z");
    const ready = createJob(input, createdAt);
    const running = transitionJob(transitionJob(ready, "QUEUED", createdAt), "RUNNING", startedAt);
    const blocked = blockJob(running, "AUTH_REQUIRED", "Please login", stoppedAt);

    expect(blocked.finishedAt).toBeNull();
    expect(blocked.stoppedAt).toBe(stoppedAt.toISOString());
  });

  it("rejects invalid transitions", () => {
    const ready = createJob(input);
    expect(() => transitionJob(ready, "DONE")).toThrow("Invalid job status transition");
  });

  describe("createContinuationJob", () => {
    it("creates a child job inheriting configuration and conversationId from terminal parent", () => {
      const ready = createJob(input);
      const queued = transitionJob(ready, "QUEUED");
      const running = transitionJob(queued, "RUNNING");
      const done = completeJob(running, {
        summary: "Analyzed code",
        tests: [],
        filesChanged: [],
        risks: [],
        conversationId: "agy-conv-uuid-1234",
      });

      const child = createContinuationJob(done, "Now suggest refactoring opportunities", {
        idempotencyKey: "cont-key-1",
      });

      expect(child.id).toBeDefined();
      expect(child.id).not.toBe(done.id);
      expect(child.taskSessionId).toBe(done.taskSessionId);
      expect(child.attemptIndex).toBe(1); // Draft, allocated by persistence.
      expect(child.parentJobId).toBe(done.id);
      expect(child.retryOfJobId).toBeNull();
      expect(child.conversationId).toBe("agy-conv-uuid-1234");
      expect(child.workspacePath).toBe(done.workspacePath);
      expect(child.profileId).toBe(done.profileId);
      expect(child.model).toBe(done.model);
      expect(child.effort).toBe(done.effort);
      expect(child.accessMode).toBe(done.accessMode);
      expect(child.task).toBe("Now suggest refactoring opportunities");
      expect(child.status).toBe("READY");
      expect(child.idempotencyKey).toBe("cont-key-1");
    });

    it("rejects continuation if parent is not terminal", () => {
      const ready = createJob({ ...input, conversationId: "conv-1" });
      const running = transitionJob(transitionJob(ready, "QUEUED"), "RUNNING");

      expect(() => createContinuationJob(running, "Follow-up message")).toThrow(
        "Cannot continue a non-terminal job (current status: RUNNING)",
      );
    });

    it("rejects continuation if parent has no conversationId", () => {
      const ready = createJob(input);
      const queued = transitionJob(ready, "QUEUED");
      const running = transitionJob(queued, "RUNNING");
      const done = completeJob(running, { summary: "Done without conv id", tests: [], filesChanged: [], risks: [] });

      expect(() => createContinuationJob(done, "Follow-up")).toThrow("missing conversationId");
    });
  });

  describe("createRetryJob", () => {
    it("creates a new retry job with retryOfJobId and DOES NOT reuse conversationId", () => {
      const ready = createJob({ ...input, conversationId: "conv-old" });
      const queued = transitionJob(ready, "QUEUED");
      const running = transitionJob(queued, "RUNNING");
      const failed = failJob(running, "Worker timed out", "PRINT_TIMEOUT");

      const retry = createRetryJob(failed, {
        task: "Retry with simpler task",
        model: "pro",
        effort: "high",
        idempotencyKey: "retry-key-99",
      });

      expect(retry.id).toBeDefined();
      expect(retry.id).not.toBe(failed.id);
      expect(retry.retryOfJobId).toBe(failed.id);
      expect(retry.taskSessionId).toBe(failed.taskSessionId);
      expect(retry.attemptIndex).toBe(1); // Draft, allocated by persistence.
      expect(retry.parentJobId).toBeNull();
      expect(retry.conversationId).toBeNull(); // Must be null: fresh conversation!
      expect(retry.task).toBe("Retry with simpler task");
      expect(retry.model).toBe("pro");
      expect(retry.effort).toBe("high");
      expect(retry.status).toBe("READY");
      expect(retry.idempotencyKey).toBe("retry-key-99");
    });

    it("allows retry on CANCELED and BLOCKED jobs", () => {
      const ready = createJob(input);
      const canceled = cancelJob(ready);
      const retryCanceled = createRetryJob(canceled);
      expect(retryCanceled.retryOfJobId).toBe(canceled.id);

      const ready2 = createJob(input);
      const blocked = blockJob(transitionJob(ready2, "QUEUED"), "AUTH_REQUIRED", "Please login");
      const retryBlocked = createRetryJob(blocked);
      expect(retryBlocked.retryOfJobId).toBe(blocked.id);
    });

    it("rejects retry on active jobs", () => {
      const ready = createJob(input);
      const queued = transitionJob(ready, "QUEUED");
      expect(() => createRetryJob(queued)).toThrow("Cannot retry a running or active job");
    });
  });

  it("starts follow-up attempts with unknown orchestrator and independent effective profile snapshots", () => {
    const root = createJob(input);
    root.status = "DONE";
    root.conversationId = "old-conversation";
    root.orchestrator = { provider: "codex", model: "previous-model", effort: "high", source: "client" };
    root.profileSnapshot = { model: "auto", effort: "medium", custom: { tags: ["original"] } };
    const continuation = createContinuationJob(root, "Continue the work");
    const retry = createRetryJob(root, { model: "new-model", effort: "low", verificationCommands: ["npm.cmd run lint"] });

    expect(continuation.orchestrator).toBeNull();
    expect(retry.orchestrator).toBeNull();
    expect(root.orchestrator.model).toBe("previous-model");
    expect(retry.profileSnapshot).toMatchObject({
      model: "new-model", effort: "low", verificationCommands: ["npm.cmd run lint"],
    });
    expect(continuation.profileSnapshot).toMatchObject({ model: "auto", effort: "medium" });
    const custom = retry.profileSnapshot?.custom as { tags: string[] };
    custom.tags.push("retry-only");
    expect(root.profileSnapshot.custom).toEqual({ tags: ["original"] });
    expect(root.profileSnapshot.model).toBe("auto");
    expect(root.profileSnapshot.effort).toBe("medium");
  });
});
