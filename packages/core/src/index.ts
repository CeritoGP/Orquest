import { randomUUID } from "node:crypto";
import type { Effort, JobErrorCode, JobInput, JobRecord, JobResult, JobStatus } from "@orquest/contracts";
import { JobInputSchema, terminalJobStatuses } from "@orquest/contracts";
export { RunnerError } from "./errors.js";
export { isSameOrSubpath, validateWorkspacePath } from "./path.js";
export { WorktreeManager, type WorktreeInfo } from "./worktree.js";
export { parseVerificationCommand, runVerificationCommand } from "./verification.js";
export { defaultExecutionProfiles, loadExecutionProfiles, type ExecutionProfile, type ExecutionProfiles } from "./profiles.js";

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  TRIAGE: ["TODO", "CANCELED"],
  TODO: ["READY", "CANCELED"],
  READY: ["QUEUED", "BLOCKED", "CANCELED"],
  QUEUED: ["RUNNING", "BLOCKED", "CANCELED"],
  RUNNING: ["VERIFYING", "CANCELING", "BLOCKED", "FAILED", "CANCELED"],
  VERIFYING: ["DONE", "CANCELING", "FAILED", "BLOCKED", "CANCELED"],
  CANCELING: ["CANCELED", "FAILED"],
  BLOCKED: ["READY", "CANCELED"],
  DONE: [],
  FAILED: ["READY", "CANCELED"],
  CANCELED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job status transition: ${from} -> ${to}`);
  }
}

function executionProfileSnapshot(config: {
  profileId: string;
  model: string;
  effort: Effort;
  accessMode: JobRecord["accessMode"];
  agent?: string | undefined;
  verificationCommands: string[];
  profileSnapshot?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    ...structuredClone(config.profileSnapshot ?? {}),
    profileId: config.profileId,
    model: config.model,
    effort: config.effort,
    accessMode: config.accessMode,
    agent: config.agent ?? null,
    verificationCommands: [...config.verificationCommands],
  };
}

export function createJob(rawInput: JobInput, now = new Date()): JobRecord {
  const input = JobInputSchema.parse(rawInput);
  const timestamp = now.toISOString();
  return {
    ...input,
    id: randomUUID(),
    status: "READY",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    stoppedAt: null,
    taskSessionId: randomUUID(),
    attemptIndex: 1,
    conversationId: input.conversationId ?? null,
    parentJobId: input.parentJobId ?? null,
    retryOfJobId: input.retryOfJobId ?? null,
    worktreePath: null,
    branchName: null,
    baseCommit: null,
    idempotencyKey: input.idempotencyKey,
    errorCode: null,
    result: null,
    errorMessage: null,
    effectiveModel: null,
    effectiveEffort: null,
    executionMetadataSource: "unknown",
    orchestrator: null,
    profileSnapshot: executionProfileSnapshot(input),
  };
}

export function createContinuationJob(
  parentJob: JobRecord,
  message: string,
  options?: {
    idempotencyKey?: string;
    now?: Date;
  },
): JobRecord {
  if (!terminalJobStatuses.has(parentJob.status)) {
    throw new Error(`Cannot continue a non-terminal job (current status: ${parentJob.status})`);
  }
  if (!parentJob.conversationId || parentJob.conversationId.trim() === "") {
    throw new Error(`Cannot continue job ${parentJob.id}: missing conversationId`);
  }

  const now = options?.now ?? new Date();
  const timestamp = now.toISOString();

  return {
    id: randomUUID(),
    title: `Continue: ${parentJob.title}`.slice(0, 160),
    task: message,
    workspacePath: parentJob.workspacePath,
    profileId: parentJob.profileId,
    agent: parentJob.agent,
    accessMode: parentJob.accessMode,
    model: parentJob.model,
    effort: parentJob.effort,
    acceptanceCriteria: [...parentJob.acceptanceCriteria],
    verificationCommands: [...parentJob.verificationCommands],
    priority: parentJob.priority,
    idempotencyKey: options?.idempotencyKey,
    conversationId: parentJob.conversationId,
    parentJobId: parentJob.id,
    retryOfJobId: null,
    dependsOnJobIds: [],
    reviewOfJobId: parentJob.reviewOfJobId ?? null,
    worktreePath: parentJob.worktreePath,
    branchName: parentJob.branchName,
    baseCommit: parentJob.baseCommit,
    status: "READY",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    stoppedAt: null,
    taskSessionId: parentJob.taskSessionId ?? parentJob.id,
    // This is a draft; persistence allocates the session-wide index atomically.
    attemptIndex: 1,
    errorCode: null,
    result: null,
    errorMessage: null,
    effectiveModel: null,
    effectiveEffort: null,
    executionMetadataSource: "unknown",
    orchestrator: null,
    profileSnapshot: executionProfileSnapshot(parentJob),
  };
}

export function createRetryJob(
  originalJob: JobRecord,
  overrides?: {
    task?: string;
    model?: string;
    effort?: Effort;
    idempotencyKey?: string;
    verificationCommands?: string[];
    now?: Date;
  },
): JobRecord {
  if (!terminalJobStatuses.has(originalJob.status) && originalJob.status !== "BLOCKED") {
    throw new Error(`Cannot retry a running or active job (current status: ${originalJob.status})`);
  }

  const now = overrides?.now ?? new Date();
  const timestamp = now.toISOString();

  return {
    id: randomUUID(),
    title: originalJob.title,
    task: overrides?.task ?? originalJob.task,
    workspacePath: originalJob.workspacePath,
    profileId: originalJob.profileId,
    agent: originalJob.agent,
    accessMode: originalJob.accessMode,
    model: overrides?.model ?? originalJob.model,
    effort: overrides?.effort ?? originalJob.effort,
    acceptanceCriteria: [...originalJob.acceptanceCriteria],
    verificationCommands: overrides?.verificationCommands ? [...overrides.verificationCommands] : [...originalJob.verificationCommands],
    priority: originalJob.priority,
    idempotencyKey: overrides?.idempotencyKey,
    conversationId: null, // Critical: never reuse conversationId on retry
    parentJobId: originalJob.parentJobId ?? null,
    retryOfJobId: originalJob.id,
    dependsOnJobIds: [],
    reviewOfJobId: originalJob.reviewOfJobId ?? null,
    worktreePath: null,
    branchName: null,
    baseCommit: null,
    status: "READY",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    stoppedAt: null,
    taskSessionId: originalJob.taskSessionId ?? originalJob.id,
    // Multiple retries of the same ancestor must not derive their final index
    // from it. The database assigns the number when the draft is saved.
    attemptIndex: 1,
    errorCode: null,
    result: null,
    errorMessage: null,
    effectiveModel: null,
    effectiveEffort: null,
    executionMetadataSource: "unknown",
    orchestrator: null,
    profileSnapshot: executionProfileSnapshot({
      ...originalJob,
      model: overrides?.model ?? originalJob.model,
      effort: overrides?.effort ?? originalJob.effort,
      verificationCommands: overrides?.verificationCommands ?? originalJob.verificationCommands,
    }),
  };
}

export function transitionJob(job: JobRecord, status: JobStatus, now = new Date()): JobRecord {
  assertTransition(job.status, status);
  const timestamp = now.toISOString();
  return {
    ...job,
    status,
    updatedAt: timestamp,
    startedAt: status === "RUNNING" && job.startedAt === null ? timestamp : job.startedAt,
    finishedAt: terminalJobStatuses.has(status) ? timestamp : job.finishedAt,
    stoppedAt: terminalJobStatuses.has(status) || status === "BLOCKED"
      ? timestamp
      : status === "RUNNING"
        ? null
        : job.stoppedAt,
  };
}

export function completeJob(job: JobRecord, result: JobResult, now = new Date()): JobRecord {
  const verifying = job.status === "RUNNING" ? transitionJob(job, "VERIFYING", now) : job;
  const done = transitionJob(verifying, "DONE", now);
  return {
    ...done,
    result,
    conversationId: result.conversationId ?? job.conversationId,
    errorMessage: null,
    errorCode: null,
  };
}

export function failJob(job: JobRecord, errorMessage: string, errorCode: JobErrorCode = "UNKNOWN_FAILURE", now = new Date()): JobRecord {
  return { ...transitionJob(job, "FAILED", now), errorMessage, errorCode };
}

export function blockJob(job: JobRecord, errorCode: JobErrorCode, errorMessage: string, now = new Date()): JobRecord {
  return { ...transitionJob(job, "BLOCKED", now), errorCode, errorMessage };
}

export function requestCancelJob(job: JobRecord, now = new Date()): JobRecord {
  return { ...transitionJob(job, "CANCELING", now), errorMessage: "Cancellation requested" };
}

export function cancelJob(job: JobRecord, now = new Date()): JobRecord {
  return { ...transitionJob(job, "CANCELED", now), errorMessage: "Canceled by user" };
}

export type { JobRunner, RunnerEvent } from "./runner.js";
