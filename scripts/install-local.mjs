import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const configDirectory = resolve(repositoryRoot, ".codex");
const configPath = resolve(configDirectory, "config.toml");
const templatePath = resolve(repositoryRoot, "config", "codex.example.toml");
const requiredEntries = [
  resolve(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  resolve(repositoryRoot, "packages", "mcp-server", "src", "server.ts"),
];

if (requiredEntries.some((entry) => !existsSync(entry))) {
  console.error("Dependencies or MCP sources are missing. Run npm.cmd install from the repository root first.");
  process.exit(1);
}

if (existsSync(configPath)) {
  console.log(`Codex project configuration already exists: ${configPath}`);
} else {
  mkdirSync(configDirectory, { recursive: true });
  copyFileSync(templatePath, configPath, 0);
  console.log(`Created Codex project configuration: ${configPath}`);
}

console.log("Local installation is ready. Start services with npm.cmd run start:local.");
console.log("The configuration contains no token; the MCP server resolves it from the local daemon token file.");