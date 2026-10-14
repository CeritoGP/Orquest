import { describe, expect, it } from "vitest";
import type { JobRecord } from "@orquest/contracts";
import { reconcileJobs } from "./dashboard-state.js";

function job(id: string, status: JobRecord["status"], updatedAt: string): JobRecord {
  return { id, status, updatedAt } as JobRecord;
}

describe("dashboard state reconciliation", () => {
  it("keeps a newer SSE state when an older REST snapshot arrives", () => {
    const doneFromSse = job("job-1", "DONE", "2026-10-06T14:00:02.000Z");
    const oldSnapshot = job("job-1", "RUNNING", "2026-10-06T14:00:01.000Z");

    expect(reconcileJobs([doneFromSse], [oldSnapshot])).toEqual([doneFromSse]);
  });

  it("retains an SSE job that did not exist when the REST request began", () => {
    const fromSse = job("job-created-after-request", "QUEUED", "2026-10-06T14:00:02.000Z");
    const snapshotJob = job("job-older", "RUNNING", "2026-10-06T14:00:01.000Z");

    expect(reconcileJobs([fromSse], [snapshotJob])).toEqual([snapshotJob, fromSse]);
  });
});
