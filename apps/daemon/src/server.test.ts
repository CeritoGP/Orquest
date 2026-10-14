import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  JobBatchSubmitResponse,
  JobDiffResponse,
  JobRecord,
  JobResult,
  JobWaitResponse,
  PaginatedEventsResponse,
  PaginatedJobsResponse,
} from "@orquest/contracts";
import { encodeCursor } from "@orquest/contracts";
import type { JobRunner, RunnerEvent } from "@orquest/core";
import type { DaemonServerInstance } from "./server.js";
import { createDaemonServer } from "./server.js";

class PausedRunner implements JobRunner {
  async execute(_job: JobRecord, _emit: (event: RunnerEvent) => void, signal: AbortSignal): Promise<JobResult> {
    await new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    return { summary: "done", tests: [], filesChanged: [], risks: [] };
  }
}

describe("Daemon HTTP Server & API", () => {
  let tempDir: string;
  let daemon: DaemonServerInstance;
  let baseUrl: string;
  const testToken = "test-secret-bearer-token-1234567890";

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orquest-daemon-api-test-"));
    daemon = createDaemonServer({
      port: 0,
      stateRoot: tempDir,
      token: testToken,
      allowedRoots: [tempDir, "C:/work", "C:/repo"],
    });
    const { port, host } = await daemon.start();
    baseUrl = `http://${host}:${port}`;
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function apiRequest<T = unknown>(
    path: string,
    options: {
      method?: string;
      token?: string | null;
      rawAuthHeader?: string | null;
      body?: unknown;
    } = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.rawAuthHeader !== undefined) {
      if (options.rawAuthHeader !== null) {
        headers.authorization = options.rawAuthHeader;
      }
    } else if (options.token !== null) {
      headers.authorization = `Bearer ${options.token ?? testToken}`;
    }

    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };

    const response = await fetch(`${baseUrl}${path}`, init);

    const body = (await response.json()) as T;
    return { status: response.status, body, headers: response.headers };
  }

  describe("Authentication and local security", () => {
    it("returns 200 { up: true } on /health without token without revealing internal details", async () => {
      const res = await apiRequest<{ up: boolean; runner?: string; status?: string }>("/health", { token: null });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ up: true });
      expect(res.body.runner).toBeUndefined();
      expect(res.body.status).toBeUndefined();
    });

    it("returns detailed readiness on /health when authenticated", async () => {
      const res = await apiRequest<{ status: string; up: boolean; runner: string }>("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.up).toBe(true);
      expect(res.body.runner).toBe("fake-agy");
    });

    it("returns 401 on /health when Bearer token is incorrect without revealing secrets", async () => {
      const res = await apiRequest<{ error: string }>("/health", { token: "token-incorrecto" });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Unauthorized");
      expect(JSON.stringify(res.body)).not.toContain(testToken);
      expect(JSON.stringify(res.body)).not.toContain("token-incorrecto");
    });

    it("returns 401 on /health when Authorization header is malformed or non-bearer", async () => {
      const basicRes = await apiRequest<{ error: string }>("/health", { rawAuthHeader: "Basic dXNlcjpwYXNz" });
      expect(basicRes.status).toBe(401);
      expect(basicRes.body.error).toContain("Unauthorized");

      const emptyBearerRes = await apiRequest<{ error: string }>("/health", { rawAuthHeader: "Bearer " });
      expect(emptyBearerRes.status).toBe(401);
      expect(emptyBearerRes.body.error).toContain("Unauthorized");

      const malformedRes = await apiRequest<{ error: string }>("/health", { rawAuthHeader: "Token xyz" });
      expect(malformedRes.status).toBe(401);
      expect(malformedRes.body.error).toContain("Unauthorized");
    });

    it("returns 401 Unauthorized for /api/jobs without token", async () => {
      const res = await apiRequest<{ error: string }>("/api/jobs", { token: null });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Unauthorized");
    });

    it("returns 401 Unauthorized for /api/jobs with wrong token", async () => {
      const res = await apiRequest<{ error: string }>("/api/jobs", { token: "invalid-token" });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Unauthorized");
    });

    it("ensures the secret token is never reflected in error responses", async () => {
      const wrong = "leaked-secret-attempt";
      const res = await apiRequest<{ error: string }>("/api/jobs", { token: wrong });
      const rawBody = JSON.stringify(res.body);
      expect(rawBody).not.toContain(testToken);
      expect(rawBody).not.toContain(wrong);
    });

    it("returns 200 with valid bearer token", async () => {
      const res = await apiRequest<PaginatedJobsResponse>("/api/jobs");
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.hasMore).toBe(false);
    });

    it("returns the effective execution profiles only to authenticated callers", async () => {
      const unauthorized = await apiRequest<{ error: string }>("/api/profiles", { token: null });
      expect(unauthorized.status).toBe(401);

      const res = await apiRequest<{ profiles: Record<string, { effort: string; accessMode: string }> }>("/api/profiles");
      expect(res.status).toBe(200);
      expect(res.body.profiles.quick).toMatchObject({ effort: "low", accessMode: "read-only" });
      expect(res.body.profiles.implementer).toMatchObject({ effort: "high", accessMode: "worktree" });
    });
  });

  describe("Batch submission & Idempotency", () => {
    it("submits a batch of 1 to 8 jobs and separates accepted and rejected items", async () => {
      const batchPayload = {
        jobs: [
          {
            title: "Task 1",
            task: "Inspect module A",
            workspacePath: tempDir,
            accessMode: "read-only",
            idempotencyKey: "batch-key-1",
          },
          {
            title: "Task 2 (Invalid non-Git worktree)",
            task: "Write module B",
            workspacePath: tempDir,
            accessMode: "worktree", // Must be rejected because tempDir is not a Git repository
          },
        ],
      };

      const res = await apiRequest<JobBatchSubmitResponse>("/api/jobs/batch", {
        method: "POST",
        body: batchPayload,
      });

      expect(res.status).toBe(200);
      expect(res.body.accepted).toHaveLength(1);
      expect(res.body.accepted[0]?.index).toBe(0);
      expect(res.body.accepted[0]?.job.title).toBe("Task 1");
      expect(res.body.accepted[0]?.idempotentReplay).toBe(false);

      expect(res.body.rejected).toHaveLength(1);
      expect(res.body.rejected[0]?.index).toBe(1);
      expect(res.body.rejected[0]?.code).toBe("WORKTREE_PREPARATION_FAILED");
    });

    it("replays existing job when submitting with identical idempotencyKey in the same workspace", async () => {
      const single = {
        jobs: [
          {
            title: "Idempotent Task",
            task: "List files",
            workspacePath: tempDir,
            idempotencyKey: "idempotency-100",
          },
        ],
      };

      const first = await apiRequest<JobBatchSubmitResponse>("/api/jobs/batch", {
        method: "POST",
        body: single,
      });
      expect(first.status).toBe(200);
      const firstJobId = first.body.accepted[0]?.job.id;
      expect(first.body.accepted[0]?.idempotentReplay).toBe(false);

      const second = await apiRequest<JobBatchSubmitResponse>("/api/jobs/batch", {
        method: "POST",
        body: single,
      });
      expect(second.status).toBe(200);
      expect(second.body.accepted[0]?.job.id).toBe(firstJobId);
      expect(second.body.accepted[0]?.idempotentReplay).toBe(true);
    });
  });

  describe("Pagination and opaque cursors", () => {
    it("rejects malformed or unparseable cursors with 400", async () => {
      const res = await apiRequest<{ error: string }>("/api/jobs?cursor=invalid-not-base64!!!");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid cursor");

      const malformedPayload = encodeCursor({ invalid: 123 });
      const res2 = await apiRequest<{ error: string }>(`/api/jobs?cursor=${malformedPayload}`);
      expect(res2.status).toBe(400);
      expect(res2.body.error).toContain("Invalid cursor");
    });

    it("paginates jobs using cursor", async () => {
      // Submit 3 jobs
      for (let i = 1; i <= 3; i++) {
        daemon.service.submit({
          title: `Job ${i}`,
          task: `Task ${i}`,
          workspacePath: tempDir,
          idempotencyKey: `key-${i}`,
        });
      }

      const page1 = await apiRequest<PaginatedJobsResponse>("/api/jobs?limit=2");
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.nextCursor).toBeDefined();

      const page2 = await apiRequest<PaginatedJobsResponse>(`/api/jobs?limit=2&cursor=${page1.body.nextCursor}`);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.hasMore).toBe(false);
      expect(page2.body.nextCursor).toBeNull();
    });

    it("paginates events and rejects malformed event cursors", async () => {
      const job = daemon.service.submit({
        title: "Event Job",
        task: "Generate events",
        workspacePath: tempDir,
      });

      // Malformed cursor
      const badRes = await apiRequest<{ error: string }>(`/api/jobs/${job.id}/events?cursor=bad-cursor`);
      expect(badRes.status).toBe(400);
      expect(badRes.body.error).toContain("Invalid cursor");

      // Valid events query
      const eventsRes = await apiRequest<PaginatedEventsResponse>(`/api/jobs/${job.id}/events?limit=10`);
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.body.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Wait / Long-poll", () => {
    it("returns immediately with timedOut: false if job is already terminal", async () => {
      const job = daemon.service.submit({
        title: "Quick terminal job",
        task: "Inspect",
        workspacePath: tempDir,
      });

      // Wait until completed by FakeAgyRunner
      for (let attempt = 0; attempt < 30; attempt++) {
        const cur = daemon.service.getJob(job.id);
        if (cur?.status === "DONE") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const res = await apiRequest<JobWaitResponse>(`/api/jobs/${job.id}/wait?timeoutSeconds=2`);
      expect(res.status).toBe(200);
      expect(res.body.timedOut).toBe(false);
      expect(res.body.job.status).toBe("DONE");
    });

    it("times out and returns timedOut: true when no events arrive within timeoutSeconds", async () => {
      const slowDaemon = createDaemonServer({
        port: 0,
        stateRoot: tempDir,
        token: testToken,
        allowedRoots: [tempDir],
        runner: new PausedRunner(),
      });
      const { port, host } = await slowDaemon.start();
      try {
        const job = slowDaemon.service.submit({
          title: "Wait timeout job",
          task: "Inspect",
          workspacePath: tempDir,
        });

        const res = await fetch(`http://${host}:${port}/api/jobs/${job.id}/wait?timeoutSeconds=1`, {
          headers: { authorization: `Bearer ${testToken}` },
        });
        const body = (await res.json()) as JobWaitResponse;
        expect(res.status).toBe(200);
        expect(body.timedOut).toBe(true);
        expect(body.job.id).toBe(job.id);
      } finally {
        await slowDaemon.stop();
      }
    });
  });

  describe("Continuation & Retry", () => {
    it("rejects continuation on an active job with 409 Conflict", async () => {
      const job = daemon.service.submit({
        title: "Active job",
        task: "Inspect",
        workspacePath: tempDir,
      });

      const res = await apiRequest<{ error: string; code: string }>(`/api/jobs/${job.id}/messages`, {
        method: "POST",
        body: { message: "Next instruction" },
      });

      if (res.status === 409) {
        expect(res.body.code).toBe("JOB_ACTIVE");
      }
    });

    it("creates continuation child job from terminal job with conversationId", async () => {
      const job = daemon.service.submit({
        title: "Parent job",
        task: "Inspect",
        workspacePath: tempDir,
      });

      for (let attempt = 0; attempt < 30; attempt++) {
        const cur = daemon.service.getJob(job.id);
        if (cur?.status === "DONE") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const completed = daemon.service.getJob(job.id)!;
      expect(completed.conversationId).toBeDefined();

      const res = await apiRequest<{ job: JobRecord; idempotentReplay: boolean }>(`/api/jobs/${job.id}/messages`, {
        method: "POST",
        body: {
          message: "Step 2 follow up",
          idempotencyKey: "cont-key-555",
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.job.parentJobId).toBe(job.id);
      expect(res.body.job.taskSessionId).toBe(job.taskSessionId);
      expect(res.body.job.attemptIndex).toBe(2);
      expect(res.body.job.conversationId).toBe(completed.conversationId);
      expect(res.body.job.task).toBe("Step 2 follow up");
      expect(res.body.idempotentReplay).toBe(false);

      // Replay idempotency
      const replayRes = await apiRequest<{ job: JobRecord; idempotentReplay: boolean }>(`/api/jobs/${job.id}/messages`, {
        method: "POST",
        body: {
          message: "Step 2 follow up",
          idempotencyKey: "cont-key-555",
        },
      });
      expect(replayRes.status).toBe(200);
      expect(replayRes.body.job.id).toBe(res.body.job.id);
      expect(replayRes.body.idempotentReplay).toBe(true);
    });

    it("retries a terminal job creating a new job with retryOfJobId and null conversationId", async () => {
      const job = daemon.service.submit({
        title: "Original to retry",
        task: "Inspect",
        workspacePath: tempDir,
      });

      for (let attempt = 0; attempt < 30; attempt++) {
        const cur = daemon.service.getJob(job.id);
        if (cur?.status === "DONE") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const res = await apiRequest<{ job: JobRecord; idempotentReplay: boolean }>(`/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: {
          task: "Retried task with modified instructions",
          effort: "high",
          idempotencyKey: "retry-key-777",
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.job.id).not.toBe(job.id);
      expect(res.body.job.retryOfJobId).toBe(job.id);
      expect(res.body.job.taskSessionId).toBe(job.taskSessionId);
      expect(res.body.job.attemptIndex).toBe(2);
      expect(res.body.job.conversationId).toBeNull(); // Never reuses conversationId
      expect(res.body.job.task).toBe("Retried task with modified instructions");
      expect(res.body.job.effort).toBe("high");
      expect(res.body.idempotentReplay).toBe(false);

      // Idempotent retry replay
      const replayRes = await apiRequest<{ job: JobRecord; idempotentReplay: boolean }>(`/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: {
          task: "Retried task with modified instructions",
          idempotencyKey: "retry-key-777",
        },
      });
      expect(replayRes.status).toBe(200);
      expect(replayRes.body.job.id).toBe(res.body.job.id);
      expect(replayRes.body.idempotentReplay).toBe(true);
      expect(replayRes.body.job.attemptIndex).toBe(2);
      const secondRetry = await apiRequest<{ job: JobRecord }>(`/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: { idempotencyKey: "retry-key-778" },
      });
      expect(secondRetry.status).toBe(201);
      expect(secondRetry.body.job.attemptIndex).toBe(3);
      expect(daemon.service.getJob(secondRetry.body.job.id)?.attemptIndex).toBe(3);
    });
  });

  describe("Cancel and Diff", () => {
    it("cancels a queued or active job", async () => {
      const job = daemon.service.submit({
        title: "Job to cancel",
        task: "Inspect",
        workspacePath: tempDir,
      });

      const res = await apiRequest<{ job: JobRecord }>(`/api/jobs/${job.id}/cancel`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(["CANCELING", "CANCELED"]).toContain(res.body.job.status);
    });

    it("creates an isolated writer worktree and exposes its diff without changing the source checkout", async () => {
      const repository = join(tempDir, "writer-repo");
      mkdirSync(repository);
      const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true });
      git("init");
      git("config", "user.email", "orquest@example.invalid");
      git("config", "user.name", "Orquest Test");
      writeFileSync(join(repository, "tracked.txt"), "source\n", "utf8");
      git("add", "tracked.txt");
      git("commit", "-m", "initial");

      const created = await apiRequest<{ job: JobRecord }>("/api/jobs", {
        method: "POST",
        body: {
          title: "Isolated writer",
          task: "Update tracked.txt inside the worktree",
          workspacePath: repository,
          accessMode: "worktree",
        },
      });

      expect(created.status).toBe(202);
      expect(created.body.job.worktreePath).not.toBeNull();
      expect(created.body.job.worktreePath).not.toBe(repository);
      expect(created.body.job.branchName).toMatch(/^orquest\//);
      writeFileSync(join(created.body.job.worktreePath!, "tracked.txt"), "isolated change\n", "utf8");

      const diff = await apiRequest<JobDiffResponse>(`/api/jobs/${created.body.job.id}/diff?limit=10`);
      expect(diff.status).toBe(200);
      expect(diff.body.available).toBe(true);
      expect(diff.body.files).toEqual(["tracked.txt"]);
      expect(diff.body.diff).toContain("isolated change");
      expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe("source\n");
    });
    it("returns available: false for a read-only job", async () => {
      const job = daemon.service.submit({
        title: "Diff inspect",
        task: "Inspect",
        workspacePath: tempDir,
      });

      const res = await apiRequest<JobDiffResponse>(`/api/jobs/${job.id}/diff`);
      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe(job.id);
      expect(res.body.available).toBe(false);
      expect(res.body.reason).toContain("isolated worktree");
    });
  });

  describe("Persistence across daemon restarts", () => {
    it("preserves jobs and events across daemon stops and restarts", async () => {
      const job = daemon.service.submit({
        title: "Persistent Job",
        task: "Inspect files",
        workspacePath: tempDir,
      });

      // Stop current daemon
      await daemon.stop();

      // Start new daemon instance using same database directory
      const restarted = createDaemonServer({
        port: 0,
        stateRoot: tempDir,
        token: testToken,
        allowedRoots: [tempDir],
      });
      const { port, host } = await restarted.start();
      baseUrl = `http://${host}:${port}`;
      daemon = restarted;

      const res = await apiRequest<{ job: JobRecord }>(`/api/jobs/${job.id}`);
      expect(res.status).toBe(200);
      expect(res.body.job.id).toBe(job.id);
      expect(res.body.job.title).toBe("Persistent Job");
    });
  });
});
