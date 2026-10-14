import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const stateRoot = process.env.ORQUEST_HOME ?? join(homedir(), "AppData", "Local", "OrquestBridge");
const launcherPath = join(stateRoot, "launcher.json");
const logDirectory = join(stateRoot, "logs");
const daemonEntry = join(repositoryRoot, "apps", "daemon", "src", "server.ts");
const dashboardEntry = join(repositoryRoot, "node_modules", "vite", "bin", "vite.js");
const tsxEntry = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function isReachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(750) });
    return true;
  } catch {
    return false;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLauncher() {
  if (!existsSync(launcherPath)) return null;
  try {
    const value = JSON.parse(readFileSync(launcherPath, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    return value;
  } catch {
    return null;
  }
}

const existing = readLauncher();
const retainedProcesses = {};
if (existing?.processes) {
  for (const [name, processInfo] of Object.entries(existing.processes)) {
    if (typeof processInfo?.pid === "number" && isRunning(processInfo.pid)) retainedProcesses[name] = processInfo;
  }
}
if (existsSync(launcherPath)) rmSync(launcherPath, { force: true });
const daemonAlreadyRunning = await isReachable("http://127.0.0.1:4317/health");
const dashboardAlreadyRunning = await isReachable("http://127.0.0.1:4318");
if (!existsSync(tsxEntry) || !existsSync(dashboardEntry)) {
  console.error("Dependencies are missing. Run npm.cmd install from the repository root first.");
  process.exit(1);
}

mkdirSync(logDirectory, { recursive: true });
const launchId = crypto.randomUUID();
const baseEnvironment = { ...process.env, ORQUEST_LAUNCH_ID: launchId };

function launch(name, args) {
  const logDescriptor = openSync(join(logDirectory, `${name}.log`), "a", 0o600);
  try {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: baseEnvironment,
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      windowsHide: true,
      shell: false,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(logDescriptor);
  }
}

const processes = { ...retainedProcesses };
if (!daemonAlreadyRunning) processes.daemon = { pid: launch("daemon", [tsxEntry, daemonEntry]), entry: daemonEntry };
if (!dashboardAlreadyRunning) processes.dashboard = { pid: launch("dashboard", [dashboardEntry, "--host", "127.0.0.1", "--port", "4318"]), entry: dashboardEntry };
if (daemonAlreadyRunning && dashboardAlreadyRunning && Object.keys(processes).length === 0) {
  console.log("Daemon and dashboard are already running outside this launcher; nothing was changed.");
  process.exit(0);
}
writeFileSync(launcherPath, JSON.stringify({
  version: 1,
  launchId,
  createdAt: new Date().toISOString(),
  repositoryRoot,
  processes,

}, null, 2), { encoding: "utf8", mode: 0o600 });

console.log(`Orquest launcher started missing local components (daemon: ${daemonAlreadyRunning ? "already running" : "started"}, dashboard: ${dashboardAlreadyRunning ? "already running" : "started"}).`);
console.log("Dashboard: http://127.0.0.1:4318");
console.log(`Logs and launcher state: ${stateRoot}`);
console.log("Use npm.cmd run stop:local to stop only these launcher-owned processes.");