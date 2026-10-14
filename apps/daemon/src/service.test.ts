import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardEvent, JobInput, JobRecord, JobResult } from "@orquest/contracts";
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
    expect(completed.result?.tests).toContainEqual(expect.objectContaining({
      command: "git diff --check",
      status: "passed",
    }));
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
    const explicit = { ...jobInput(directory), profileId: "implementer", model: "custom-model", effort: "medium" as const, accessMode: "read-only" as const };

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
});
