import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  JobBatchSubmitInputSchema,
  JobBatchSubmitResponseSchema,
  ContractErrorResponseSchema,
  JobDiffResponseSchema,
  JobInputSchema,
  JobListQuerySchema,
  JobRecordSchema,
  JobRetryInputSchema,
  JobSendMessageInputSchema,
  JobSnapshotSchema,
  JobStatusSchema,
  JobWaitQuerySchema,
  JobWaitResponseSchema,
  OrchestratorTurnContextInputSchema,
  OrchestratorTurnContextSchema,
  TaskContinuationInputSchema,
  TaskMessageAttemptDispatchSchema,
  TaskMessageSchema,
  TaskMessageCursorSchema,
  TaskAttemptCursorSchema,
  TaskRetryInputSchema,
  TaskSessionSchema,
  terminalJobStatuses,
  toJobSnapshot,
} from "./index.js";

describe("job contracts", () => {
  it("applies safe defaults to a job submission", () => {
    const result = JobInputSchema.parse({
      title: "Inspect repository",
      task: "List the files and summarize their role.",
      workspacePath: "C:/work/project",
    });

    expect(result.accessMode).toBe("read-only");
    expect(result.effort).toBe("medium");
    expect(result.profileId).toBe("quick");
    expect(result.priority).toBe(50);
  });

  it("keeps terminal statuses explicit", () => {
    expect(terminalJobStatuses.has(JobStatusSchema.enum.DONE)).toBe(true);
    expect(terminalJobStatuses.has(JobStatusSchema.enum.FAILED)).toBe(true);
    expect(terminalJobStatuses.has(JobStatusSchema.enum.CANCELED)).toBe(true);
    expect(terminalJobStatuses.has(JobStatusSchema.enum.RUNNING)).toBe(false);
    expect(terminalJobStatuses.has(JobStatusSchema.enum.QUEUED)).toBe(false);
  });

  describe("opaque cursors and pagination", () => {
    it("encodes and decodes opaque cursors symmetrically", () => {
      const payload = { u: "2026-09-28T12:00:00.000Z", id: "550e8400-e29b-41d4-a716-446655440000" };
      const cursor = encodeCursor(payload);
      expect(typeof cursor).toBe("string");
      expect(cursor).not.toContain("2026-09-28"); // opaque string

      const decoded = decodeCursor<typeof payload>(cursor);
      expect(decoded).toEqual(payload);
    });

    it("returns null for malformed or invalid cursors", () => {
      expect(decodeCursor("not-valid-base64url-json!!!")).toBeNull();
      expect(decodeCursor("")).toBeNull();
    });

    it("parses job list filters and limit coercion", () => {
      const parsed = JobListQuerySchema.parse({
        limit: "15",
        status: "RUNNING",
        workspace: "C:/my-repo",
        profile: "reviewer",
      });

      expect(parsed.limit).toBe(15);
      expect(parsed.status).toBe("RUNNING");
      expect(parsed.workspace).toBe("C:/my-repo");
      expect(parsed.profile).toBe("reviewer");
    });
  });

  describe("batch submission schemas", () => {
    it("accepts valid batch of 1 to 8 jobs", () => {
      const single = JobBatchSubmitInputSchema.parse({
        jobs: [
          {
            title: "Task 1",
            task: "Inspect component A",
            workspacePath: "C:/work/repo",
            idempotencyKey: "key-1",
          },
        ],
      });
      expect(single.jobs).toHaveLength(1);

      const eight = JobBatchSubmitInputSchema.parse({
        jobs: Array.from({ length: 8 }, (_, i) => ({
          title: `Task ${i + 1}`,
          task: `Inspect component ${i + 1}`,
          workspacePath: "C:/work/repo",
          idempotencyKey: `key-${i + 1}`,
        })),
      });
      expect(eight.jobs).toHaveLength(8);
    });

    it("rejects empty batch or batch exceeding 8 jobs", () => {
      expect(() => JobBatchSubmitInputSchema.parse({ jobs: [] })).toThrow();
      expect(() =>
        JobBatchSubmitInputSchema.parse({
          jobs: Array.from({ length: 9 }, (_, i) => ({
            title: `Task ${i + 1}`,
            task: `Inspect component ${i + 1}`,
            workspacePath: "C:/work/repo",
          })),
        }),
      ).toThrow();
    });

    it("validates partial success in batch responses", () => {
      const batchResponse = JobBatchSubmitResponseSchema.parse({
        accepted: [
          {
            index: 0,
            job: {
              id: "550e8400-e29b-41d4-a716-446655440000",
              title: "Job 1",
              task: "Do something",
              workspacePath: "C:/repo",
              profileId: "quick",
              accessMode: "read-only",
              model: "auto",
              effort: "medium",
              acceptanceCriteria: [],
              verificationCommands: [],
              priority: 50,
              status: "READY",
              createdAt: "2026-09-28T10:00:00.000Z",
              updatedAt: "2026-09-28T10:00:00.000Z",
              startedAt: null,
              finishedAt: null,
              conversationId: null,
              parentJobId: null,
              retryOfJobId: null,
              errorCode: null,
              result: null,
              errorMessage: null,
            },
            idempotentReplay: false,
          },
        ],
        rejected: [
          {
            index: 1,
            error: "Title too short",
            code: "VALIDATION_ERROR",
          },
        ],
      });

      expect(batchResponse.accepted).toHaveLength(1);
      expect(batchResponse.rejected).toHaveLength(1);
      expect(batchResponse.rejected[0]?.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("continuation, retry, wait and diff schemas", () => {
    it("validates continuation message inputs", () => {
      const continuation = JobSendMessageInputSchema.parse({
        message: "Now proceed to test the implementation.",
        idempotencyKey: "msg-123",
      });
      expect(continuation.message).toBe("Now proceed to test the implementation.");
      expect(continuation.idempotencyKey).toBe("msg-123");
    });

    it("validates retry inputs with optional overrides", () => {
      const retry = JobRetryInputSchema.parse({
        task: "Updated retry instructions",
        model: "pro",
        effort: "high",
        idempotencyKey: "retry-key-1",
      });
      expect(retry.task).toBe("Updated retry instructions");
      expect(retry.effort).toBe("high");
    });

    it("validates wait query and long-poll response", () => {
      const query = JobWaitQuerySchema.parse({
        after: "5",
        timeoutSeconds: "45",
      });
      expect(query.after).toBe(5);
      expect(query.timeoutSeconds).toBe(45);

      const response = JobWaitResponseSchema.parse({
        job: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          title: "Wait Job",
          task: "Task",
          workspacePath: "C:/repo",
          profileId: "quick",
          accessMode: "read-only",
          model: "auto",
          effort: "medium",
          acceptanceCriteria: [],
          verificationCommands: [],
          priority: 50,
          status: "DONE",
          createdAt: "2026-09-28T10:00:00.000Z",
          updatedAt: "2026-09-28T10:01:00.000Z",
          startedAt: "2026-09-28T10:00:05.000Z",
          finishedAt: "2026-09-28T10:01:00.000Z",
          conversationId: "conv-1",
          errorCode: null,
          result: { summary: "Done", tests: [], filesChanged: [], risks: [] },
          errorMessage: null,
        },
        timedOut: false,
        latestEventSequence: 12,
      });
      expect(response.timedOut).toBe(false);
      expect(response.latestEventSequence).toBe(12);
    });

    it("validates diff response structure with available: false for phase 3", () => {
      const diffResp = JobDiffResponseSchema.parse({
        jobId: "550e8400-e29b-41d4-a716-446655440000",
        available: false,
        reason: "Diff inspection requires worktree execution available in Phase 4",
      });
      expect(diffResp.available).toBe(false);
      expect(diffResp.files).toEqual([]);
    });
  });

  describe("task continuity contracts", () => {
    const taskSessionId = "550e8400-e29b-41d4-a716-446655440000";
    const attemptId = "550e8400-e29b-41d4-a716-446655440001";
    const messageId = "550e8400-e29b-41d4-a716-446655440002";

    it("accepts an immutable queued-message dispatch relation", () => {
      const message = TaskMessageSchema.parse({
        id: messageId,
        taskSessionId,
        jobId: null,
        role: "user",
        deliveryStatus: "pending",
        source: "client",
        recipient: "worker",
        intent: "queue",
        target: { kind: "next-attempt", afterJobId: attemptId },
        content: "Run the requested checks when the current attempt finishes.",
        createdAt: "2026-10-13T10:00:00.000Z",
        updatedAt: "2026-10-13T10:00:00.000Z",
      });
      expect(message.providerIdentity).toBeUndefined();
      expect(message.target?.kind).toBe("next-attempt");

      expect(TaskMessageAttemptDispatchSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440003",
        taskSessionId,
        taskMessageId: messageId,
        attemptJobId: "550e8400-e29b-41d4-a716-446655440004",
        createdAt: "2026-10-13T10:01:00.000Z",
      }).attemptJobId).toBe("550e8400-e29b-41d4-a716-446655440004");
    });

    it("keeps historical messages readable without synthesizing new fields", () => {
      const message = TaskMessageSchema.parse({
        id: messageId,
        taskSessionId,
        jobId: attemptId,
        role: "assistant",
        deliveryStatus: "received",
        source: "runtime",
        content: "Legacy public response",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(message.recipient).toBeUndefined();
      expect(message.intent).toBeUndefined();
      expect(message.target).toBeUndefined();

      expect(TaskSessionSchema.parse({
        id: taskSessionId,
        rootJobId: attemptId,
        workspacePath: "C:/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }).id).toBe(taskSessionId);
    });

    it("does not accept client-declared runtime metadata or unverified effective data", () => {
      expect(() => OrchestratorTurnContextInputSchema.parse({
        provider: "codex",
        requestedModel: "auto",
        requestedSource: "runtime",
      })).toThrow();
      expect(() => OrchestratorTurnContextSchema.parse({
        provider: "agy",
        effectiveModel: "pro",
        effectiveSource: "client",
      })).toThrow();
      expect(OrchestratorTurnContextSchema.parse({
        provider: "agy",
        requestedModel: "auto",
        requestedSource: "configured",
        effectiveModel: "resolved-pro",
        effectiveSource: "runtime",
      }).effectiveModel).toBe("resolved-pro");
    });

    it("requires an idempotency key and selected attempt when requested", () => {
      expect(TaskContinuationInputSchema.parse({
        message: "Continue with the regression test.",
        idempotencyKey: "continue-1",
      }).target).toBe("next-attempt");
      expect(() => TaskContinuationInputSchema.parse({
        message: "Continue this attempt.",
        idempotencyKey: "continue-2",
        target: "attempt",
      })).toThrow();
      expect(() => TaskContinuationInputSchema.parse({ message: "Missing replay key" })).toThrow();
    });

    it("validates task-scoped retry overrides without changing the legacy retry input", () => {
      const retry = TaskRetryInputSchema.parse({
        fromAttemptId: attemptId,
        task: "Retry after reviewing the logs.",
        model: "pro",
        effort: "high",
        verificationCommands: ["npm.cmd test"],
        idempotencyKey: "task-retry-1",
        orchestratorContext: { provider: "codex", requestedModel: "auto", requestedSource: "client" },
      });
      expect(retry.fromAttemptId).toBe(attemptId);
      expect(retry.effort).toBe("high");
      expect(() => TaskRetryInputSchema.parse({ idempotencyKey: "task-retry-2", fromAttemptId: "not-a-uuid" })).toThrow();
      expect(() => TaskRetryInputSchema.parse({ task: "No replay key" })).toThrow();
      expect(() => TaskRetryInputSchema.parse({
        idempotencyKey: "task-retry-3",
        orchestratorContext: { requestedSource: "runtime" },
      })).toThrow();
      expect(JobRetryInputSchema.parse({ task: "Legacy retry" }).idempotencyKey).toBeUndefined();
    });

    it("binds opaque task cursors to task identity and direction", () => {
      expect(TaskAttemptCursorSchema.parse({
        taskSessionId,
        direction: "forward",
        attemptIndex: 2,
        jobId: attemptId,
      }).attemptIndex).toBe(2);
      expect(() => TaskMessageCursorSchema.parse({
        taskSessionId,
        direction: "backward",
        createdAt: "not-a-timestamp",
        messageId,
      })).toThrow();
    });

    it("keeps machine-readable contract errors bounded", () => {
      expect(ContractErrorResponseSchema.parse({
        code: "IDEMPOTENCY_CONFLICT",
        message: "The key was already used with different content.",
      }).details).toEqual({});
    });
  });

  describe("legacy data rehydration and snapshots", () => {
    it("rehydrates legacy JobRecord JSON without parentJobId or retryOfJobId safely", () => {
      const legacyJson = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        title: "Legacy Phase 2 Job",
        task: "Old task",
        workspacePath: "C:/work/repo",
        profileId: "quick",
        accessMode: "read-only",
        model: "auto",
        effort: "medium",
        acceptanceCriteria: [],
        verificationCommands: [],
        priority: 50,
        status: "DONE",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        startedAt: "2026-01-01T00:00:05.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        conversationId: "legacy-conv-1",
        errorCode: null,
        result: { summary: "Success", tests: [], filesChanged: [], risks: [] },
        errorMessage: null,
      };

      const parsed = JobRecordSchema.parse(legacyJson);
      expect(parsed.parentJobId ?? null).toBeNull();
      expect(parsed.retryOfJobId ?? null).toBeNull();
      expect(parsed.idempotencyKey).toBeUndefined();

      const snapshot = toJobSnapshot(parsed);
      expect(JobSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      expect(snapshot.summary).toBe("Success");
      expect(snapshot.parentJobId).toBeNull();
      expect(snapshot.retryOfJobId).toBeNull();
    });
  });
});
