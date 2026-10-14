import { spawn } from "node:child_process";
import type { JobResult } from "@orquest/contracts";

export interface VerificationCommand {
  executable: string;
  args: string[];
}

export function parseVerificationCommand(command: string): VerificationCommand {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (/^npm(?:\.cmd)? (?:test|run (?:test|lint|build))$/i.test(normalized)) {
    return {
      executable: process.platform === "win32" ? "npm.cmd" : "npm",
      args: normalized.replace(/^npm(?:\.cmd)?\s+/i, "").split(" "),
    };
  }
  if (normalized === "git diff --check") return { executable: "git", args: ["diff", "--check"] };
  throw new Error(`Verification command is not allowed: ${command}`);
}

export async function runVerificationCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<JobResult["tests"][number]> {
  const parsed = parseVerificationCommand(command);
  return new Promise((resolve, reject) => {
    const child = spawn(parsed.executable, parsed.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    let output = "";
    let timedOut = false;
    const append = (value: string): void => {
      output = `${output}${value}`.slice(-64_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const abort = (): void => { child.kill(); };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      const suffix = timedOut ? `\nTimed out after ${timeoutMs}ms` : "";
      resolve({ command, status: code === 0 && !timedOut ? "passed" : "failed", output: `${output}${suffix}`.trim() });
    });
  });
}