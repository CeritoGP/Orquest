import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DefaultDaemonClient, type DaemonClient } from "./client.js";
import { MCP_INSTRUCTIONS, registerAllTools } from "./tools.js";

export interface OrquestMcpServerOptions {
  daemonClient?: DaemonClient | undefined;
  daemonUrl?: string | undefined;
  token?: string | undefined;
  tokenPath?: string | undefined;
  fetch?: typeof fetch | undefined;
  name?: string | undefined;
  version?: string | undefined;
}

export function createOrquestMcpServer(options: OrquestMcpServerOptions = {}): McpServer {
  const client: DaemonClient =
    options.daemonClient ??
    new DefaultDaemonClient({
      daemonUrl: options.daemonUrl,
      token: options.token,
      tokenPath: options.tokenPath,
      fetchFn: options.fetch,
    });

  const server = new McpServer(
    {
      name: options.name ?? "orquest-bridge",
      version: options.version ?? "0.1.0",
    },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );

  registerAllTools(server, client);

  return server;
}

const isMainScript =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js")) &&
  !process.argv.some((arg) => arg.includes("vitest"));

if (isMainScript) {
  try {
    const server = createOrquestMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Orquest MCP server running on stdio");
  } catch (error) {
    console.error("Failed to start Orquest MCP server:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}