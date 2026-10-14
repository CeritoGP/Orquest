import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const explicitPath = process.env.ORQUEST_AGY_EXECUTABLE;
const installedPath = process.env.LOCALAPPDATA === undefined
  ? undefined
  : join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");

for (const candidate of [explicitPath, installedPath]) {
  if (candidate !== undefined && existsSync(candidate)) {
    console.log(`Antigravity CLI: ${candidate}`);
    console.log("Status: installed (open an interactive agy session to authenticate)");
    const mcpEntry = join(import.meta.dirname, "..", "packages", "mcp-server", "src", "server.ts");
    console.log(`MCP server: ${existsSync(mcpEntry) ? "ready" : "missing"}`);
    process.exit(0);
  }
}

const pathCandidate = spawnSync("agy", ["--version"], { encoding: "utf8", windowsHide: true });
if (pathCandidate.status === 0) {
  console.log("Antigravity CLI: agy (PATH)");
  console.log(`Version: ${pathCandidate.stdout.trim()}`);
  process.exit(0);
}

console.log("Antigravity CLI (agy): not found");
console.log("Install it and authenticate with an interactive agy session before enabling ORQUEST_RUNNER=agy.");
process.exitCode = 1;