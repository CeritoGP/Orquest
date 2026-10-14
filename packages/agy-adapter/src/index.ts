import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { JobResult, JobRecord } from "@orquest/contracts";
import { RunnerError, type JobRunner, type RunnerEvent } from "@orquest/core";

export interface AgyRunnerOptions {
  executable?: string;
  printTimeout?: string;
  sandbox?: boolean;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  killTimeoutMs?: number;
}

type AgyJson = Record<string, unknown>;
const EventSchema = z.object({ event: z.string().optional() }).passthrough();
const durationPattern = /^\d+(?:ms|[smhd])$/;

function isRecord(value: unknown): value is AgyJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function redactString(value: string): string {
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret|authorization|cookie)\s*[=:]\s*["']?)[^\s,;"'&]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

export function redactSecret(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecret);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(?:api[_-]?key|token|password|secret|authorization|cookie)/i.test(key) ? "[REDACTED]" : redactSecret(entry),
  ]));
}

export function resolveAgyExecutable(configured?: string): string {
  if (configured !== undefined) {
    if (!existsSync(configured)) {
      throw new RunnerError("Configured agy executable was not found. Set ORQUEST_AGY_EXECUTABLE to a valid path.", "EXECUTABLE_NOT_FOUND", true);
    }
    return configured;
  }
  const localAppData = process.env.LOCALAPPDATA;
  const installed = localAppData === undefined ? undefined : join(localAppData, "agy", "bin", "agy.exe");
  if (installed !== undefined && existsSync(installed)) return installed;
  return "agy";
}

export function buildAgyArguments(job: JobRecord, options: AgyRunnerOptions = {}): string[] {
  const timeout = options.printTimeout ?? "20m";
  if (!durationPattern.test(timeout)) throw new RunnerError("Invalid agy print timeout", "UNKNOWN_FAILURE");
  const mode = job.accessMode === "worktree" ? "accept-edits" : "plan";
  const args = ["-p", job.task, "--output-format", "stream-json", "--mode", mode, "--print-timeout", timeout];
  if (options.sandbox ?? true) args.push("--sandbox");
  if (job.conversationId !== null) args.push("--conversation", job.conversationId);
  if (job.model !== "auto") args.push("--model", job.model);
  if (job.agent !== undefined) args.push("--agent", job.agent);
  if (job.model === "auto" || !/-(?:low|medium|high|max)$/i.test(job.model)) args.push("--effort", job.effort);
  return args;
}

export function normalizeAgyEvent(payload: AgyJson, conversationId?: string): RunnerEvent {
  const event = text(payload.event) ?? "unknown";
  if (event === "init") {
    return { id: `agy:${conversationId ?? "unknown"}:init`, kind: "job.progress", message: "Antigravity worker initialized", payload: { conversationId, raw: payload } };
  }
  if (event === "subagent_info" && isRecord(payload.subagent_info)) {
    const info = payload.subagent_info;
    const name = text(info.name) ?? text(info.agent_name) ?? text(info.id) ?? "Antigravity subagent";
    const state = text(info.state) ?? text(info.status);
    return {
      id: `agy:${conversationId ?? "unknown"}:subagent:${text(info.id) ?? name}:${state ?? "updated"}`,
      kind: "job.progress",
      message: `Subagent ${name}${state === undefined ? " updated" : `: ${state}`}`,
      payload: {
        conversationId,
        subagent: {
          id: text(info.id) ?? null,
          name,
          state: state ?? null,
          model: text(info.model) ?? null,
        },
        raw: payload,
      },
    };
  }  if (event === "step_update" && isRecord(payload.step_update)) {
    const step = payload.step_update;
    const stepType = text(step.step_type) ?? "unknown";
    const state = text(step.state) ?? "unknown";
    const stepId = `agy:${conversationId ?? "unknown"}:${String(step.step_index ?? "unknown")}:${state}`;
    if (stepType === "tool") return { id: stepId, kind: "job.tool", message: text(step.tool_name) ?? "Antigravity tool", payload: { conversationId, state, tool: step.tool_name, detail: step.tool_info ?? {}, raw: payload } };
    if (stepType === "agent_response") return { id: stepId, kind: "job.message", message: text(step.text_delta) ?? "", payload: { conversationId, state, usage: step.usage ?? {}, durationSeconds: step.duration_seconds, raw: payload } };
    return { id: stepId, kind: "job.progress", message: `Antigravity ${stepType} ${state}`, payload: { conversationId, stepType, state, raw: payload } };
  }
  return { kind: "job.progress", message: `Antigravity event: ${event}`, payload: { conversationId, raw: payload } };
}

export function toolFailureFromPayload(payload: AgyJson): string | undefined {
  if (payload.event !== "step_update" || !isRecord(payload.step_update)) return undefined;
  const step = payload.step_update;
  if (text(step.step_type) !== "tool" || !isRecord(step.tool_info)) return undefined;
  const error = step.tool_info.error;
  if (error === undefined || error === null) return undefined;
  const message = typeof error === "string" ? error : isRecord(error) ? text(error.message) ?? text(error.type) : undefined;
  return redactString(`${text(step.tool_name) ?? "Antigravity tool"} failed: ${message ?? "unknown tool error"}`);
}

export function resultFromPayload(payload: AgyJson, fallbackConversationId?: string, incompleteToolFailure?: string): JobResult {
  if (!isRecord(payload.result)) throw new RunnerError("Antigravity result event has no result object", "UNKNOWN_FAILURE");
  const result = payload.result;
  if (text(result.status) !== "SUCCESS") throw new RunnerError(redactString(text(result.error) ?? "Antigravity reported an unsuccessful result"), "UNKNOWN_FAILURE");
  const response = text(result.response);
  if (response === undefined && incompleteToolFailure !== undefined) {
    throw new RunnerError(`Antigravity reported success without a summary after ${incompleteToolFailure}`, "UNKNOWN_FAILURE", true);
  }
  return { summary: redactString(response ?? "Antigravity completed without a text summary."), tests: [], filesChanged: [], risks: [], conversationId: text(result.conversation_id) ?? fallbackConversationId };
}

function classifyFailure(stderr: string, code: number | null): RunnerError {
  const diagnostic = stderr.toLowerCase();
  if (diagnostic.includes("not logged") || diagnostic.includes("token source") || diagnostic.includes("authentication")) return new RunnerError("Antigravity authentication is required. Run agy interactively to authenticate.", "AUTH_REQUIRED", true);
  if (diagnostic.includes("quota") || diagnostic.includes("rate limit") || diagnostic.includes("429")) return new RunnerError("Antigravity quota or rate limit reached.", "QUOTA_EXCEEDED", true);
  if (diagnostic.includes("print timeout") || diagnostic.includes("timed out")) return new RunnerError("Antigravity print timeout expired.", "PRINT_TIMEOUT");
  return new RunnerError(`Antigravity exited without a successful result (code ${code ?? "unknown"}). ${stderr.slice(-500)}`, "UNKNOWN_FAILURE");
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.pid === undefined) { reject(new RunnerError("Antigravity process has no PID to terminate", "CANCEL_TIMEOUT")); return; }
    const timer = setTimeout(() => reject(new RunnerError("Antigravity process termination was not confirmed", "CANCEL_TIMEOUT")), timeoutMs);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
      killer.once("error", () => { try { child.kill(); } catch { /* close handler or timeout resolves */ } });
    } else {
      try { child.kill("SIGTERM"); } catch { /* close handler or timeout resolves */ }
    }
  });
}

export class AgyRunner implements JobRunner {
  readonly #options: AgyRunnerOptions;
  constructor(options: AgyRunnerOptions = {}) { this.#options = options; }

  execute(job: JobRecord, emit: (event: RunnerEvent) => void, signal: AbortSignal): Promise<JobResult> {
    const executionPath = job.worktreePath ?? job.workspacePath;
    if (executionPath === null) return Promise.reject(new RunnerError("Worktree job is missing its isolated execution path", "UNKNOWN_FAILURE", true));
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(resolveAgyExecutable(this.#options.executable), buildAgyArguments(job, this.#options), { cwd: executionPath, shell: false, windowsHide: true, stdio: "pipe" });
      } catch (error) {
        reject(error); return;
      }
      const maxLineBytes = this.#options.maxLineBytes ?? 4 * 1024 * 1024;
      const maxStderrBytes = this.#options.maxStderrBytes ?? 64 * 1024;
      let stdout = "";
      let stdoutBytes = 0;
      let discardStdout = false;
      let stderr = "";
      let stderrPartial = "";
      let stderrBytes = 0;
      let pendingResult: JobResult | null = null;
      let incompleteToolFailure: string | undefined;
      let conversationId = job.conversationId ?? undefined;
      let settled = false;
      let aborting = false;
      const settle = (callback: () => void): void => { if (!settled) { settled = true; signal.removeEventListener("abort", onAbort); callback(); } };
      const onAbort = (): void => { aborting = true; void terminateProcessTree(child, this.#options.killTimeoutMs ?? 5_000).then(() => settle(() => reject(new DOMException("Antigravity job canceled", "AbortError"))), (error: unknown) => settle(() => reject(error))); };
      const consume = (line: string): void => {
        if (line.trim().length === 0 || settled) return;
        let decoded: unknown;
        try { decoded = JSON.parse(line); } catch { emit({ kind: "job.progress", message: "Malformed Antigravity NDJSON ignored", payload: { raw: redactString(line.slice(0, 1_000)) } }); return; }
        const parsed = EventSchema.safeParse(decoded);
        if (!parsed.success || !isRecord(parsed.data)) { emit({ kind: "job.progress", message: "Malformed Antigravity NDJSON ignored", payload: { raw: redactString(line.slice(0, 1_000)) } }); return; }
        const payload = redactSecret(parsed.data) as AgyJson;
        const candidate = text(payload.conversation_id) ?? (isRecord(payload.step_update) ? text(payload.step_update.conversation_id) : undefined);
        if (candidate !== undefined && candidate !== conversationId) { conversationId = candidate; emit({ kind: "job.progress", message: "Conversation ID established", payload: { conversationId } }); }
        const toolFailure = toolFailureFromPayload(payload);
        if (toolFailure !== undefined) incompleteToolFailure = toolFailure;
        if (payload.event === "result") { try { pendingResult = resultFromPayload(payload, conversationId, incompleteToolFailure); } catch (error) { settle(() => reject(error)); } return; }
        emit(normalizeAgyEvent(payload, conversationId));
      };
      const processStdout = (chunk: string): void => {
        let rest = chunk;
        while (rest.length > 0) {
          const index = rest.indexOf("\n"); const segment = index < 0 ? rest : rest.slice(0, index); const bytes = Buffer.byteLength(segment);
          if (discardStdout) { if (index < 0) return; discardStdout = false; rest = rest.slice(index + 1); continue; }
          if (stdoutBytes + bytes > maxLineBytes) { stdout = ""; stdoutBytes = 0; discardStdout = index < 0; emit({ kind: "job.progress", message: "Oversized Antigravity NDJSON line discarded", payload: { warning: "LINE_TOO_LARGE" } }); if (index < 0) return; rest = rest.slice(index + 1); continue; }
          stdout += segment; stdoutBytes += bytes;
          if (index < 0) return;
          const line = stdout.endsWith("\r") ? stdout.slice(0, -1) : stdout; stdout = ""; stdoutBytes = 0; consume(line); rest = rest.slice(index + 1);
        }
      };
      const flushStderr = (): void => { if (stderrPartial.length === 0) return; const line = redactString(stderrPartial.slice(0, 1_000)); stderrPartial = ""; emit({ kind: "job.progress", message: `agy diagnostic: ${line}`, payload: {} }); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8"); child.stdout.on("data", processStdout);
      child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { let rest = chunk; while (rest.length > 0) { const index = rest.indexOf("\n"); const part = index < 0 ? rest : rest.slice(0, index); if (stderrBytes < maxStderrBytes) { const redacted = redactString(part); const accepted = redacted.slice(0, Math.max(0, maxStderrBytes - stderrBytes)); stderr += accepted; stderrBytes += Buffer.byteLength(accepted); stderrPartial += accepted; if (index >= 0) flushStderr(); } if (index < 0) return; rest = rest.slice(index + 1); } });
      child.once("error", (error) => settle(() => reject(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT" ? new RunnerError("Antigravity executable was not found", "EXECUTABLE_NOT_FOUND", true) : error)));
      child.once("close", (code) => { if (stdout.length > 0) consume(stdout); flushStderr(); if (settled || aborting) return; if (pendingResult !== null && code === 0) { settle(() => resolve(pendingResult as JobResult)); return; } settle(() => reject(classifyFailure(stderr, code))); });
    });
  }
}