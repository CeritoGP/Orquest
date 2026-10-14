import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEventDraft, JobInput, JobRecord, TaskMessage } from "@orquest/contracts";
import { encodeCursor } from "@orquest/contracts";
import { createJob, createRetryJob } from "@orquest/core";
import { OrquestDatabase } from "./index.js";

describe("OrquestDatabase (persistence & phase 3)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: OrquestDatabase;

  const baseInput: JobInput = {
    title: "Inspect repository",
    task: "List all files in src directory.",
    workspacePath: "C:/projects/demo",
    profileId: "quick",
    accessMode: "read-only",
    model: "auto",
    effort: "medium",
    acceptanceCriteria: [],
    verificationCommands: [],
    priority: 50,
  };

  function messageFor(job: JobRecord, extra: Partial<TaskMessage> = {}): TaskMessage {
    return {
      id: "00000000-0000-4000-8000-000000000101",
      taskSessionId: job.taskSessionId!,
      jobId: job.id,
      role: "user",
      deliveryStatus: "pending",
      source: "client",
      content: "Follow-up instruction",
      createdAt: "2026-10-07T12:00:00.000Z",
      updatedAt: "2026-10-07T12:00:00.000Z",
      ...extra,
    };
  }

  function eventFor(jobId: string, id: string): JobEventDraft {
    return {
      id,
      jobId,
      timestamp: "2026-10-13T12:00:00.000Z",
      kind: "job.created",
      source: "user",
      message: "Persisted task mutation",
      payload: {},
      deduplicationKey: null,
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orquest-persistence-test-"));
    dbPath = join(tempDir, "test.db");
    db = new OrquestDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("idempotency and relationship links", () => {
    it("keeps explicit continuation and retry attempts in the root task session", () => {
      const root = createJob(baseInput);
      const continuation = createJob({
        ...baseInput,
        title: "Continuation attempt",
        parentJobId: root.id,
      });
      const retry = createJob({
        ...baseInput,
        title: "Retry attempt",
        retryOfJobId: root.id,
      });
      // Ordinary linked drafts must be grouped without manually fixing fields.
      db.saveJob(root);
      db.saveJob(continuation);
      db.saveJob(retry);

      const stored = db.listJobsByTaskSessionId(root.taskSessionId!);
      expect(stored.map((job) => job.id).sort()).toEqual([root.id, continuation.id, retry.id].sort());
      expect(db.queryJobs({ taskSessionId: root.taskSessionId!, limit: 10 }).items).toHaveLength(3);
      expect(stored.map((job) => job.attemptIndex).sort()).toEqual([1, 2, 3]);
    });

    it("allocates sibling retries across connections and preserves indices on updates and restart", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE" });
      const firstDraft = createRetryJob(root);
      const secondDraft = createRetryJob(root);
      const otherConnection = new OrquestDatabase(dbPath);
      let second: JobRecord;
      try {
        const first = db.saveJob(firstDraft);
        second = otherConnection.saveJob(secondDraft);
        expect([first.attemptIndex, second.attemptIndex]).toEqual([2, 3]);
        // A later status update from the draft cannot renumber the saved job.
        const updated = otherConnection.saveJob({ ...secondDraft, status: "QUEUED" });
        expect(updated.attemptIndex).toBe(3);
      } finally {
        otherConnection.close();
      }
      db.close();
      db = new OrquestDatabase(dbPath);
      expect(db.getJob(second.id)?.attemptIndex).toBe(3);
      expect(db.listJobsByTaskSessionId(root.taskSessionId!).map((job) => job.attemptIndex).sort()).toEqual([1, 2, 3]);
    });

    it("rejects changing the task or workspace of a saved job", () => {
      const original = db.saveJob(createJob(baseInput));
      const other = db.saveJob(createJob(baseInput));
      expect(() => db.saveJob({ ...original, taskSessionId: other.taskSessionId })).toThrow("task session");
      expect(() => db.saveJob({ ...original, workspacePath: "C:/different" })).toThrow("workspace");
      expect(() => db.saveJob(createJob({ ...baseInput, workspacePath: "C:/different", parentJobId: original.id })))
        .toThrow("across workspaces");
      expect(db.getJob(original.id)?.taskSessionId).toBe(original.taskSessionId);
    });

    it("persists and finds a job by idempotencyKey within workspace scope", () => {
      const job1 = createJob({
        ...baseInput,
        workspacePath: "C:/repo/a",
        idempotencyKey: "submit-batch-key-1",
      });
      const job2 = createJob({
        ...baseInput,
        workspacePath: "C:/repo/b",
        idempotencyKey: "submit-batch-key-1",
      });

      db.saveJob(job1);
      db.saveJob(job2);

      const foundA = db.findJobByIdempotencyKey("submit-batch-key-1", "C:/repo/a");
      expect(foundA?.id).toBe(job1.id);

      const foundB = db.findJobByIdempotencyKey("submit-batch-key-1", "C:/repo/b");
      expect(foundB?.id).toBe(job2.id);

      const notFound = db.findJobByIdempotencyKey("submit-batch-key-1", "C:/repo/c");
      expect(notFound).toBeNull();
    });

    it("persists and queries parentJobId and retryOfJobId links", () => {
      const parent = createJob(baseInput);
      db.saveJob(parent);

      const child1 = createJob({
        ...baseInput,
        title: "Child continuation 1",
        parentJobId: parent.id,
      });
      const child2 = createJob({
        ...baseInput,
        title: "Child continuation 2",
        parentJobId: parent.id,
      });
      const retryJob = createJob({
        ...baseInput,
        title: "Retry of parent",
        retryOfJobId: parent.id,
      });

      db.saveJob(child1);
      db.saveJob(child2);
      db.saveJob(retryJob);

      const children = db.listJobsByParentId(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id).sort()).toEqual([child1.id, child2.id].sort());

      const retries = db.listJobsByRetryOfId(parent.id);
      expect(retries).toHaveLength(1);
      expect(retries[0]?.id).toBe(retryJob.id);
    });
  });

  describe("dependency links", () => {
    it("persists dependency indexes across a database restart", () => {
      const prerequisite = createJob({ ...baseInput, title: "Prerequisite job" });
      const dependent = createJob({
        ...baseInput,
        title: "Dependent job",
        dependsOnJobIds: [prerequisite.id],
      });
      db.saveJob(prerequisite);
      db.saveJob(dependent);
      expect(db.listDependentJobs(prerequisite.id).map((job) => job.id)).toEqual([dependent.id]);

      db.close();
      db = new OrquestDatabase(dbPath);
      expect(db.getJob(dependent.id)?.dependsOnJobIds).toEqual([prerequisite.id]);
      expect(db.listDependentJobs(prerequisite.id).map((job) => job.id)).toEqual([dependent.id]);
    });
  });
  describe("paginated job queries and filters", () => {
    it("paginates jobs with opaque cursor and respects filters", () => {
      // Insert 5 jobs with distinct timestamps
      const jobs: JobRecord[] = [];
      for (let i = 1; i <= 5; i++) {
        const job = createJob(
          {
            ...baseInput,
            title: `Job ${i}`,
            workspacePath: i <= 3 ? "C:/repo/alpha" : "C:/repo/beta",
            profileId: i % 2 === 0 ? "reviewer" : "quick",
          },
          new Date(`2026-09-28T10:0${i}:00.000Z`),
        );
        db.saveJob(job);
        jobs.push(job);
      }

      // Query page 1 (limit = 2)
      const page1 = db.queryJobs({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();
      expect(page1.items[0]?.title).toBe("Job 5");
      expect(page1.items[1]?.title).toBe("Job 4");

      // Query page 2 with nextCursor
      const page2 = db.queryJobs({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(2);
      expect(page2.hasMore).toBe(true);
      expect(page2.items[0]?.title).toBe("Job 3");
      expect(page2.items[1]?.title).toBe("Job 2");

      // Query page 3
      const page3 = db.queryJobs({ limit: 2, cursor: page2.nextCursor! });
      expect(page3.items).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
      expect(page3.items[0]?.title).toBe("Job 1");

      // Query with workspace filter
      const filtered = db.queryJobs({ workspace: "C:/repo/alpha", limit: 10 });
      expect(filtered.items).toHaveLength(3);
      expect(filtered.items.every((j) => j.workspacePath === "C:/repo/alpha")).toBe(true);

      // Query with profile filter
      const reviewerFiltered = db.queryJobs({ profile: "reviewer", limit: 10 });
      expect(reviewerFiltered.items).toHaveLength(2);
      expect(reviewerFiltered.items.every((j) => j.profileId === "reviewer")).toBe(true);
    });
  });

  describe("paginated event queries", () => {
    it("paginates events across pages with opaque cursor", () => {
      const job = createJob(baseInput);
      db.saveJob(job);

      for (let i = 1; i <= 5; i++) {
        db.appendEvent({
          id: `550e8400-e29b-41d4-a716-44665544000${i}`,
          jobId: job.id,
          timestamp: `2026-09-28T10:00:0${i}.000Z`,
          kind: "job.progress",
          source: "daemon",
          message: `Progress step ${i}`,
          payload: { step: i },
          deduplicationKey: null,
        });
      }

      // Page 1
      const page1 = db.listEventsPaginated(job.id, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.items[0]?.sequence).toBe(1);
      expect(page1.items[1]?.sequence).toBe(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Page 2
      const page2 = db.listEventsPaginated(job.id, { limit: 2, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(2);
      expect(page2.items[0]?.sequence).toBe(3);
      expect(page2.items[1]?.sequence).toBe(4);
      expect(page2.hasMore).toBe(true);

      // Page 3
      const page3 = db.listEventsPaginated(job.id, { limit: 2, cursor: page2.nextCursor! });
      expect(page3.items).toHaveLength(1);
      expect(page3.items[0]?.sequence).toBe(5);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
    });

    it("returns the latest events first when paging backward while preserving chronological display order", () => {
      const job = createJob(baseInput);
      db.saveJob(job);

      for (let i = 1; i <= 5; i++) {
        db.appendEvent({
          id: `660e8400-e29b-41d4-a716-44665544000${i}`,
          jobId: job.id,
          timestamp: `2026-09-28T10:00:0${i}.000Z`,
          kind: "job.progress",
          source: "daemon",
          message: `Progress step ${i}`,
          payload: { step: i },
          deduplicationKey: null,
        });
      }

      const latest = db.listEventsPaginated(job.id, { limit: 2, direction: "backward" });
      expect(latest.items.map((event) => event.sequence)).toEqual([4, 5]);
      expect(latest.hasMore).toBe(true);

      const older = db.listEventsPaginated(job.id, {
        limit: 2,
        direction: "backward",
        cursor: latest.nextCursor!,
      });
      expect(older.items.map((event) => event.sequence)).toEqual([2, 3]);
      expect(older.hasMore).toBe(true);

      const oldest = db.listEventsPaginated(job.id, {
        limit: 2,
        direction: "backward",
        cursor: older.nextCursor!,
      });
      expect(oldest.items.map((event) => event.sequence)).toEqual([1]);
      expect(oldest.hasMore).toBe(false);
      expect(oldest.nextCursor).toBeNull();
    });
  });

  describe("task messages", () => {
    it("rejects messages pointing to another task's job or a nonexistent job", () => {
      const first = db.saveJob(createJob(baseInput));
      const other = db.saveJob(createJob(baseInput));
      expect(() => db.saveTaskMessage(messageFor(first, { jobId: other.id }))).toThrow("does not belong");
      expect(() => db.saveTaskMessage(messageFor(first, { jobId: "00000000-0000-4000-8000-000000000102" })))
        .toThrow("does not belong");
      expect(db.listTaskMessages(first.taskSessionId!).items).toEqual([]);
    });

    it("allows delivery/content updates but rejects moving messages or changing pagination identity", () => {
      const first = db.saveJob(createJob(baseInput));
      const other = db.saveJob(createJob(baseInput));
      const message = messageFor(first);
      db.saveTaskMessage(message);
      db.saveTaskMessage({ ...message, deliveryStatus: "sent", content: "Delivered", updatedAt: "2026-10-07T12:01:00.000Z" });
      expect(() => db.saveTaskMessage({ ...message, taskSessionId: other.taskSessionId!, jobId: other.id }))
        .toThrow("identity");
      expect(() => db.saveTaskMessage({ ...message, createdAt: "2026-10-07T12:02:00.000Z" })).toThrow("identity");
      expect(() => db.saveTaskMessage({ ...message, role: "assistant" })).toThrow("identity");
      expect(() => db.saveTaskMessage({ ...message, jobId: null })).toThrow("identity");
      expect(db.listTaskMessages(first.taskSessionId!).items[0]).toMatchObject({
        content: "Delivered", deliveryStatus: "sent", createdAt: message.createdAt,
      });
      expect(db.listTaskMessages(other.taskSessionId!).items).toEqual([]);
    });

    it("rolls back job, session and dependencies when a message collision fails after their insertion", () => {
      const original = db.saveJob(createJob(baseInput));
      const existingMessage = messageFor(original);
      db.saveTaskMessage(existingMessage);
      const newJob = createJob({ ...baseInput, dependsOnJobIds: [original.id] });
      const collidedMessage = messageFor(newJob, { id: existingMessage.id });

      expect(() => db.saveJobWithTaskMessage(newJob, collidedMessage)).toThrow("identity");
      expect(db.getJob(newJob.id)).toBeNull();
      expect(db.listDependentJobs(original.id)).toEqual([]);
      const inspector = new DatabaseSync(dbPath);
      try {
        expect(inspector.prepare("SELECT id FROM task_sessions WHERE id = ?").get(newJob.taskSessionId!)).toBeUndefined();
      } finally {
        inspector.close();
      }
      expect(db.listTaskMessages(original.taskSessionId!).items).toEqual([existingMessage]);
      expect(db.saveJobWithTaskMessage(newJob, { ...collidedMessage, id: "00000000-0000-4000-8000-000000000103" })
        .attemptIndex).toBe(1);
    });

    it("persists task messages atomically with a job and pages them in chronological order", () => {
      const job = createJob(baseInput);
      const first: TaskMessage = {
        id: "00000000-0000-4000-8000-000000000001",
        taskSessionId: job.taskSessionId!,
        jobId: job.id,
        role: "user",
        deliveryStatus: "sent",
        source: "client",
        content: "Inspect the project first.",
        createdAt: "2026-10-07T10:00:00.000Z",
        updatedAt: "2026-10-07T10:00:00.000Z",
      };
      db.saveJobWithTaskMessage(job, first);
      const second: TaskMessage = {
        ...first,
        id: "00000000-0000-4000-8000-000000000002",
        role: "assistant",
        deliveryStatus: "received",
        source: "runtime",
        content: "I am inspecting it.",
        createdAt: "2026-10-07T10:01:00.000Z",
        updatedAt: "2026-10-07T10:01:00.000Z",
      };
      const third: TaskMessage = {
        ...second,
        id: "00000000-0000-4000-8000-000000000003",
        content: "Inspection finished.",
        createdAt: "2026-10-07T10:02:00.000Z",
        updatedAt: "2026-10-07T10:02:00.000Z",
      };
      db.saveTaskMessage(second);
      db.saveTaskMessage(third);

      const firstPage = db.listTaskMessages(job.taskSessionId!, { limit: 2 });
      expect(firstPage.items.map((message) => message.content)).toEqual([first.content, second.content]);
      expect(firstPage.hasMore).toBe(true);
      const secondPage = db.listTaskMessages(job.taskSessionId!, { limit: 2, cursor: firstPage.nextCursor! });
      expect(secondPage.items.map((message) => message.content)).toEqual([third.content]);
      expect(secondPage.hasMore).toBe(false);
    });

    it("rejects an atomic job/message write when the message points at another task session", () => {
      const job = createJob(baseInput);
      const wrongSessionMessage: TaskMessage = {
        id: "00000000-0000-4000-8000-000000000004",
        taskSessionId: "00000000-0000-4000-8000-000000000005",
        jobId: job.id,
        role: "user",
        deliveryStatus: "pending",
        source: "client",
        content: "This must not be stored.",
        createdAt: "2026-10-07T10:00:00.000Z",
        updatedAt: "2026-10-07T10:00:00.000Z",
      };
      expect(() => db.saveJobWithTaskMessage(job, wrongSessionMessage)).toThrow("does not match");
      expect(db.getJob(job.id)).toBeNull();
    });

    it("prevents generic updates from retargeting metadata and enriches provider identity set-once", () => {
      const job = db.saveJob(createJob(baseInput));
      const message = messageFor(job, {
        recipient: "worker",
        intent: "continue",
        target: { kind: "attempt", jobId: job.id },
        orchestratorContext: null,
      });
      db.saveTaskMessage(message);
      expect(() => db.saveTaskMessage({ ...message, recipient: "orchestrator" })).toThrow("identity");
      expect(() => db.saveTaskMessage({ ...message, target: { kind: "next-attempt", afterJobId: job.id } })).toThrow("identity");

      const identity = { provider: "fake-agy", conversationId: "conversation-1", turnId: "turn-1", messageId: "message-1" };
      expect(db.enrichTaskMessageProviderIdentity(message.id, identity, "2026-10-13T12:01:00.000Z").providerIdentity)
        .toEqual(identity);
      expect(db.enrichTaskMessageProviderIdentity(message.id, identity, "2026-10-13T12:02:00.000Z").providerIdentity)
        .toEqual(identity);
      expect(() => db.enrichTaskMessageProviderIdentity(message.id, { ...identity, messageId: "other" }, "2026-10-13T12:03:00.000Z"))
        .toThrow("Cannot replace");
    });
  });

  describe("D02 task reads and mutations", () => {
    it("pages every attempt and message in both directions with task-bound cursors", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE" });
      const attempts = [root];
      for (let index = 0; index < 4; index += 1) attempts.push(db.saveJob(createRetryJob(root)));
      const other = db.saveJob(createJob({ ...baseInput, workspacePath: "C:/other" }));
      const messages = attempts.map((attempt, index) => messageFor(attempt, {
        id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
        content: `Message ${index + 1}`,
        createdAt: `2026-10-13T12:0${index}:00.000Z`,
        updatedAt: `2026-10-13T12:0${index}:00.000Z`,
      }));
      messages.forEach((message) => db.saveTaskMessage(message));

      const attemptForward = db.queryTaskAttempts(root.taskSessionId!, { limit: 2 });
      const attemptForwardNext = db.queryTaskAttempts(root.taskSessionId!, { limit: 2, cursor: attemptForward.nextCursor! });
      const attemptForwardLast = db.queryTaskAttempts(root.taskSessionId!, { limit: 2, cursor: attemptForwardNext.nextCursor! });
      expect([...attemptForward.items, ...attemptForwardNext.items, ...attemptForwardLast.items].map((job) => job.id)).toEqual(attempts.map((job) => job.id));
      const attemptBackward = db.queryTaskAttempts(root.taskSessionId!, { limit: 2, direction: "backward" });
      const attemptOlder = db.queryTaskAttempts(root.taskSessionId!, { limit: 2, direction: "backward", cursor: attemptBackward.nextCursor! });
      expect(attemptBackward.items.map((job) => job.attemptIndex)).toEqual([4, 5]);
      expect(attemptOlder.items.map((job) => job.attemptIndex)).toEqual([2, 3]);
      expect(() => db.queryTaskAttempts(other.taskSessionId!, { limit: 2, cursor: attemptForward.nextCursor! })).toThrow("does not match");
      expect(() => db.queryTaskAttempts(root.taskSessionId!, { limit: 2, direction: "backward", cursor: attemptForward.nextCursor! })).toThrow("does not match");

      const messageForward = db.queryTaskMessages(root.taskSessionId!, { limit: 2 });
      const messageForwardNext = db.queryTaskMessages(root.taskSessionId!, { limit: 2, cursor: messageForward.nextCursor! });
      const messageForwardLast = db.queryTaskMessages(root.taskSessionId!, { limit: 2, cursor: messageForwardNext.nextCursor! });
      expect([...messageForward.items, ...messageForwardNext.items, ...messageForwardLast.items].map((message) => message.id)).toEqual(messages.map((message) => message.id));
      const messageBackward = db.queryTaskMessages(root.taskSessionId!, { limit: 2, direction: "backward" });
      expect(messageBackward.items.map((message) => message.content)).toEqual(["Message 4", "Message 5"]);
      expect(() => db.queryTaskMessages(root.taskSessionId!, { limit: 2, cursor: "not-a-cursor" })).toThrow("Invalid cursor");

      const sessions = db.queryTaskSessions({ limit: 2 });
      expect(sessions.items).toHaveLength(2);
      expect(() => db.queryTaskSessions({ limit: 2, direction: "backward" })).toThrow("fixed forward order");
      expect(() => db.queryTaskSessions({ limit: 2, cursor: encodeCursor({ u: "not-a-date", id: "not-a-uuid" }) }))
        .toThrow("Invalid cursor");
    });

    it("persists and replays a task mutation atomically without cross-operation replay", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE" });
      const draft = createRetryJob(root);
      const request = { fromAttemptId: root.id, message: "Retry with focused checks" };
      const input = {
        taskSessionId: root.taskSessionId!,
        idempotencyKey: "task-mutation-key",
        operation: "retry" as const,
        request,
        job: draft,
        message: messageFor(draft, { id: "00000000-0000-4000-8000-000000000301" }),
        event: eventFor(draft.id, "00000000-0000-4000-8000-000000000302"),
      };
      const first = db.saveTaskMutation(input);
      const replay = db.saveTaskMutation({
        ...input,
        job: { ...draft, status: "QUEUED" },
        message: { ...input.message, content: "Ignored generated replay artifact" },
        event: { ...input.event, id: "00000000-0000-4000-8000-000000000303" },
      });
      expect(first.idempotentReplay).toBe(false);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.job).toEqual(first.job);
      expect(db.listJobsByTaskSessionId(root.taskSessionId!)).toHaveLength(2);
      expect(() => db.saveTaskMutation({ ...input, request: { ...request, message: "Different content" } })).toThrow("idempotency conflict");
      expect(() => db.saveTaskMutation({ ...input, operation: "continue" })).toThrow("idempotency conflict");
    });

    it("keeps task idempotency isolated from legacy workspace lookup", () => {
      const legacy = db.saveJob(createJob({ ...baseInput, idempotencyKey: "shared-key" }));
      const roots = [
        db.saveJob({ ...createJob({ ...baseInput, title: "Task one" }), status: "DONE" }),
        db.saveJob({ ...createJob({ ...baseInput, title: "Task two" }), status: "DONE" }),
      ];
      for (const [index, root] of roots.entries()) {
        const draft = createRetryJob(root);
        db.saveTaskMutation({
          taskSessionId: root.taskSessionId!,
          idempotencyKey: "shared-key",
          operation: "retry",
          request: { fromAttemptId: root.id },
          job: { ...draft, idempotencyKey: "shared-key" },
          message: messageFor(draft, { id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}` }),
          event: eventFor(draft.id, `00000000-0000-4000-8000-${String(710 + index).padStart(12, "0")}`),
        });
      }
      expect(db.findJobByIdempotencyKey("shared-key", baseInput.workspacePath)?.id).toBe(legacy.id);
      expect(roots.map((root) => db.listJobsByTaskSessionId(root.taskSessionId!).length)).toEqual([2, 2]);
    });

    it("stores an initial job, message, and event atomically without changing legacy key semantics", () => {
      const keyed = createJob({ ...baseInput, idempotencyKey: "initial-legacy-key" });
      const keyedMessage = messageFor(keyed, { id: "00000000-0000-4000-8000-000000000331" });
      const keyedResult = db.saveInitialJobWithTaskMessageAndEvent(
        keyed,
        keyedMessage,
        eventFor(keyed.id, "00000000-0000-4000-8000-000000000332"),
      );
      expect(keyedResult.event.sequence).toBe(1);
      expect(db.findJobByIdempotencyKey("initial-legacy-key", keyed.workspacePath)).toEqual(keyedResult.job);
      expect(db.listTaskMessages(keyed.taskSessionId!).items).toEqual([keyedMessage]);
      expect(() => db.saveInitialJobWithTaskMessageAndEvent(
        { ...keyedResult.job, status: "FAILED", errorMessage: "must not overwrite" },
        messageFor(keyedResult.job, { id: "00000000-0000-4000-8000-000000000342" }),
        eventFor(keyedResult.job.id, "00000000-0000-4000-8000-000000000343"),
      )).toThrow("requires a new attempt job id");
      expect(db.getJob(keyedResult.job.id)).toEqual(keyedResult.job);

      const withoutKey = createJob(baseInput);
      const withoutKeyResult = db.saveInitialJobWithTaskMessageAndEvent(
        withoutKey,
        messageFor(withoutKey, { id: "00000000-0000-4000-8000-000000000333" }),
        eventFor(withoutKey.id, "00000000-0000-4000-8000-000000000334"),
      );
      expect(withoutKeyResult.job.idempotencyKey).toBeUndefined();
      expect(db.findJobByIdempotencyKey("initial-legacy-key", withoutKey.workspacePath)?.id).toBe(keyed.id);

      const legacy = createJob(baseInput);
      expect(db.saveJobWithTaskMessage(legacy, messageFor(legacy, { id: "00000000-0000-4000-8000-000000000335" }))).toEqual(legacy);
      expect(db.listEvents(legacy.id)).toEqual([]);
    });

    it("rolls back an initial write after invalid or colliding events without consuming its attempt", () => {
      const prerequisite = db.saveJob(createJob(baseInput));
      const invalid = createJob({ ...baseInput, dependsOnJobIds: [prerequisite.id] });
      const invalidMessage = messageFor(invalid, { id: "00000000-0000-4000-8000-000000000336" });
      expect(() => db.saveInitialJobWithTaskMessageAndEvent(
        invalid,
        invalidMessage,
        { ...eventFor(invalid.id, "00000000-0000-4000-8000-000000000337"), timestamp: "not-a-date" },
      )).toThrow();
      expect(db.getJob(invalid.id)).toBeNull();
      expect(db.getTaskSession(invalid.taskSessionId!)).toBeNull();
      expect(db.listDependentJobs(prerequisite.id)).toEqual([]);
      expect(db.listTaskMessages(invalid.taskSessionId!).items).toEqual([]);

      const recovered = db.saveInitialJobWithTaskMessageAndEvent(
        invalid,
        invalidMessage,
        eventFor(invalid.id, "00000000-0000-4000-8000-000000000338"),
      );
      expect(recovered.job.attemptIndex).toBe(1);
      expect(db.listDependentJobs(prerequisite.id).map((job) => job.id)).toEqual([invalid.id]);

      const collisionId = "00000000-0000-4000-8000-000000000339";
      db.appendEvent(eventFor(prerequisite.id, collisionId));
      const collision = createJob({ ...baseInput, dependsOnJobIds: [prerequisite.id] });
      const collisionMessage = messageFor(collision, { id: "00000000-0000-4000-8000-000000000340" });
      expect(() => db.saveInitialJobWithTaskMessageAndEvent(
        collision,
        collisionMessage,
        eventFor(collision.id, collisionId),
      )).toThrow("event must not collide");
      expect(db.getJob(collision.id)).toBeNull();
      expect(db.getTaskSession(collision.taskSessionId!)).toBeNull();
      expect(db.listDependentJobs(prerequisite.id).map((job) => job.id)).toEqual([invalid.id]);
      expect(db.listTaskMessages(collision.taskSessionId!).items).toEqual([]);

      const collisionRecovered = db.saveInitialJobWithTaskMessageAndEvent(
        collision,
        collisionMessage,
        eventFor(collision.id, "00000000-0000-4000-8000-000000000341"),
      );
      expect(collisionRecovered.job.attemptIndex).toBe(1);
    });

    it("rejects an existing attempt before a new task mutation can overwrite it", () => {
      const legacyKey = "existing-attempt-key";
      const existing = db.saveJob({
        ...createJob({ ...baseInput, idempotencyKey: legacyKey }),
        profileSnapshot: { preserved: { source: "legacy" } },
      });
      const overwrite = {
        ...existing,
        status: "FAILED" as const,
        errorMessage: "must not overwrite this persisted attempt",
        profileSnapshot: { changed: true },
        idempotencyKey: undefined,
      };

      expect(() => db.saveTaskMutation({
        taskSessionId: existing.taskSessionId!,
        idempotencyKey: legacyKey,
        operation: "retry",
        request: { fromAttemptId: existing.id },
        job: overwrite,
        message: messageFor(overwrite, { id: "00000000-0000-4000-8000-000000000351" }),
        event: eventFor(overwrite.id, "00000000-0000-4000-8000-000000000352"),
      })).toThrow("requires a new attempt job id");

      expect(db.getJob(existing.id)).toEqual(existing);
      expect(db.findJobByIdempotencyKey(legacyKey, existing.workspacePath)).toEqual(existing);
      expect(db.listTaskMessages(existing.taskSessionId!).items).toEqual([]);
      expect(db.listEvents(existing.id)).toEqual([]);

      // Direct persistence fixtures can model the already-authorized retry
      // draft without changing the active persisted attempt above.
      const fresh = {
        ...createJob({ ...baseInput, retryOfJobId: existing.id }),
        taskSessionId: existing.taskSessionId,
      };
      const created = db.saveTaskMutation({
        taskSessionId: existing.taskSessionId!,
        idempotencyKey: legacyKey,
        operation: "retry",
        request: { fromAttemptId: existing.id },
        job: fresh,
        message: messageFor(fresh, { id: "00000000-0000-4000-8000-000000000353" }),
        event: eventFor(fresh.id, "00000000-0000-4000-8000-000000000354"),
      });
      expect(created.idempotentReplay).toBe(false);
      expect(db.findJobByIdempotencyKey(legacyKey, existing.workspacePath)).toEqual(existing);
    });

    it("rolls back job, message and idempotency reservation when the event collides", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE" });
      const collisionId = "00000000-0000-4000-8000-000000000401";
      db.appendEvent(eventFor(root.id, collisionId));
      const draft = createRetryJob(root);
      const message = messageFor(draft, { id: "00000000-0000-4000-8000-000000000402" });
      expect(() => db.saveTaskMutation({
        taskSessionId: root.taskSessionId!,
        idempotencyKey: "roll-back-key",
        operation: "retry",
        request: { fromAttemptId: root.id },
        job: draft,
        message,
        event: eventFor(draft.id, collisionId),
      })).toThrow("event must not collide");
      expect(db.getJob(draft.id)).toBeNull();
      expect(db.queryTaskMessages(root.taskSessionId!, { limit: 10 }).items.find((item) => item.id === message.id)).toBeUndefined();
      const recovered = db.saveTaskMutation({
        taskSessionId: root.taskSessionId!,
        idempotencyKey: "roll-back-key",
        operation: "retry",
        request: { fromAttemptId: root.id },
        job: draft,
        message,
        event: eventFor(draft.id, "00000000-0000-4000-8000-000000000403"),
      });
      expect(recovered.idempotentReplay).toBe(false);

      const invalidDraft = createRetryJob(root);
      const invalidMessage = messageFor(invalidDraft, { id: "00000000-0000-4000-8000-000000000404" });
      expect(() => db.saveTaskMutation({
        taskSessionId: root.taskSessionId!,
        idempotencyKey: "invalid-event-key",
        operation: "retry",
        request: { fromAttemptId: root.id, kind: "invalid-event" },
        job: invalidDraft,
        message: invalidMessage,
        event: { ...eventFor(invalidDraft.id, "00000000-0000-4000-8000-000000000405"), timestamp: "not-a-date" },
      })).toThrow();
      expect(db.getJob(invalidDraft.id)).toBeNull();
      expect(db.queryTaskMessages(root.taskSessionId!, { limit: 20 }).items.some((item) => item.id === invalidMessage.id)).toBe(false);
    });

    it("serializes competing task mutations and retains their idempotent response after restart", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE" });
      const firstDraft = createRetryJob(root);
      const secondDraft = createRetryJob(root);
      const input = {
        taskSessionId: root.taskSessionId!, idempotencyKey: "race-key", operation: "retry" as const,
        request: { fromAttemptId: root.id }, job: firstDraft,
        message: messageFor(firstDraft, { id: "00000000-0000-4000-8000-000000000501" }),
        event: eventFor(firstDraft.id, "00000000-0000-4000-8000-000000000502"),
      };
      const first = db.saveTaskMutation(input);
      const secondConnection = new OrquestDatabase(dbPath);
      try {
        const replay = secondConnection.saveTaskMutation({
          ...input,
          job: secondDraft,
          message: messageFor(secondDraft, { id: "00000000-0000-4000-8000-000000000503" }),
          event: eventFor(secondDraft.id, "00000000-0000-4000-8000-000000000504"),
        });
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.job.id).toBe(first.job.id);
      } finally {
        secondConnection.close();
      }
      db.close();
      db = new OrquestDatabase(dbPath);
      const replayAfterRestart = db.saveTaskMutation(input);
      expect(replayAfterRestart.idempotentReplay).toBe(true);
      expect(db.listJobsByTaskSessionId(root.taskSessionId!)).toHaveLength(2);
    });

    it("links a pending message to one attempt only after validating task membership", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE" });
      const pending = messageFor(root, { id: "00000000-0000-4000-8000-000000000601", jobId: null, target: { kind: "next-attempt", afterJobId: root.id } });
      db.saveTaskMessage(pending);
      const attempt = db.saveJob(createRetryJob(root));
      const dispatch = {
        id: "00000000-0000-4000-8000-000000000602",
        taskSessionId: root.taskSessionId!,
        taskMessageId: pending.id,
        attemptJobId: attempt.id,
        createdAt: "2026-10-13T12:00:00.000Z",
      };
      expect(db.saveTaskMessageAttemptDispatch(dispatch)).toEqual(dispatch);
      expect(db.getTaskMessageAttemptDispatch(pending.id)).toEqual(dispatch);
      expect(db.listTaskMessages(root.taskSessionId!).items[0]?.jobId).toBeNull();
      expect(() => db.saveTaskMessageAttemptDispatch({ ...dispatch, attemptJobId: root.id })).toThrow("different attempt dispatch");
      const foreign = db.saveJob(createJob({ ...baseInput, workspacePath: "C:/foreign" }));
      const anotherPending = messageFor(root, { id: "00000000-0000-4000-8000-000000000603", jobId: null });
      db.saveTaskMessage(anotherPending);
      expect(() => db.saveTaskMessageAttemptDispatch({ ...dispatch, id: "00000000-0000-4000-8000-000000000604", taskMessageId: anotherPending.id, attemptJobId: foreign.id }))
        .toThrow("does not belong");
    });
  });

  describe("legacy database migration and rehydration", () => {
    it("numbers a legacy root/continuation/retry chain without grouping reviews or dependencies", () => {
      const legacyPath = join(tempDir, "legacy-chain.db");
      const root = createJob(baseInput, new Date("2026-01-01T00:00:00.000Z"));
      const continuation = createJob({ ...baseInput, parentJobId: root.id }, new Date("2026-01-01T00:01:00.000Z"));
      const retry = createJob({ ...baseInput, parentJobId: root.id, retryOfJobId: continuation.id }, new Date("2026-01-01T00:02:00.000Z"));
      const review = createJob({ ...baseInput, reviewOfJobId: root.id, dependsOnJobIds: [root.id] });
      const legacyJobs = [retry, review, continuation, root];
      const raw = new DatabaseSync(legacyPath);
      raw.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL) STRICT;");
      for (const job of legacyJobs) {
        const legacy: Record<string, unknown> = { ...job };
        delete legacy.taskSessionId;
        delete legacy.attemptIndex;
        raw.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(job.id, job.status, job.updatedAt, JSON.stringify(legacy));
      }
      raw.close();
      let upgraded = new OrquestDatabase(legacyPath);
      try {
        expect([root, continuation, retry].map((job) => upgraded.getJob(job.id)?.attemptIndex)).toEqual([1, 2, 3]);
        expect([root, continuation, retry].map((job) => upgraded.getJob(job.id)?.taskSessionId)).toEqual([root.id, root.id, root.id]);
        expect(upgraded.getJob(review.id)?.taskSessionId).toBe(review.id);
        expect(upgraded.listDependentJobs(root.id).map((job) => job.id)).toEqual([review.id]);
        upgraded.close();
        upgraded = new OrquestDatabase(legacyPath);
        expect([root, continuation, retry].map((job) => upgraded.getJob(job.id)?.attemptIndex)).toEqual([1, 2, 3]);
      } finally {
        upgraded.close();
      }
    });

    it("repairs duplicate indices produced by P1a version 6 and keeps messages and results", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE", result: { summary: "Original result", tests: [], filesChanged: [], risks: [] } });
      const first = db.saveJob(createRetryJob(root));
      const second = db.saveJob(createRetryJob(root));
      const message = messageFor(first);
      db.saveTaskMessage(message);
      db.close();
      const raw = new DatabaseSync(dbPath);
      raw.exec("DROP INDEX jobs_by_task_attempt; DELETE FROM schema_migrations WHERE version = 7;");
      raw.prepare("UPDATE jobs SET attempt_index=1 WHERE task_session_id=?").run(root.taskSessionId!);
      raw.close();
      db = new OrquestDatabase(dbPath);
      const attempts = db.listJobsByTaskSessionId(root.taskSessionId!);
      expect(attempts.map((job) => job.attemptIndex).sort()).toEqual([1, 2, 3]);
      expect(db.getJob(root.id)?.result?.summary).toBe("Original result");
      expect(db.listTaskMessages(root.taskSessionId!).items).toEqual([message]);
      expect(attempts.map((job) => job.id).sort()).toEqual([root.id, first.id, second.id].sort());
    });

    it("preserves already unique attempt numbers when applying the repair migration", () => {
      const root = db.saveJob({ ...createJob(baseInput), status: "DONE" });
      const first = db.saveJob(createRetryJob(root, { now: new Date("2026-10-07T13:00:00.000Z") }));
      const second = db.saveJob(createRetryJob(root, { now: new Date("2026-10-07T12:00:00.000Z") }));
      db.close();
      const raw = new DatabaseSync(dbPath);
      raw.exec("DROP INDEX jobs_by_task_attempt; DELETE FROM schema_migrations WHERE version = 7;");
      raw.close();
      db = new OrquestDatabase(dbPath);
      // The clock went backward between retries; existing valid identities win
      // over sorting by creation time during a repair of unrelated sessions.
      expect(db.getJob(first.id)?.attemptIndex).toBe(2);
      expect(db.getJob(second.id)?.attemptIndex).toBe(3);
    });

    it("migrates a Phase 2 legacy database with older table schema and backfills columns", () => {
      db.close();

      // Recreate database with raw Phase 2 legacy schema (no idempotency_key, parent_job_id, retry_of_job_id columns)
      const rawDbPath = join(tempDir, "legacy.db");
      const rawDb = new DatabaseSync(rawDbPath);
      rawDb.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY) STRICT;
        INSERT INTO schema_migrations(version) VALUES (1);
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
      `);

      const legacyJobJson = {
        id: "11111111-2222-3333-4444-555555555555",
        title: "Legacy Stored Job",
        task: "Stored in Phase 2",
        workspacePath: "C:/legacy/repo",
        profileId: "quick",
        accessMode: "read-only",
        model: "auto",
        effort: "medium",
        acceptanceCriteria: [],
        verificationCommands: [],
        priority: 50,
        status: "DONE",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        finishedAt: "2026-01-01T00:05:00.000Z",
        conversationId: "legacy-conv-99",
        errorCode: null,
        result: { summary: "Legacy done", tests: [], filesChanged: [], risks: [] },
        errorMessage: null,
      };

      rawDb
        .prepare("INSERT INTO jobs(id, status, updated_at, payload) VALUES (?, ?, ?, ?)")
        .run(legacyJobJson.id, legacyJobJson.status, legacyJobJson.updatedAt, JSON.stringify(legacyJobJson));
      rawDb.close();

      // Now open with modern OrquestDatabase
      const upgradedDb = new OrquestDatabase(rawDbPath);
      try {
        const loaded = upgradedDb.getJob("11111111-2222-3333-4444-555555555555");
        expect(loaded).not.toBeNull();
        expect(loaded?.title).toBe("Legacy Stored Job");
        expect(loaded?.parentJobId ?? null).toBeNull();
        expect(loaded?.retryOfJobId ?? null).toBeNull();
        expect(loaded?.taskSessionId).toBe(legacyJobJson.id);
        expect(loaded?.attemptIndex).toBe(1);
        expect(loaded?.conversationId).toBe("legacy-conv-99");

        // Verify querying with workspace filter finds the legacy row
        const queried = upgradedDb.queryJobs({ workspace: "C:/legacy/repo" });
        expect(queried.items).toHaveLength(1);
        expect(queried.items[0]?.id).toBe(legacyJobJson.id);
        const inspector = new DatabaseSync(rawDbPath);
        try {
          expect(inspector.prepare("SELECT version FROM schema_migrations WHERE version = 9").get()).toBeDefined();
          expect(inspector.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_idempotency'").get()).toBeDefined();
          expect(inspector.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_message_attempt_dispatches'").get()).toBeDefined();
        } finally {
          inspector.close();
        }
      } finally {
        upgradedDb.close();
      }
    });
  });
});
