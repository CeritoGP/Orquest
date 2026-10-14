import { z } from "zod";

export const JobStatusSchema = z.enum([
  "TRIAGE",
  "TODO",
  "READY",
  "QUEUED",
  "RUNNING",
  "VERIFYING",
  "CANCELING",
  "BLOCKED",
  "DONE",
  "FAILED",
  "CANCELED",
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const terminalJobStatuses = new Set<JobStatus>(["DONE", "FAILED", "CANCELED"]);

export const JobErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "QUOTA_EXCEEDED",
  "EXECUTABLE_NOT_FOUND",
  "PRINT_TIMEOUT",
  "CANCEL_TIMEOUT",
  "DEPENDENCY_FAILED",
  "UNKNOWN_FAILURE",
]);
export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>;

export const JobAccessModeSchema = z.enum(["read-only", "worktree"]);
export type JobAccessMode = z.infer<typeof JobAccessModeSchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

/** Where a displayed execution detail came from. Never present a configured
 * preference as if the runner had verified it. */
export const MetadataSourceSchema = z.enum(["runtime", "client", "configured", "unknown"]);
export type MetadataSource = z.infer<typeof MetadataSourceSchema>;

/** Sources a caller is allowed to declare. Runtime is reserved for data
 * observed by an adapter or another trusted execution boundary. */
export const DeclaredMetadataSourceSchema = z.enum(["client", "configured", "unknown"]);
export type DeclaredMetadataSource = z.infer<typeof DeclaredMetadataSourceSchema>;

export const OrchestratorMetadataSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(160).nullable().default(null),
  effort: EffortSchema.nullable().default(null),
  source: MetadataSourceSchema.default("unknown"),
}).nullable().default(null);
export type OrchestratorMetadata = z.infer<typeof OrchestratorMetadataSchema>;

/** Per-turn context, separate from the legacy compact metadata held by jobs. */
export const OrchestratorTurnContextSchema = z.object({
  provider: z.string().trim().min(1).max(80).nullable().default(null),
  requestedModel: z.string().trim().min(1).max(160).nullable().default(null),
  requestedEffort: EffortSchema.nullable().default(null),
  requestedSource: MetadataSourceSchema.default("unknown"),
  effectiveModel: z.string().trim().min(1).max(160).nullable().default(null),
  effectiveEffort: EffortSchema.nullable().default(null),
  effectiveSource: MetadataSourceSchema.default("unknown"),
}).superRefine((value, context) => {
  if ((value.effectiveModel !== null || value.effectiveEffort !== null) && value.effectiveSource !== "runtime") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Effective execution metadata must be runtime-verified" });
  }
});
export type OrchestratorTurnContext = z.infer<typeof OrchestratorTurnContextSchema>;

/** External callers cannot claim that effective provider data is runtime-verified. */
export const OrchestratorTurnContextInputSchema = z.object({
  provider: z.string().trim().min(1).max(80).nullable().default(null),
  requestedModel: z.string().trim().min(1).max(160).nullable().default(null),
  requestedEffort: EffortSchema.nullable().default(null),
  requestedSource: DeclaredMetadataSourceSchema.default("client"),
});
export type OrchestratorTurnContextInput = z.infer<typeof OrchestratorTurnContextInputSchema>;

export const JobInputSchema = z.object({
  title: z.string().trim().min(3).max(160),
  task: z.string().trim().min(3).max(20_000),
  workspacePath: z.string().trim().min(1).max(4096),
  profileId: z.string().trim().min(1).max(80).default("quick"),
  agent: z.string().trim().min(1).max(160).optional(),
  accessMode: JobAccessModeSchema.default("read-only"),
  model: z.string().trim().min(1).max(160).default("auto"),
  effort: EffortSchema.default("medium"),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  verificationCommands: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  dependsOnJobIds: z.array(z.string().uuid()).max(20).default([]),
  reviewOfJobId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  conversationId: z.string().trim().min(1).max(256).optional(),
  parentJobId: z.string().uuid().nullable().optional(),
  retryOfJobId: z.string().uuid().nullable().optional(),
});

export type JobInput = z.input<typeof JobInputSchema>;
export type JobInputOutput = z.infer<typeof JobInputSchema>;

export const JobEventKindSchema = z.enum([
  "job.created",
  "job.queued",
  "job.started",
  "job.progress",
  "job.tool",
  "job.message",
  "job.canceling",
  "job.completed",
  "job.failed",
  "job.canceled",
  "job.blocked",
]);

export type JobEventKind = z.infer<typeof JobEventKindSchema>;

export const JobEventSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  kind: JobEventKindSchema,
  source: z.enum(["daemon", "runner", "user"]),
  message: z.string().max(10_000),
  payload: z.record(z.string(), z.unknown()).default({}),
  deduplicationKey: z.string().min(1).max(256).nullable().default(null),
});

export type JobEvent = z.infer<typeof JobEventSchema>;
export type JobEventDraft = Omit<JobEvent, "sequence">;

export const JobResultSchema = z.object({
  summary: z.string().min(1).max(20_000),
  tests: z.array(z.object({ command: z.string(), status: z.enum(["passed", "failed", "skipped"]), output: z.string() })).default([]),
  filesChanged: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  conversationId: z.string().optional(),
});

export type JobResult = z.infer<typeof JobResultSchema>;

export const TaskMessageRoleSchema = z.enum(["user", "assistant", "orchestrator", "system", "tool"]);
export type TaskMessageRole = z.infer<typeof TaskMessageRoleSchema>;

export const TaskMessageRecipientSchema = z.enum(["worker", "orchestrator", "user", "system", "unknown"]);
export type TaskMessageRecipient = z.infer<typeof TaskMessageRecipientSchema>;

export const TaskMessageIntentSchema = z.enum(["initial", "continue", "queue", "response", "tool", "notice", "unknown"]);
export type TaskMessageIntent = z.infer<typeof TaskMessageIntentSchema>;

export const ProviderMessageIdentitySchema = z.object({
  provider: z.string().trim().min(1).max(80),
  conversationId: z.string().trim().min(1).max(256).nullable().default(null),
  turnId: z.string().trim().min(1).max(512).nullable().default(null),
  messageId: z.string().trim().min(1).max(512).nullable().default(null),
});
export type ProviderMessageIdentity = z.infer<typeof ProviderMessageIdentitySchema>;

/** `next-attempt` is resolved later and never requires changing message.jobId. */
export const TaskMessageTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attempt"), jobId: z.string().uuid() }),
  z.object({ kind: z.literal("next-attempt"), afterJobId: z.string().uuid().nullable().default(null) }),
  z.object({ kind: z.literal("unknown") }),
]);
export type TaskMessageTarget = z.infer<typeof TaskMessageTargetSchema>;

export const TaskMessageDeliveryStatusSchema = z.enum(["pending", "sent", "received", "failed", "withdrawn"]);
export type TaskMessageDeliveryStatus = z.infer<typeof TaskMessageDeliveryStatusSchema>;

export const TaskMessageSchema = z.object({
  id: z.string().uuid(),
  taskSessionId: z.string().uuid(),
  jobId: z.string().uuid().nullable().default(null),
  role: TaskMessageRoleSchema,
  deliveryStatus: TaskMessageDeliveryStatusSchema,
  source: MetadataSourceSchema.default("unknown"),
  // Optional so legacy payloads retain their exact historical shape on read.
  // New writers should emit explicit unknown/null values where applicable.
  recipient: TaskMessageRecipientSchema.optional(),
  intent: TaskMessageIntentSchema.optional(),
  target: TaskMessageTargetSchema.optional(),
  providerIdentity: ProviderMessageIdentitySchema.nullable().optional(),
  orchestratorContext: OrchestratorTurnContextSchema.nullable().optional(),
  content: z.string().max(20_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
/** Accept legacy stored message shapes without rewriting their payload on read. */
export type TaskMessage = z.infer<typeof TaskMessageSchema>;
export type TaskMessageOutput = z.infer<typeof TaskMessageSchema>;

/** D02/D08 persist this relation atomically when dispatching a queued message.
 * It preserves the immutable TaskMessage.jobId identity of historical rows. */
export const TaskMessageAttemptDispatchSchema = z.object({
  id: z.string().uuid(),
  taskSessionId: z.string().uuid(),
  taskMessageId: z.string().uuid(),
  attemptJobId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type TaskMessageAttemptDispatch = z.infer<typeof TaskMessageAttemptDispatchSchema>;

export const JobRecordSchema = JobInputSchema.extend({
  id: z.string().uuid(),
  status: JobStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  // The worker can stop in BLOCKED while the task remains eligible to resume.
  // Keep that execution boundary distinct from a terminal task completion.
  stoppedAt: z.string().datetime().nullable().default(null),
  // A task session groups explicit continuations and retries. Legacy jobs are
  // backfilled by persistence; null remains valid for raw historical JSON.
  taskSessionId: z.string().uuid().nullable().default(null),
  // Draft jobs use 1; persistence assigns and preserves the definitive index
  // when inserting an attempt inside its task session transaction.
  attemptIndex: z.number().int().positive().default(1),
  conversationId: z.string().nullable().default(null),
  parentJobId: z.string().uuid().nullable().optional(),
  retryOfJobId: z.string().uuid().nullable().optional(),
  worktreePath: z.string().max(4096).nullable().default(null),
  branchName: z.string().max(256).nullable().default(null),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable().default(null),
  errorCode: JobErrorCodeSchema.nullable().default(null),
  result: JobResultSchema.nullable(),
  errorMessage: z.string().nullable(),
  // `model` and `effort` above remain the requested configuration. Effective
  // values are null until the runner reports them; never infer them from a UI.
  effectiveModel: z.string().trim().min(1).max(160).nullable().default(null),
  effectiveEffort: EffortSchema.nullable().default(null),
  executionMetadataSource: MetadataSourceSchema.default("unknown"),
  orchestrator: OrchestratorMetadataSchema,
  profileSnapshot: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type JobRecord = z.infer<typeof JobRecordSchema>;

export const DashboardEventSchema = z.object({
  type: z.literal("job.updated"),
  job: JobRecordSchema,
  event: JobEventSchema,
});

export type DashboardEvent = z.infer<typeof DashboardEventSchema>;

// --- Phase 3 MCP, Cursor & Pagination Contracts ---

export function encodeCursor(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

export function decodeCursor<T = Record<string, unknown>>(cursor: string): T | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export const EventPageDirectionSchema = z.enum(["forward", "backward"]);
export type EventPageDirection = z.infer<typeof EventPageDirectionSchema>;

export const PaginationQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Forward is retained for MCP and existing clients. The dashboard asks for
  // backward pages so a long transcript opens at its latest activity.
  direction: EventPageDirectionSchema.default("forward"),
});
export type PaginationQuery = z.input<typeof PaginationQuerySchema>;
export type PaginationQueryOutput = z.infer<typeof PaginationQuerySchema>;

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export const JobListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: JobStatusSchema.optional(),
  workspace: z.string().trim().min(1).max(4096).optional(),
  profile: z.string().trim().min(1).max(80).optional(),
  taskSessionId: z.string().uuid().optional(),
  parentJobId: z.string().uuid().optional(),
  retryOfJobId: z.string().uuid().optional(),
});
export type JobListQuery = z.input<typeof JobListQuerySchema>;
export type JobListQueryOutput = z.infer<typeof JobListQuerySchema>;

export const PaginatedJobsResponseSchema = z.object({
  items: z.array(JobRecordSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().int().min(0).optional(),
});
export type PaginatedJobsResponse = z.infer<typeof PaginatedJobsResponseSchema>;

export const PaginatedEventsResponseSchema = z.object({
  items: z.array(JobEventSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().int().min(0).optional(),
});
export type PaginatedEventsResponse = z.infer<typeof PaginatedEventsResponseSchema>;

export const TaskMessageListQuerySchema = PaginationQuerySchema;
export type TaskMessageListQuery = z.input<typeof TaskMessageListQuerySchema>;
export type TaskMessageListQueryOutput = z.infer<typeof TaskMessageListQuerySchema>;

/** Internal cursor payloads remain encoded by encodeCursor. They bind a cursor
 * to one task and one direction so it cannot be replayed for another query. */
export const TaskAttemptCursorSchema = z.object({
  taskSessionId: z.string().uuid(),
  direction: EventPageDirectionSchema,
  attemptIndex: z.number().int().positive(),
  jobId: z.string().uuid(),
});
export type TaskAttemptCursor = z.infer<typeof TaskAttemptCursorSchema>;

export const TaskMessageCursorSchema = z.object({
  taskSessionId: z.string().uuid(),
  direction: EventPageDirectionSchema,
  createdAt: z.string().datetime(),
  messageId: z.string().uuid(),
});
export type TaskMessageCursor = z.infer<typeof TaskMessageCursorSchema>;

export const PaginatedTaskMessagesResponseSchema = z.object({
  items: z.array(TaskMessageSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().int().min(0).optional(),
});
export type PaginatedTaskMessagesResponse = z.infer<typeof PaginatedTaskMessagesResponseSchema>;

export const TaskSessionSchema = z.object({
  id: z.string().uuid(),
  rootJobId: z.string().uuid(),
  workspacePath: z.string().trim().min(1).max(4096),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TaskSession = z.infer<typeof TaskSessionSchema>;

export const PaginatedTaskAttemptsResponseSchema = PaginatedJobsResponseSchema;
export type PaginatedTaskAttemptsResponse = z.infer<typeof PaginatedTaskAttemptsResponseSchema>;

export const TaskReadResponseSchema = z.object({
  task: TaskSessionSchema,
  latestAttempt: JobRecordSchema.nullable(),
});
export type TaskReadResponse = z.infer<typeof TaskReadResponseSchema>;

export const TaskContinuationInputSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  fromAttemptId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  recipient: z.enum(["worker", "orchestrator"]).default("worker"),
  target: z.enum(["next-attempt", "attempt"]).default("next-attempt"),
  orchestratorContext: OrchestratorTurnContextInputSchema.nullable().default(null),
}).superRefine((value, context) => {
  if (value.target === "attempt" && value.fromAttemptId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fromAttemptId"], message: "An attempt target requires fromAttemptId" });
  }
});
export type TaskContinuationInput = z.infer<typeof TaskContinuationInputSchema>;

export const TaskMutationResponseSchema = z.object({
  task: TaskSessionSchema,
  attempt: JobRecordSchema.nullable(),
  message: TaskMessageSchema,
  idempotentReplay: z.boolean().default(false),
});
export type TaskMutationResponse = z.infer<typeof TaskMutationResponseSchema>;

export const ContractErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "TASK_NOT_FOUND",
  "ATTEMPT_NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "MESSAGE_NOT_DISPATCHABLE",
  "TASK_ACTIVE",
  "ORCHESTRATOR_UNAVAILABLE",
]);
export type ContractErrorCode = z.infer<typeof ContractErrorCodeSchema>;

export const ContractErrorResponseSchema = z.object({
  code: ContractErrorCodeSchema,
  message: z.string().trim().min(1).max(2_000),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ContractErrorResponse = z.infer<typeof ContractErrorResponseSchema>;

// Batch Submission Contracts (1 to 8 jobs)
export const JobBatchSubmitInputSchema = z.object({
  jobs: z.array(JobInputSchema).min(1).max(8),
});
export type JobBatchSubmitInput = z.infer<typeof JobBatchSubmitInputSchema>;

export const BatchItemAcceptedSchema = z.object({
  index: z.number().int().min(0),
  job: JobRecordSchema,
  idempotentReplay: z.boolean().default(false),
});
export type BatchItemAccepted = z.infer<typeof BatchItemAcceptedSchema>;

export const BatchItemRejectedSchema = z.object({
  index: z.number().int().min(0),
  error: z.string().min(1).max(2000),
  code: z.string().min(1).max(100).default("VALIDATION_ERROR"),
  input: z.unknown().optional(),
});
export type BatchItemRejected = z.infer<typeof BatchItemRejectedSchema>;

export const JobBatchSubmitResponseSchema = z.object({
  accepted: z.array(BatchItemAcceptedSchema),
  rejected: z.array(BatchItemRejectedSchema),
});
export type JobBatchSubmitResponse = z.infer<typeof JobBatchSubmitResponseSchema>;

// Continuation / Send Message
export const JobSendMessageInputSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});
export type JobSendMessageInput = z.infer<typeof JobSendMessageInputSchema>;

// Retry
export const JobRetryInputSchema = z.object({
  task: z.string().trim().min(3).max(20_000).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  effort: EffortSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  verificationCommands: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
});
export type JobRetryInput = z.infer<typeof JobRetryInputSchema>;

/** Task-scoped retry keeps the legacy override shape, but the task route
 * supplies the stable task identity and requires a replay key. */
export const TaskRetryInputSchema = JobRetryInputSchema.extend({
  fromAttemptId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  orchestratorContext: OrchestratorTurnContextInputSchema.nullable().default(null),
});
export type TaskRetryInput = z.infer<typeof TaskRetryInputSchema>;

// Wait / Long-poll
export const JobWaitQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  timeoutSeconds: z.coerce.number().int().min(1).max(60).default(30),
});
export type JobWaitQuery = z.input<typeof JobWaitQuerySchema>;
export type JobWaitQueryOutput = z.infer<typeof JobWaitQuerySchema>;

export const JobWaitResponseSchema = z.object({
  job: JobRecordSchema,
  timedOut: z.boolean(),
  latestEventSequence: z.number().int().min(0),
});
export type JobWaitResponse = z.infer<typeof JobWaitResponseSchema>;

// Diff
export const JobDiffQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type JobDiffQuery = z.input<typeof JobDiffQuerySchema>;
export type JobDiffQueryOutput = z.infer<typeof JobDiffQuerySchema>;

export const JobDiffResponseSchema = z.object({
  jobId: z.string().uuid(),
  available: z.boolean().default(false),
  reason: z.string().optional(),
  files: z.array(z.string()).default([]),
  diff: z.string().default(""),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});
export type JobDiffResponse = z.infer<typeof JobDiffResponseSchema>;

// Snapshot
export const JobSnapshotSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: JobStatusSchema,
  workspacePath: z.string(),
  profileId: z.string(),
  agent: z.string().nullable().optional(),
  accessMode: JobAccessModeSchema,
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().nullable().default(null),
  model: z.string(),
  effort: EffortSchema,
  requestedModel: z.string(),
  requestedEffort: EffortSchema,
  effectiveModel: z.string().nullable().default(null),
  effectiveEffort: EffortSchema.nullable().default(null),
  executionMetadataSource: MetadataSourceSchema.default("unknown"),
  orchestrator: OrchestratorMetadataSchema,
  taskSessionId: z.string().uuid().nullable().default(null),
  attemptIndex: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable().default(null),
  parentJobId: z.string().uuid().nullable().optional(),
  retryOfJobId: z.string().uuid().nullable().optional(),
  reviewOfJobId: z.string().uuid().nullable().optional(),
  dependsOnJobIds: z.array(z.string().uuid()).default([]),
  conversationId: z.string().nullable().default(null),
  errorCode: JobErrorCodeSchema.nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
});
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

export function toJobSnapshot(job: JobRecord): JobSnapshot {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    workspacePath: job.workspacePath,
    profileId: job.profileId,
    agent: job.agent ?? null,
    accessMode: job.accessMode,
    worktreePath: job.worktreePath,
    branchName: job.branchName,
    model: job.model,
    effort: job.effort,
    requestedModel: job.model,
    requestedEffort: job.effort,
    effectiveModel: job.effectiveModel,
    effectiveEffort: job.effectiveEffort,
    executionMetadataSource: job.executionMetadataSource,
    orchestrator: job.orchestrator,
    taskSessionId: job.taskSessionId,
    attemptIndex: job.attemptIndex,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stoppedAt: job.stoppedAt,
    parentJobId: job.parentJobId ?? null,
    retryOfJobId: job.retryOfJobId ?? null,
    reviewOfJobId: job.reviewOfJobId ?? null,
    dependsOnJobIds: job.dependsOnJobIds,
    conversationId: job.conversationId ?? null,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
    summary: job.result?.summary ?? null,
  };
}
