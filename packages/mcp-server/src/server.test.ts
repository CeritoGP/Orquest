import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  assertLoopbackUrl,
  createOrquestMcpServer,
  DefaultDaemonClient,
  MCP_INSTRUCTIONS,
  redactSecrets,
  resolveClientToken,
  TOOL_NAMES,
  type DaemonClient,
} from "./index.js";

describe("MCP server package manifest", () => {
  it("keeps its executable entrypoint in the package", async () => {
    const manifest = await import("../package.json", { with: { type: "json" } });
    expect(manifest.default.scripts.dev).toBe("tsx src/server.ts");
  });
});

describe("MCP instructions", () => {
  it("meets length and content requirements in the first 512 characters", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(512);
    const first512 = MCP_INSTRUCTIONS.slice(0, 512);
    expect(first512).toContain("127.0.0.1");
    expect(first512).toContain("local");
    expect(first512).toContain("safe");
    expect(first512).toContain("merge");
    expect(first512).toContain("push");
    expect(first512).toContain("deployment");
    expect(first512).toContain("permissions");
  });
});

describe("Client loopback & security", () => {
  it("accepts valid loopback URLs", () => {
    expect(assertLoopbackUrl("http://127.0.0.1:4317").hostname).toBe("127.0.0.1");
    expect(assertLoopbackUrl("http://localhost:4317").hostname).toBe("localhost");
    expect(assertLoopbackUrl("http://[::1]:4317").hostname).toBe("[::1]");

    const defaultClient = new DefaultDaemonClient();
    expect(defaultClient.baseUrl).toBe("http://127.0.0.1:4317");
  });

  it("rejects non-loopback URLs with a security violation error", () => {
    expect(() => assertLoopbackUrl("http://192.168.1.100:4317")).toThrow("Security violation");
    expect(() => assertLoopbackUrl("https://api.external.com")).toThrow("Security violation");
    expect(() => assertLoopbackUrl("http://10.0.0.1:4317")).toThrow("Security violation");
  });

  it("redacts sensitive tokens, passwords, and keys from strings", () => {
    const sensitive = "Error: Bearer secret_token_12345 failed, api_key=abc-def-ghi and password: supersecret";
    const redacted = redactSecrets(sensitive);
    expect(redacted).not.toContain("secret_token_12345");
    expect(redacted).not.toContain("abc-def-ghi");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).toContain("password=[REDACTED]");
  });

  it("redacts Authorization: Bearer, authorization=Bearer, and Bearer formats without leaving token behind [REDACTED]", () => {
    const testCases = [
      { input: "Authorization: Bearer synthetic-secret-value", expected: "Authorization: Bearer [REDACTED]" },
      { input: "authorization=Bearer synthetic-secret-value", expected: "authorization=Bearer [REDACTED]" },
      { input: "Bearer synthetic-secret-value", expected: "Bearer [REDACTED]" },
    ];

    for (const { input, expected } of testCases) {
      const redacted = redactSecrets(input);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("synthetic-secret-value");
      expect(redacted.endsWith("synthetic-secret-value")).toBe(false);
    }

    // Verify when embedded in larger error messages
    const complexError = "Failed: Authorization: Bearer synthetic-secret-value; token=fallback-token-456";
    const redactedComplex = redactSecrets(complexError);
    expect(redactedComplex).not.toContain("synthetic-secret-value");
    expect(redactedComplex).not.toContain("fallback-token-456");
    expect(redactedComplex).toContain("Authorization: Bearer [REDACTED]");
    expect(redactedComplex).toContain("token=[REDACTED]");
  });

  it("resolves token from options, env, or fallback safely", () => {
    expect(resolveClientToken({ explicitToken: "explicit-token-123" })).toBe("explicit-token-123");

    process.env.ORQUEST_DAEMON_TOKEN = "env-token-456";
    expect(resolveClientToken()).toBe("env-token-456");
    delete process.env.ORQUEST_DAEMON_TOKEN;

    // Gracefully returns null if file does not exist
    expect(resolveClientToken({ tokenPath: "non-existent-path/daemon.token" })).toBeNull();
  });
});

describe("MCP protocol: initialize & tool listing", () => {
  async function setupMcpClient(mockClient?: DaemonClient) {
    const dummyClient: DaemonClient = mockClient ?? {
      baseUrl: "http://127.0.0.1:4317",
      request: vi.fn().mockResolvedValue({ status: "ok", up: true }),
    };

    const server = createOrquestMcpServer({ daemonClient: dummyClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-codex", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    return { client, server, dummyClient };
  }

  it("registers exactly the 10 final tools and no obsolete alias", async () => {
    const { client } = await setupMcpClient();
    const result = await client.listTools();

    const toolNames = result.tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual([...TOOL_NAMES].sort());
    expect(toolNames).not.toContain("orquest_submit_job");
    expect(toolNames).toContain("orquest_submit_jobs");
  });

  it("applies correct safety annotations for reads, mutations, and cancellations", async () => {
    const { client } = await setupMcpClient();
    const result = await client.listTools();
    const toolMap = new Map(result.tools.map((t) => [t.name, t]));

    // Read tools must have readOnlyHint: true, destructiveHint: false, idempotentHint: true
    const readTools = [
      "orquest_health",
      "orquest_list_jobs",
      "orquest_get_job",
      "orquest_wait_job",
      "orquest_get_transcript",
      "orquest_get_diff",
    ];
    for (const name of readTools) {
      const tool = toolMap.get(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, `${name} should be readOnly`).toBe(true);
      expect(tool?.annotations?.destructiveHint, `${name} should not be destructive`).toBe(false);
      expect(tool?.annotations?.idempotentHint, `${name} should be idempotent`).toBe(true);
    }

    // Mutation tools: readOnlyHint: false, destructiveHint: false, idempotentHint: false
    const mutationTools = ["orquest_submit_jobs", "orquest_send_message", "orquest_retry_job"];
    for (const name of mutationTools) {
      const tool = toolMap.get(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, `${name} should not be readOnly`).toBe(false);
      expect(tool?.annotations?.destructiveHint, `${name} should not be destructive`).toBe(false);
      expect(tool?.annotations?.idempotentHint, `${name} should not be idempotent`).toBe(false);
    }

    // Cancel tool: readOnlyHint: false, destructiveHint: true, idempotentHint: true
    const cancelTool = toolMap.get("orquest_cancel_job");
    expect(cancelTool?.annotations?.readOnlyHint).toBe(false);
    expect(cancelTool?.annotations?.destructiveHint).toBe(true);
    expect(cancelTool?.annotations?.idempotentHint).toBe(true);
  });

  it("handles isError: true without leaking credentials when daemon request fails", async () => {
    const failingClient: DaemonClient = {
      baseUrl: "http://127.0.0.1:4317",
      request: vi
        .fn()
        .mockRejectedValue(new Error("Unauthorized: Authorization: Bearer synthetic-secret-xyz was rejected")),
    };

    const { client } = await setupMcpClient(failingClient);
    const result = await client.callTool({ name: "orquest_health", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const textContent = content[0];
    expect(textContent?.type).toBe("text");
    if (textContent?.type === "text" && textContent.text) {
      expect(textContent.text).toContain("[REDACTED]");
      expect(textContent.text).not.toContain("synthetic-secret-xyz");
      expect(textContent.text.endsWith("synthetic-secret-xyz")).toBe(false);
    }
  });

  describe("orquest_health tool contracts", () => {
    it("handles minimal unauthenticated health without status property", async () => {
      const unauthClient: DaemonClient = {
        baseUrl: "http://127.0.0.1:4317",
        request: vi.fn().mockResolvedValue({ up: true }),
      };

      const server = createOrquestMcpServer({ daemonClient: unauthClient });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-unauth", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({ name: "orquest_health", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ up: true });
      const text = (result.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("Orquest daemon health: up");
    });

    it("handles authenticated health response with status, runner and timestamp", async () => {
      const authClient: DaemonClient = {
        baseUrl: "http://127.0.0.1:4317",
        request: vi.fn().mockResolvedValue({
          status: "ok",
          up: true,
          runner: "fake-agy",
          timestamp: "2026-09-28T14:50:00.000Z",
        }),
      };

      const server = createOrquestMcpServer({ daemonClient: authClient });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-auth", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({ name: "orquest_health", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        status: "ok",
        up: true,
        runner: "fake-agy",
        timestamp: "2026-09-28T14:50:00.000Z",
      });
      const text = (result.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("Orquest daemon health: ok, runner: fake-agy");
    });

    it("handles invalid or malformed token returning 401 as isError: true with redacted error", async () => {
      const invalidClient: DaemonClient = {
        baseUrl: "http://127.0.0.1:4317",
        request: vi
          .fn()
          .mockRejectedValue(new Error("Unauthorized: Invalid or malformed authorization header (Bearer invalid-secret-token)")),
      };

      const server = createOrquestMcpServer({ daemonClient: invalidClient });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-invalid", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({ name: "orquest_health", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("Unauthorized: Invalid or malformed authorization header");
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("invalid-secret-token");
    });
  });

  it("enforces schema validation on input parameters", async () => {
    const { client } = await setupMcpClient();

    // Invalid UUID for orquest_get_job
    const invalidUuid = await client.callTool({ name: "orquest_get_job", arguments: { jobId: "not-a-uuid" } });
    expect(invalidUuid.isError).toBe(true);

    // Invalid batch size (empty array: min 1)
    const emptyBatch = await client.callTool({ name: "orquest_submit_jobs", arguments: { jobs: [] } });
    expect(emptyBatch.isError).toBe(true);

    // Invalid wait timeout (>60)
    const invalidTimeout = await client.callTool({
      name: "orquest_wait_job",
      arguments: { jobId: "60b74742-8f56-4598-b40f-e4d6d75afc0a", timeoutSeconds: 99 },
    });
    expect(invalidTimeout.isError).toBe(true);
  });

  it("calls orquest_wait_job with timeout exceeding 60 seconds", async () => {
    let capturedTimeoutMs: number | undefined;
    const trackingClient: DaemonClient = {
      baseUrl: "http://127.0.0.1:4317",
      request: vi.fn().mockImplementation((_path, _init, timeoutMs) => {
        capturedTimeoutMs = timeoutMs;
        return Promise.resolve({
          job: {
            id: "60b74742-8f56-4598-b40f-e4d6d75afc0a",
            title: "Wait job",
            task: "Task",
            workspacePath: "C:/work",
            profileId: "quick",
            accessMode: "read-only",
            model: "auto",
            effort: "medium",
            acceptanceCriteria: [],
            verificationCommands: [],
            priority: 50,
            status: "DONE",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            conversationId: null,
            errorCode: null,
            errorMessage: null,
            result: null,
          },
          timedOut: false,
          latestEventSequence: 5,
        });
      }),
    };

    const { client } = await setupMcpClient(trackingClient);
    const result = await client.callTool({
      name: "orquest_wait_job",
      arguments: { jobId: "60b74742-8f56-4598-b40f-e4d6d75afc0a", timeoutSeconds: 60 },
    });

    expect(result.isError).toBeFalsy();
    // 60s timeout in query -> client HTTP timeout must be > 60s (70_000ms)
    expect(capturedTimeoutMs).toBe(70_000);
    expect(capturedTimeoutMs).toBeGreaterThan(60_000);
  });

  it("ensures no console.log noise on stdout", async () => {
    const stdoutSpy = vi.spyOn(console, "log");
    const { client } = await setupMcpClient();
    await client.callTool({ name: "orquest_health", arguments: {} });
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});