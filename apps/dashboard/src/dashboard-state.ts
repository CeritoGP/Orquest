import type { JobEvent, JobRecord } from "@orquest/contracts";

function updatedAtMs(job: JobRecord): number {
  const parsed = Date.parse(job.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function reconcileJobs(current: readonly JobRecord[], snapshot: readonly JobRecord[]): JobRecord[] {
  const currentById = new Map(current.map((job) => [job.id, job]));
  const includedIds = new Set<string>();
  const reconciled = snapshot.map((snapshotJob) => {
    includedIds.add(snapshotJob.id);
    const currentJob = currentById.get(snapshotJob.id);
    return currentJob !== undefined && updatedAtMs(currentJob) >= updatedAtMs(snapshotJob)
      ? currentJob
      : snapshotJob;
  });

  for (const currentJob of current) {
    if (!includedIds.has(currentJob.id)) reconciled.push(currentJob);
  }
  return reconciled;
}

export function sameEventSeries(left: readonly JobEvent[], right: readonly JobEvent[]): boolean {
  return left.length === right.length
    && left.every((event, index) => event.id === right[index]?.id && event.sequence === right[index]?.sequence);
}
