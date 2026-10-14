import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDaemonServer, type DaemonServerInstance } from "../../../apps/daemon/src/server.js";
import { FakeAgyRunner } from "../../fake-agy/src/index.js";
import { OrquestDatabase } from "../../persistence/src/index.js";
import { createOrquestMcpServer } from "./index.js";

interface E2eContext {
  tempDir: string;
  daemon: DaemonServerInstance;
  client: Client;
  port: number;
}

const activeContexts: E2eContext[] = [];

afterEach(async () => {
  for (const ctx of activeContexts.splice(0)) {
    try {
      await ctx.client.close();
    } catch {
      /* ignore */
    }
    try {
      await ctx.daemon.stop();
    } catch {
      /* ignore */
    }
    try {
      rmSync(ctx.tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function setupE2e(): Promise<E2eContext> {
  const tempDir = mkdtempSync(join(tmpdir(), "orquest-mcp-e2e-"));
  const dbPath = join(tempDir, "orquest.db");
  const database = new OrquestDatabase(dbPath);
  const token = "e2e-secret-token-789";

  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    database,
    runner: new FakeAgyRunner(),
    token,
    maxConcurrency: 2,
    allowedRoots: [tempDir],
  });

  const { port, host } = await daemon.start();

  const mcpServer = createOrquestMcpServer({
    daemonUrl: `http://${host}:${port}`,
    token,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);

  const client = new Client({ name: "codex-e2e-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const context: E2eContext = { tempDir, daemon, client, port };
  activeContexts.push(context);
  return context;
}

describe("MCP Server E2E Gate (Phase 3 with Fake AGY)", () => {
  it("executes the full orchestration lifecycle: health, batch submit, wait, transcript pagination, continuation, cancellation, and restart", async () => {
    const { client, daemon, tempDir, port } = await setupE2e();

    // 1. orquest_health contracts (unauthenticated minimal, invalid token, authenticated)
    // 1a. Unauthenticated client: receives minimal health { up: true }
    const unauthMcpServer = createOrquestMcpServer({
      daemonUrl: `http://127.0.0.1:${port}`,
      tokenPath: join(tempDir, "missing-daemon.token"),
    });
    const [unauthC, unauthS] = InMemoryTransport.createLinkedPair();
    await unauthMcpServer.connect(unauthS);
    const unauthClient = new Client({ name: "codex-unauth", version: "1.0.0" }, { capabilities: {} });
    await unauthClient.connect(unauthC);
    const unauthHealth = await unauthClient.callTool({ name: "orquest_health", arguments: {} });
    expect(unauthHealth.isError).toBeFalsy();
    expect(unauthHealth.structuredContent).toEqual({ up: true });
    await unauthClient.close();

    // 1b. Invalid token client: returns 401 as isError: true with redacted error
    const invalidMcpServer = createOrquestMcpServer({
      daemonUrl: `http://127.0.0.1:${port}`,
      token: "invalid-synthetic-secret-token",
    });
    const [invC, invS] = InMemoryTransport.createLinkedPair();
    await invalidMcpServer.connect(invS);
    const invClient = new Client({ name: "codex-inv", version: "1.0.0" }, { capabilities: {} });
    await invClient.connect(invC);
    const invHealth = await invClient.callTool({ name: "orquest_health", arguments: {} });
    expect(invHealth.isError).toBe(true);
    const invContent = (invHealth.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(invContent).toContain("Unauthorized");
    expect(invContent).not.toContain("invalid-synthetic-secret-token");
    await invClient.close();

    // 1c. Valid Bearer token client: full health snapshot
    const healthResult = await client.callTool({ name: "orquest_health", arguments: {} });
    expect(healthResult.isError).toBeFalsy();
    const healthData = healthResult.structuredContent as { status: string; up: boolean; runner?: string };
    expect(healthData.status).toBe("ok");
    expect(healthData.up).toBe(true);
    expect(healthData.runner).toBe("fake-agy");

    // 2. orquest_submit_jobs (Batch submit of two read-only jobs with idempotency keys)
    const submitResult = await client.callTool({
      name: "orquest_submit_jobs",
      arguments: {
        jobs: [
          {
            title: "E2E Job Alpha",
            task: "Analyze repository structure",
            workspacePath: tempDir,
            profileId: "quick",
            accessMode: "read-only",
            model: "auto",
            effort: "low",
            idempotencyKey: "e2e-key-alpha",
          },
          {
            title: "E2E Job Beta",
            task: "Inspect security posture",
            workspacePath: tempDir,
            profileId: "quick",
            accessMode: "read-only",
            model: "auto",
            effort: "low",
            idempotencyKey: "e2e-key-beta",
          },
        ],
      },
    });

    expect(submitResult.isError).toBeFalsy();
    const batchData = submitResult.structuredContent as {
      accepted: Array<{ index: number; job: { id: string }; idempotentReplay: boolean }>;
      rejected: Array<{ index: number; error: string }>;
    };
    expect(batchData.accepted).toHaveLength(2);
    expect(batchData.rejected).toHaveLength(0);

    const jobAlphaId = batchData.accepted[0]!.job.id;
    const jobBetaId = batchData.accepted[1]!.job.id;
    expect(jobAlphaId).not.toBe(jobBetaId);
    const replayResult = await client.callTool({
      name: "orquest_submit_jobs",
      arguments: {
        jobs: [
          {
            title: "E2E Job Alpha (Duplicate)",
            task: "Analyze repository structure",
            workspacePath: tempDir,
            profileId: "quick",
            accessMode: "read-only",
            idempotencyKey: "e2e-key-alpha",
          },
        ],
      },
    });
    const replayData = replayResult.structuredContent as {
      accepted: Array<{ index: number; job: { id: string }; idempotentReplay: boolean }>;
    };
    expect(replayData.accepted[0]?.job.id).toBe(jobAlphaId);
    expect(replayData.accepted[0]?.idempotentReplay).toBe(true);

    // 3. orquest_wait_job (Wait for Job Alpha to complete)
    let waitData!: {
      job: { id: string; status: string; conversationId?: string | null };
      timedOut: boolean;
      latestEventSequence: number;
    };
    for (let i = 0; i < 10; i++) {
      const waitResult = await client.callTool({
        name: "orquest_wait_job",
        arguments: {
          jobId: jobAlphaId,
          timeoutSeconds: 5,
          ...(waitData ? { after: waitData.latestEventSequence } : {}),
        },
      });
      expect(waitResult.isError).toBeFalsy();
      waitData = waitResult.structuredContent as typeof waitData;
      if (waitData.job.status === "DONE") break;
    }
    expect(waitData.job.id).toBe(jobAlphaId);
    expect(waitData.job.status).toBe("DONE");
    expect(waitData.job.conversationId).toBe(`fake-${jobAlphaId}`);
    expect(waitData.timedOut).toBe(false);
    expect(waitData.latestEventSequence).toBeGreaterThan(0);

    // 4. orquest_get_transcript (Fetch two pages of events using cursor)
    const page1Result = await client.callTool({
      name: "orquest_get_transcript",
      arguments: { jobId: jobAlphaId, limit: 2 },
    });
    expect(page1Result.isError).toBeFalsy();
    const page1Data = page1Result.structuredContent as {
      items: Array<{ id: string; sequence: number }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1Data.items).toHaveLength(2);
    expect(page1Data.hasMore).toBe(true);
    expect(page1Data.nextCursor).not.toBeNull();

    const page2Result = await client.callTool({
      name: "orquest_get_transcript",
      arguments: { jobId: jobAlphaId, cursor: page1Data.nextCursor!, limit: 2 },
    });
    expect(page2Result.isError).toBeFalsy();
    const page2Data = page2Result.structuredContent as {
      items: Array<{ id: string; sequence: number }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page2Data.items.length).toBeGreaterThan(0);
    // Page 2 items must follow Page 1 items sequentially without overlap
    expect(page2Data.items[0]?.sequence).toBeGreaterThan(page1Data.items[1]?.sequence ?? 0);

    // 5. orquest_send_message (Continue terminal Job Alpha's conversation)
    const continuationResult = await client.callTool({
      name: "orquest_send_message",
      arguments: {
        jobId: jobAlphaId,
        message: "Follow up: clarify findings",
        idempotencyKey: "cont-key-alpha-1",
      },
    });
    expect(continuationResult.isError).toBeFalsy();
    const contData = continuationResult.structuredContent as {
      job: { id: string; parentJobId?: string | null; status: string };
      idempotentReplay: boolean;
    };
    expect(contData.job.parentJobId).toBe(jobAlphaId);
    expect(contData.job.status).toBe("QUEUED");

    // 6. orquest_cancel_job (Submit new job and cancel it)
    const cancelSubmit = await client.callTool({
      name: "orquest_submit_jobs",
      arguments: {
        jobs: [
          {
            title: "Job to cancel",
            task: "Long running task",
            workspacePath: tempDir,
          },
        ],
      },
    });
    const jobToCancelId = (cancelSubmit.structuredContent as { accepted: Array<{ job: { id: string } }> }).accepted[0]!.job.id;

    const cancelResult = await client.callTool({
      name: "orquest_cancel_job",
      arguments: { jobId: jobToCancelId },
    });
    expect(cancelResult.isError).toBeFalsy();
    const cancelData = cancelResult.structuredContent as { job: { status: string } };
    expect(["CANCELING", "CANCELED"]).toContain(cancelData.job.status);

    // 7. Restart test (Rehydration across daemon restart)
    await daemon.stop();

    // Rehydrate database from same file path
    const rehydratedDb = new OrquestDatabase(join(tempDir, "orquest.db"));
    const restartedDaemon = createDaemonServer({
      host: "127.0.0.1",
      port: 0,
      database: rehydratedDb,
      runner: new FakeAgyRunner(),
      token: "e2e-secret-token-789",
      allowedRoots: [tempDir],
    });
    const { port: newPort } = await restartedDaemon.start();

    // Point MCP server to restarted daemon
    const restartedMcpServer = createOrquestMcpServer({
      daemonUrl: `http://127.0.0.1:${newPort}`,
      token: "e2e-secret-token-789",
    });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await restartedMcpServer.connect(sTransport);
    const restartedClient = new Client({ name: "codex-restarted-client", version: "1.0.0" }, { capabilities: {} });
    await restartedClient.connect(cTransport);

    // Verify Job Alpha is recovered with status DONE and terminal summary intact
    const getJobResult = await restartedClient.callTool({
      name: "orquest_get_job",
      arguments: { jobId: jobAlphaId },
    });
    expect(getJobResult.isError).toBeFalsy();
    const retrievedJob = (getJobResult.structuredContent as { job: { id: string; status: string; result: { summary: string } | null } }).job;
    expect(retrievedJob.id).toBe(jobAlphaId);
    expect(retrievedJob.status).toBe("DONE");
    expect(retrievedJob.result?.summary).toContain("completed");

    // Clean up restarted daemon
    await restartedClient.close();
    await restartedDaemon.stop();
  });
});
