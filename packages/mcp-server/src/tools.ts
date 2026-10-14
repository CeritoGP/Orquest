import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  EffortSchema,
  JobBatchSubmitResponseSchema,
  JobDiffResponseSchema,
  JobInputSchema,
  JobRecordSchema,
  JobStatusSchema,
  JobWaitResponseSchema,
  PaginatedEventsResponseSchema,
  PaginatedJobsResponseSchema,
  type JobBatchSubmitResponse,
  type JobDiffResponse,
  type JobRecord,
  type JobWaitResponse,
  type PaginatedEventsResponse,
  type PaginatedJobsResponse,
} from "@orquest/contracts";
import type { DaemonClient } from "./client.js";
import { redactSecrets } from "./client.js";

export const MCP_INSTRUCTIONS =
  "Orquest Bridge is a local-only orchestration bridge connecting Codex to Antigravity CLI workers via a daemon on 127.0.0.1. Read tools (health, list, get, wait, transcript, diff) are safe and read-only. Mutating tools submit bounded tasks, continuations, or retries. This bridge never performs git merge, git push, deployment, database migrations, or bypasses Antigravity tool permissions. Always call orquest_health first, inspect diffs before integration, and keep task scopes bounded.";

export const TOOL_NAMES = [
  "orquest_health",
  "orquest_submit_jobs",
  "orquest_list_jobs",
  "orquest_get_job",
  "orquest_wait_job",
  "orquest_get_transcript",
  "orquest_send_message",
  "orquest_cancel_job",
  "orquest_retry_job",
  "orquest_get_diff",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

function createToolResult(text: string, structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function createToolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected bridge error";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${redactSecrets(message)}` }],
  };
}

export function registerAllTools(server: McpServer, client: DaemonClient): void {
  // 1. orquest_health (read-only)
  server.registerTool(
    "orquest_health",
    {
      title: "Check Orquest bridge health",
      description: "Checks local daemon readiness, runner type, and authentication status. Call this tool first.",
      outputSchema: z.object({
        status: z.string().optional(),
        up: z.boolean(),
        runner: z.string().optional(),
        timestamp: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const result = await client.request<{ status?: string; up: boolean; runner?: string; timestamp?: string }>("/health");
        const statusText = result.status ?? (result.up ? "up" : "down");
        const runnerText = result.runner ? `, runner: ${result.runner}` : "";
        const summary = `Orquest daemon health: ${statusText}${runnerText}`;
        return createToolResult(summary, result as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 2. orquest_submit_jobs (mutation, replaces preliminary orquest_submit_job)
  server.registerTool(
    "orquest_submit_jobs",
    {
      title: "Submit Orquest jobs",
      description: "Submits 1 to 8 bounded workers. Jobs can be read-only or isolated worktree writers, can depend on completed jobs, and can review a writer worktree read-only. Supports partial success and idempotency keys.",
      inputSchema: {
        jobs: z.array(JobInputSchema).min(1).max(8).describe("Batch of 1 to 8 bounded jobs; use dependsOnJobIds for prerequisites and reviewOfJobId for a read-only review"),
      },
      outputSchema: JobBatchSubmitResponseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ jobs }) => {
      try {
        const result = await client.request<JobBatchSubmitResponse>("/api/jobs/batch", {
          method: "POST",
          body: JSON.stringify({ jobs }),
        });
        const acceptedIds = result.accepted.map((item) => `#${item.job.id.slice(0, 8)}`).join(", ");
        const summary = `Batch submission: ${result.accepted.length} accepted (${acceptedIds || "none"}), ${result.rejected.length} rejected`;
        return createToolResult(summary, result as unknown as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 3. orquest_list_jobs (read-only)
  server.registerTool(
    "orquest_list_jobs",
    {
      title: "List Orquest jobs",
      description: "Lists persisted worker jobs with cursor-based pagination and optional filters.",
      inputSchema: {
        cursor: z.string().trim().min(1).max(2048).optional().describe("Opaque pagination cursor from a previous response"),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of jobs to return (1-100, default 20)"),
        status: JobStatusSchema.optional().describe("Filter jobs by status (e.g. READY, QUEUED, RUNNING, DONE, FAILED, CANCELED)"),
        workspace: z.string().trim().min(1).max(4096).optional().describe("Filter jobs by canonical workspace path"),
        profile: z.string().trim().min(1).max(80).optional().describe("Filter jobs by profile ID"),
        parentJobId: z.string().uuid().optional().describe("Filter continuations by parent job ID"),
        retryOfJobId: z.string().uuid().optional().describe("Filter retries by original job ID"),
      },
      outputSchema: PaginatedJobsResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const search = new URLSearchParams();
        if (params.cursor) search.set("cursor", params.cursor);
        if (params.limit !== undefined) search.set("limit", String(params.limit));
        if (params.status) search.set("status", params.status);
        if (params.workspace) search.set("workspace", params.workspace);
        if (params.profile) search.set("profile", params.profile);
        if (params.parentJobId) search.set("parentJobId", params.parentJobId);
        if (params.retryOfJobId) search.set("retryOfJobId", params.retryOfJobId);

        const qs = search.toString();
        const path = `/api/jobs${qs ? `?${qs}` : ""}`;
        const result = await client.request<PaginatedJobsResponse>(path);
        const summary = `Found ${result.items.length} jobs (hasMore: ${result.hasMore}, nextCursor: ${result.nextCursor ?? "none"})`;
        return createToolResult(summary, result as unknown as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 4. orquest_get_job (read-only)
  server.registerTool(
    "orquest_get_job",
    {
      title: "Get an Orquest job",
      description: "Returns the current snapshot, metadata, effective configuration and terminal result for a job.",
      inputSchema: {
        jobId: z.string().uuid().describe("Unique identifier (UUID) of the job"),
      },
      outputSchema: z.object({
        job: JobRecordSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId }) => {
      try {
        const result = await client.request<{ job: JobRecord }>(`/api/jobs/${jobId}`);
        const summary = `Job #${result.job.id.slice(0, 8)} [${result.job.status}]: ${result.job.title} (model: ${result.job.model}, effort: ${result.job.effort})`;
        return createToolResult(summary, result as unknown as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 5. orquest_wait_job (read-only long poll)
  server.registerTool(
    "orquest_wait_job",
    {
      title: "Wait for Orquest job change or completion",
      description: "Performs long-polling (up to 60s) waiting for job status updates, new events, or terminal completion.",
      inputSchema: {
        jobId: z.string().uuid().describe("Unique identifier (UUID) of the job to wait for"),
        after: z.number().int().min(0).optional().describe("Last observed event sequence number. Waits until a higher sequence occurs."),
        timeoutSeconds: z.number().int().min(1).max(60).default(30).describe("Long-poll timeout in seconds (1-60, default 30)"),
      },
      outputSchema: JobWaitResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId, after, timeoutSeconds }) => {
      try {
        const search = new URLSearchParams();
        search.set("timeoutSeconds", String(timeoutSeconds));
        if (after !== undefined) search.set("after", String(after));

        const clientTimeoutMs = timeoutSeconds * 1000 + 10_000;
        const result = await client.request<JobWaitResponse>(
          `/api/jobs/${jobId}/wait?${search.toString()}`,
          undefined,
          clientTimeoutMs,
        );
        const summary = `Wait completed for job #${result.job.id.slice(0, 8)}: status=${result.job.status}, timedOut=${result.timedOut}, latestEventSequence=${result.latestEventSequence}`;
        return createToolResult(summary, result as unknown as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 6. orquest_get_transcript (read-only)
  server.registerTool(
    "orquest_get_transcript",
    {
      title: "Read an Orquest job transcript",
      description: "Reads a bounded page of persisted job events. Use nextCursor to fetch subsequent pages.",
      inputSchema: {
        jobId: z.string().uuid().describe("Unique identifier (UUID) of the job"),
        cursor: z.string().trim().min(1).max(2048).optional().describe("Opaque pagination cursor from previous transcript response"),
        limit: z.number().int().min(1).max(100).default(30).describe("Maximum number of events to return (1-100, default 30)"),
      },
      outputSchema: PaginatedEventsResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId, cursor, limit }) => {
      try {
        const search = new URLSearchParams();
        if (cursor) search.set("cursor", cursor);
        if (limit !== undefined) search.set("limit", String(limit));

        const qs = search.toString();
        const path = `/api/jobs/${jobId}/events${qs ? `?${qs}` : ""}`;
        const result = await client.request<PaginatedEventsResponse>(path);
        const summary = `Transcript for job #${jobId.slice(0, 8)}: ${result.items.length} events (hasMore: ${result.hasMore}, nextCursor: ${result.nextCursor ?? "none"})`;
        return createToolResult(summary, result as unknown as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 7. orquest_send_message (mutation / continuation)
  server.registerTool(
    "orquest_send_message",
    {
      title: "Continue an Orquest job conversation",
      description: "Continues a terminal job's conversation by creating a linked child job. Requires original job to have conversationId.",
      inputSchema: {
        jobId: z.string().uuid().describe("Unique identifier (UUID) of the terminal parent job to continue"),
        message: z.string().trim().min(1).max(20_000).describe("Follow-up instruction or message for the worker"),
        idempotencyKey: z.string().trim().min(1).max(200).optional().describe("Optional idempotency key to prevent duplicate continuation jobs"),
      },
      outputSchema: z.object({
        job: JobRecordSchema,
        parentJob: JobRecordSchema.optional(),
        idempotentReplay: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ jobId, message, idempotencyKey }) => {
      try {
        const result = await client.request<{ job: JobRecord; parentJob?: JobRecord; idempotentReplay?: boolean }>(
          `/api/jobs/${jobId}/messages`,
          {
            method: "POST",
            body: JSON.stringify({ message, idempotencyKey }),
          },
        );
        const replayTag = result.idempotentReplay ? " (replayed)" : "";
        const summary = `Continuation job #${result.job.id.slice(0, 8)} queued${replayTag} (parent: #${jobId.slice(0, 8)})`;
        return createToolResult(summary, {
          job: result.job,
          ...(result.parentJob ? { parentJob: result.parentJob } : {}),
          idempotentReplay: Boolean(result.idempotentReplay),
        });
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 8. orquest_cancel_job (destructive mutation)
  server.registerTool(
    "orquest_cancel_job",
    {
      title: "Cancel an Orquest job",
      description: "Requests clean cancellation of a queued or running worker job and terminates its process tree.",
      inputSchema: {
        jobId: z.string().uuid().describe("Unique identifier (UUID) of the job to cancel"),
      },
      outputSchema: z.object({
        job: JobRecordSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId }) => {
      try {
        const result = await client.request<{ job: JobRecord }>(`/api/jobs/${jobId}/cancel`, {
          method: "POST",
          body: "{}",
        });
        const summary = `Job #${jobId.slice(0, 8)} cancellation requested (current status: ${result.job.status})`;
        return createToolResult(summary, result as unknown as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 9. orquest_retry_job (mutation)
  server.registerTool(
    "orquest_retry_job",
    {
      title: "Retry an Orquest job",
      description: "Creates a linked new job attempt linked to an original terminal or blocked job without reopening the original.",
      inputSchema: {
        jobId: z.string().uuid().describe("Unique identifier (UUID) of the original job to retry"),
        task: z.string().trim().min(3).max(20_000).optional().describe("Optional revised task description"),
        model: z.string().trim().min(1).max(160).optional().describe("Optional revised model name or slug"),
        effort: EffortSchema.optional().describe("Optional revised effort level (low, medium, high)"),
        idempotencyKey: z.string().trim().min(1).max(200).optional().describe("Optional idempotency key"),
        verificationCommands: z.array(z.string().trim().min(1).max(500)).max(10).optional().describe("Optional verification commands"),
      },
      outputSchema: z.object({
        job: JobRecordSchema,
        originalJob: JobRecordSchema.optional(),
        idempotentReplay: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ jobId, task, model, effort, idempotencyKey, verificationCommands }) => {
      try {
        const result = await client.request<{ job: JobRecord; originalJob?: JobRecord; idempotentReplay?: boolean }>(
          `/api/jobs/${jobId}/retry`,
          {
            method: "POST",
            body: JSON.stringify({ task, model, effort, idempotencyKey, verificationCommands }),
          },
        );
        const replayTag = result.idempotentReplay ? " (replayed)" : "";
        const summary = `Retry job #${result.job.id.slice(0, 8)} created${replayTag} (original: #${jobId.slice(0, 8)})`;
        return createToolResult(summary, {
          job: result.job,
          ...(result.originalJob ? { originalJob: result.originalJob } : {}),
          idempotentReplay: Boolean(result.idempotentReplay),
        });
      } catch (error) {
        return createToolError(error);
      }
    },
  );

  // 10. orquest_get_diff (read-only)
  server.registerTool(
    "orquest_get_diff",
    {
      title: "Get an Orquest job diff",
      description: "Inspects paginated code changes in an isolated worktree. It never applies or merges the diff.",
      inputSchema: {
        jobId: z.string().uuid().describe("Unique identifier (UUID) of the job"),
        cursor: z.string().trim().min(1).max(2048).optional().describe("Opaque pagination cursor"),
        limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of files or diff chunks to return (default 50)"),
      },
      outputSchema: JobDiffResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId, cursor, limit }) => {
      try {
        const search = new URLSearchParams();
        if (cursor) search.set("cursor", cursor);
        if (limit !== undefined) search.set("limit", String(limit));

        const qs = search.toString();
        const path = `/api/jobs/${jobId}/diff${qs ? `?${qs}` : ""}`;
        const result = await client.request<JobDiffResponse>(path);
        const summary = `Diff for job #${jobId.slice(0, 8)}: available=${result.available}${result.reason ? ` (${result.reason})` : ""}`;
        return createToolResult(summary, result as unknown as Record<string, unknown>);
      } catch (error) {
        return createToolError(error);
      }
    },
  );
}
