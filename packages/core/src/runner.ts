import type { JobResult, JobRecord } from "@orquest/contracts";

export interface RunnerEvent {
  /** Stable identifier supplied by a runner when it can replay an event. */
  id?: string;
  kind: "job.progress" | "job.tool" | "job.message";
  message: string;
  payload?: Record<string, unknown>;
}

export interface JobRunner {
  execute(job: JobRecord, emit: (event: RunnerEvent) => void, signal: AbortSignal): Promise<JobResult>;
}