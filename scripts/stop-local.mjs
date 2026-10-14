import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const stateRoot = process.env.ORQUEST_HOME ?? join(homedir(), "AppData", "Local", "OrquestBridge");
const launcherPath = join(stateRoot, "launcher.json");

if (!existsSync(launcherPath)) {
  console.log("No Orquest launcher state was found; nothing was stopped.");
  process.exit(0);
}

let launcher;
try {
  launcher = JSON.parse(readFileSync(launcherPath, "utf8"));
} catch {
  console.error(`Refusing to read an invalid launcher state: ${launcherPath}`);
  process.exit(1);
}

function commandLineFor(pid) {
  if (process.platform !== "win32") return "";
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $args[0])).CommandLine",
    String(pid),
  ], { encoding: "utf8", windowsHide: true, shell: false });
  return result.status === 0 ? result.stdout.trim() : "";
}

function isOwnedProcess(info) {
  if (typeof info?.pid !== "number" || typeof info.entry !== "string") return false;
  try {
    process.kill(info.pid, 0);
  } catch {
    return false;
  }
  const commandLine = commandLineFor(info.pid);
  return commandLine.includes(info.entry);
}

const processes = launcher?.processes && typeof launcher.processes === "object" ? launcher.processes : {};
const remaining = {};
for (const [name, info] of Object.entries(processes)) {
  if (!isOwnedProcess(info)) {
    console.log(`${name}: not running or not owned by this launcher; left untouched.`);
    continue;
  }
  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`${name}: stop signal sent to PID ${info.pid}.`);
  } catch {
    remaining[name] = info;
  }
}

if (Object.keys(remaining).length === 0) {
  rmSync(launcherPath, { force: true });
  console.log("Launcher state removed. Persistent database, token and logs were preserved.");
} else {
  launcher.processes = remaining;
  console.error("Some launcher-owned processes could not be stopped; state was preserved for retry.");
  process.exitCode = 1;
}