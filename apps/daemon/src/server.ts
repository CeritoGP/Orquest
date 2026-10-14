import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
JobDiffQuerySchema,
JobListQuerySchema,
  JobRetryInputSchema,
  JobSendMessageInputSchema,
  JobWaitQuerySchema,
  PaginationQuerySchema,
} from "@orquest/contracts";
import { AgyRunner } from "@orquest/agy-adapter";
import { loadExecutionProfiles, WorktreeManager, type JobRunner } from "@orquest/core";
import { FakeAgyRunner } from "@orquest/fake-agy";
import { OrquestDatabase } from "@orquest/persistence";
import { isLoopbackAddress, resolveDaemonToken, authenticateRequest } from "./auth.js";
import {
  JobConflictError,
  JobNotFoundError,
  JobService,
  JobValidationError,
} from "./service.js";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function parseMaxConcurrency(value: string | undefined): number {
  if (value === undefined || value === "") return 2;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 16 ? parsed : 2;
}

export interface DaemonServerOptions {
  host?: string;
  port?: number;
  stateRoot?: string;
  runner?: JobRunner;
  maxConcurrency?: number;
  allowedRoots?: readonly string[];
  isRealRunner?: boolean;
  token?: string;
  profilesPath?: string;
  database?: OrquestDatabase;
}

export interface DaemonServerInstance {
  server: Server;
  database: OrquestDatabase;
  service: JobService;
  token: string;
  tokenSource: "env" | "file";
  tokenPath?: string | undefined;
  port: number;
  host: string;
  profiles: Record<string, unknown>;
  start: () => Promise<{ port: number; host: string }>;
  stop: () => Promise<void>;
}

export function createDaemonServer(options: DaemonServerOptions = {}): DaemonServerInstance {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number.parseInt(process.env.ORQUEST_PORT ?? "4317", 10);
  const stateRoot = options.stateRoot ?? process.env.ORQUEST_HOME ?? join(homedir(), "AppData", "Local", "OrquestBridge");
  const useAgy = options.isRealRunner ?? (process.env.ORQUEST_RUNNER === "agy");
  const agyExecutable = process.env.ORQUEST_AGY_EXECUTABLE;

  const runner =
    options.runner ??
    (useAgy
      ? new AgyRunner({
          printTimeout: "20m",
          sandbox: true,
          ...(agyExecutable === undefined ? {} : { executable: agyExecutable }),
        })
      : new FakeAgyRunner());

  const database = options.database ?? new OrquestDatabase(join(stateRoot, "orquest.db"));
  const allowedRoots =
    options.allowedRoots ??
    (process.env.ORQUEST_ALLOWED_ROOTS ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);

  const profilesPath = options.profilesPath ?? process.env.ORQUEST_PROFILES_PATH;
  const profiles = loadExecutionProfiles(profilesPath);
  const publicProfiles = Object.fromEntries(profiles);

  const concurrency = options.maxConcurrency ?? parseMaxConcurrency(process.env.ORQUEST_MAX_CONCURRENCY);
  const worktreeManager = new WorktreeManager(join(stateRoot, "worktrees"));
  const service = new JobService(database, runner, concurrency, allowedRoots, useAgy, worktreeManager, profiles);

  const tokenResolution = resolveDaemonToken({
    ...(options.token !== undefined ? { explicitToken: options.token } : {}),
    tokenPath: join(stateRoot, "daemon.token"),
  });
  const token = tokenResolution.token;

  const server = createServer(async (request, response) => {
    const remoteIp = request.socket.remoteAddress;
    if (!isLoopbackAddress(remoteIp)) {
      sendJson(response, 403, { error: "Forbidden: Non-loopback connections are rejected" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const auth = authenticateRequest(request, token);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        if (auth.status === "valid") {
          sendJson(response, 200, {
            status: "ok",
            up: true,
            runner: useAgy ? "agy" : "fake-agy",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (auth.status === "invalid") {
          sendJson(response, 401, { error: "Unauthorized: Invalid or malformed authorization header" });
          return;
        }

        // auth.status === "none"
        sendJson(response, 200, { up: true });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (auth.status !== "valid") {
          sendJson(response, 401, { error: "Unauthorized: Invalid or missing bearer token" });
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/profiles") {
        sendJson(response, 200, { profiles: publicProfiles });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/jobs") {
        const queryObj: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryObj[key] = value;
        }
        const query = JobListQuerySchema.parse(queryObj);
        const result = service.queryJobs(query);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/jobs/batch") {
        const body = await readJson(request);
        const result = service.submitBatch(body);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/jobs") {
        const body = await readJson(request);
        const job = service.submit(body);
        sendJson(response, 202, { job });
        return;
      }

      const eventsMatch = /^\/api\/jobs\/([0-9a-f-]+)\/events$/i.exec(url.pathname);
      if (request.method === "GET" && eventsMatch?.[1] !== undefined) {
        const jobId = eventsMatch[1];
        if (!service.getJob(jobId)) {
          sendJson(response, 404, { error: `Job not found: ${jobId}` });
          return;
        }
        const queryObj: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryObj[key] = value;
        }
        const query = PaginationQuerySchema.parse(queryObj);
        const result = service.listEventsPaginated(jobId, query);
        sendJson(response, 200, result);
        return;
      }

      const waitMatch = /^\/api\/jobs\/([0-9a-f-]+)\/wait$/i.exec(url.pathname);
      if (request.method === "GET" && waitMatch?.[1] !== undefined) {
        const jobId = waitMatch[1];
        const queryObj: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryObj[key] = value;
        }
        const query = JobWaitQuerySchema.parse(queryObj);
        const waitResult = await service.waitJob(jobId, query);
        sendJson(response, 200, waitResult);
        return;
      }

      const messagesMatch = /^\/api\/jobs\/([0-9a-f-]+)\/messages$/i.exec(url.pathname);
      if (request.method === "POST" && messagesMatch?.[1] !== undefined) {
        const parentJobId = messagesMatch[1];
        const body = JobSendMessageInputSchema.parse(await readJson(request));
        const result = service.submitContinuation(parentJobId, body);
        sendJson(response, result.idempotentReplay ? 200 : 201, result);
        return;
      }

      const cancelMatch = /^\/api\/jobs\/([0-9a-f-]+)\/cancel$/i.exec(url.pathname);
      if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
        const jobId = cancelMatch[1];
        const canceled = service.cancel(jobId);
        if (canceled === null) {
          sendJson(response, 404, { error: `Job not found: ${jobId}` });
        } else {
          sendJson(response, 200, { job: canceled });
        }
        return;
      }

      const retryMatch = /^\/api\/jobs\/([0-9a-f-]+)\/retry$/i.exec(url.pathname);
      if (request.method === "POST" && retryMatch?.[1] !== undefined) {
        const originalJobId = retryMatch[1];
        const body = JobRetryInputSchema.parse(await readJson(request));
        const result = service.submitRetry(originalJobId, body);
        sendJson(response, result.idempotentReplay ? 200 : 201, result);
        return;
      }

      const diffMatch = /^\/api\/jobs\/([0-9a-f-]+)\/diff$/i.exec(url.pathname);
      if (request.method === "GET" && diffMatch?.[1] !== undefined) {
        const jobId = diffMatch[1];
        if (!service.getJob(jobId)) {
          sendJson(response, 404, { error: `Job not found: ${jobId}` });
          return;
        }
        const queryObj: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryObj[key] = value;
        }
        const query = JobDiffQuerySchema.parse(queryObj);
        sendJson(response, 200, service.getDiff(jobId, query));
        return;
      }

      const jobMatch = /^\/api\/jobs\/([0-9a-f-]+)$/i.exec(url.pathname);
      if (request.method === "GET" && jobMatch?.[1] !== undefined) {
        const jobId = jobMatch[1];
        const job = service.getJob(jobId);
        if (job === null) {
          sendJson(response, 404, { error: `Job not found: ${jobId}` });
        } else {
          sendJson(response, 200, { job });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events/stream") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write("retry: 1000\n\n");
        const unsubscribe = service.subscribe((event) => {
          response.write(`id: ${event.event.sequence}\n`);
          response.write("event: job.updated\n");
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        request.on("close", unsubscribe);
        return;
      }

      sendJson(response, 404, { error: "Route not found" });
    } catch (error) {
      if (error instanceof JobNotFoundError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }
      if (error instanceof JobConflictError) {
        sendJson(response, error.statusCode, { error: error.message, code: error.code });
        return;
      }
      if (error instanceof JobValidationError) {
        sendJson(response, error.statusCode, { error: error.message, code: error.code });
        return;
      }
      if (error instanceof z.ZodError) {
        sendJson(response, 400, { error: "Validation error", issues: error.issues });
        return;
      }
      const message = error instanceof Error ? error.message : "Unexpected server error";
      if (message.includes("Invalid cursor") || message.includes("cursor")) {
        sendJson(response, 400, { error: message });
        return;
      }
      sendJson(response, 400, { error: message });
    }
  });

  const start = (): Promise<{ port: number; host: string }> => {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
        resolve({ port: actualPort, host });
      });
    });
  };

  const stop = (): Promise<void> => {
    return new Promise((resolve) => {
      service.close();
      server.close(() => {
        try {
          database.close();
        } catch {
          /* already closed */
        }
        resolve();
      });
    });
  };

  return {
    server,
    database,
    service,
    token,
    tokenSource: tokenResolution.source,
    tokenPath: tokenResolution.tokenPath,
    port,
    host,
    profiles: publicProfiles,
    start,
    stop,
  };
}

const isMainScript =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js")) &&
  !process.argv.some((arg) => arg.includes("vitest"));

if (isMainScript) {
  const daemon = createDaemonServer();
  daemon
    .start()
    .then(({ port, host }) => {
      console.log(`Orquest daemon listening at http://${host}:${port}`);
      if (daemon.tokenSource === "file" && daemon.tokenPath) {
        console.log(`Daemon auth token file: ${daemon.tokenPath}`);
      } else {
        console.log("Daemon auth token configured via environment");
      }
    })
    .catch((err: unknown) => {
      console.error("Failed to start Orquest daemon:", err instanceof Error ? err.message : err);
      process.exit(1);
    });

  const shutdown = (): void => {
    void daemon.stop().then(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
