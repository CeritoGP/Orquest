import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  EffortSchema,
  type Effort,
  type JobRecord,
  type JobResult,
  type MetadataSource,
  type ProviderMessageIdentity,
} from "@orquest/contracts";
import { RunnerError, type JobRunner, type RunnerEvent } from "@orquest/core";

export interface AgyRunnerOptions {
  executable?: string;
  printTimeout?: string;
  sandbox?: boolean;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  killTimeoutMs?: number;
}

export interface RuntimeExecutionMetadata {
  effectiveModel: string | null;
  effectiveEffort: Effort | null;
  source: MetadataSource;
}

export interface WorkerMessagePayload {
  messageKey: string;
  content: string;
  final: boolean;
  providerIdentity: ProviderMessageIdentity | null;
}

export interface AgyStreamSessionOptions {
  provider?: string;
  initialConversationId?: string | undefined;
}

export interface AgyStreamStepOutcome {
  events: RunnerEvent[];
  result?: JobResult;
}

type AgyJson = Record<string, unknown>;

const EventSchema = z.object({ event: z.string().optional() }).passthrough();
const durationPattern = /^\d+(?:ms|[smhd])$/;
const sensitiveKeyPattern =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|token|password|passwd|secret|authorization|cookie)/i;
const privateReasoningKeyPattern =
  /^(?:thought|thoughts|thought_delta|thought_signature|thinking|thinking_delta|thinking_content|reasoning|reasoning_delta|reasoning_content|private_reasoning|internal_thought|internal_monologue|chain_of_thought)$/i;
const privateReasoningTypePattern =
  /^(?:thought|thoughts|thinking|reasoning|private_reasoning|internal_thought|internal_monologue|chain_of_thought)$/i;
const nonConcreteModelPattern = /^(?:auto|default|unknown|none|unspecified|null)$/i;

export const NO_SUMMARY_FALLBACK = "Antigravity completed without a text summary.";

function isRecord(value: unknown): value is AgyJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function redactString(value: string): string {
  return value
    .replace(/((?:authorization)\s*[=:]\s*["']?Bearer\s+)[^\s,;"'&]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|token|password|passwd|secret|authorization|cookie)\s*[=:]\s*["']?)(?!Bearer\b|\[REDACTED\])[^\s,;"'&]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

export function isPrivateReasoningEvent(payload: Record<string, unknown>): boolean {
  const eventName = text(payload.event)?.trim();
  if (eventName !== undefined && privateReasoningTypePattern.test(eventName)) {
    return true;
  }
  if (payload.private === true || payload.visibility === "private" || payload.is_thought === true) {
    return true;
  }
  if (eventName === "step_update" && isRecord(payload.step_update)) {
    const step = payload.step_update;
    const stepType = text(step.step_type)?.trim();
    if (stepType !== undefined && privateReasoningTypePattern.test(stepType)) {
      return true;
    }
    if (step.private === true || step.visibility === "private" || step.is_thought === true) {
      return true;
    }
    if (stepType === "agent_response") {
      const hasPublicText =
        text(step.text_delta) !== undefined ||
        text(step.delta) !== undefined ||
        text(step.text) !== undefined ||
        text(step.response) !== undefined ||
        text(step.content) !== undefined;
      const hasPrivateField = Object.keys(step).some((key) => privateReasoningKeyPattern.test(key));
      if (!hasPublicText && hasPrivateField) {
        return true;
      }
    }
  }
  return false;
}

export function stripPrivateReasoning(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(isRecord(item) && isPrivateReasoningEvent(item)))
      .map(stripPrivateReasoning);
  }
  if (!isRecord(value)) return value;
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (privateReasoningKeyPattern.test(key)) continue;
    entries.push([key, stripPrivateReasoning(entry)]);
  }
  return Object.fromEntries(entries);
}

export function redactSecret(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(isRecord(item) && isPrivateReasoningEvent(item)))
      .map(redactSecret);
  }
  if (!isRecord(value)) return value;
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (privateReasoningKeyPattern.test(key)) continue;
    entries.push([
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactSecret(entry),
    ]);
  }
  return Object.fromEntries(entries);
}

function parseRuntimeModel(value: unknown): string | null {
  const candidate = text(value)?.trim();
  if (candidate === undefined || candidate.length === 0 || nonConcreteModelPattern.test(candidate)) {
    return null;
  }
  return redactString(candidate).slice(0, 160);
}

function parseRuntimeEffort(value: unknown): Effort | null {
  const candidate = text(value)?.trim().toLowerCase();
  if (candidate === undefined) return null;
  const parsed = EffortSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function extractRuntimeExecutionMetadata(payload: Record<string, unknown>): RuntimeExecutionMetadata {
  const eventName = text(payload.event);
  const step = eventName === "step_update" && isRecord(payload.step_update) ? payload.step_update : undefined;
  const result = eventName === "result" && isRecord(payload.result) ? payload.result : undefined;
  const initObj = isRecord(payload.init) ? payload.init : undefined;
  const metadataObj = isRecord(payload.metadata) ? payload.metadata : undefined;
  const stepUsage = step !== undefined && isRecord(step.usage) ? step.usage : undefined;
  const resultUsage = result !== undefined && isRecord(result.usage) ? result.usage : undefined;

  const topLevelModel =
    eventName === "subagent_info"
      ? null
      : (parseRuntimeModel(payload.effective_model) ??
        parseRuntimeModel(payload.effectiveModel) ??
        parseRuntimeModel(payload.model));

  const effectiveModel =
    parseRuntimeModel(result?.effective_model) ??
    parseRuntimeModel(result?.effectiveModel) ??
    parseRuntimeModel(result?.model) ??
    parseRuntimeModel(resultUsage?.effective_model) ??
    parseRuntimeModel(resultUsage?.model) ??
    parseRuntimeModel(step?.effective_model) ??
    parseRuntimeModel(step?.effectiveModel) ??
    parseRuntimeModel(step?.model) ??
    parseRuntimeModel(stepUsage?.effective_model) ??
    parseRuntimeModel(stepUsage?.model) ??
    parseRuntimeModel(initObj?.effective_model) ??
    parseRuntimeModel(initObj?.effectiveModel) ??
    parseRuntimeModel(initObj?.model) ??
    parseRuntimeModel(metadataObj?.effective_model) ??
    parseRuntimeModel(metadataObj?.effectiveModel) ??
    parseRuntimeModel(metadataObj?.model) ??
    topLevelModel;

  const topLevelEffort =
    eventName === "subagent_info"
      ? null
      : (parseRuntimeEffort(payload.effective_effort) ??
        parseRuntimeEffort(payload.effectiveEffort) ??
        parseRuntimeEffort(payload.effort) ??
        parseRuntimeEffort(payload.reasoning_effort));

  const effectiveEffort =
    parseRuntimeEffort(result?.effective_effort) ??
    parseRuntimeEffort(result?.effectiveEffort) ??
    parseRuntimeEffort(result?.effort) ??
    parseRuntimeEffort(result?.reasoning_effort) ??
    parseRuntimeEffort(resultUsage?.effective_effort) ??
    parseRuntimeEffort(resultUsage?.effort) ??
    parseRuntimeEffort(step?.effective_effort) ??
    parseRuntimeEffort(step?.effectiveEffort) ??
    parseRuntimeEffort(step?.effort) ??
    parseRuntimeEffort(step?.reasoning_effort) ??
    parseRuntimeEffort(stepUsage?.effective_effort) ??
    parseRuntimeEffort(stepUsage?.effort) ??
    parseRuntimeEffort(initObj?.effective_effort) ??
    parseRuntimeEffort(initObj?.effectiveEffort) ??
    parseRuntimeEffort(initObj?.effort) ??
    parseRuntimeEffort(metadataObj?.effective_effort) ??
    parseRuntimeEffort(metadataObj?.effectiveEffort) ??
    parseRuntimeEffort(metadataObj?.effort) ??
    topLevelEffort;

  const source: MetadataSource = effectiveModel !== null || effectiveEffort !== null ? "runtime" : "unknown";
  return { effectiveModel, effectiveEffort, source };
}

export function extractProviderMessageIdentity(
  payload: Record<string, unknown>,
  provider = "agy",
  fallbackConversationId?: string,
  fallbackTurnId?: string,
): ProviderMessageIdentity | null {
  const step = isRecord(payload.step_update) ? payload.step_update : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  const initObj = isRecord(payload.init) ? payload.init : undefined;

  const conversationId =
    text(payload.conversation_id) ??
    text(payload.conversationId) ??
    text(step?.conversation_id) ??
    text(step?.conversationId) ??
    text(result?.conversation_id) ??
    text(result?.conversationId) ??
    text(initObj?.conversation_id) ??
    text(initObj?.conversationId) ??
    fallbackConversationId ??
    null;

  const turnId =
    text(payload.turn_id) ??
    text(payload.turnId) ??
    text(step?.turn_id) ??
    text(step?.turnId) ??
    text(result?.turn_id) ??
    text(result?.turnId) ??
    text(initObj?.turn_id) ??
    text(initObj?.turnId) ??
    fallbackTurnId ??
    null;

  const messageId =
    text(payload.message_id) ??
    text(payload.messageId) ??
    text(step?.message_id) ??
    text(step?.messageId) ??
    text(result?.message_id) ??
    text(result?.messageId) ??
    null;

  if (conversationId === null && turnId === null && messageId === null) {
    return null;
  }

  return {
    provider,
    conversationId: redactString(conversationId),
    turnId: turnId !== null ? redactString(turnId) : null,
    messageId: messageId !== null ? redactString(messageId) : null,
  };
}

export function mergeProviderIdentity(
  current: ProviderMessageIdentity | null,
  incoming: ProviderMessageIdentity | null,
): ProviderMessageIdentity | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  return {
    provider: incoming.provider || current.provider,
    conversationId: current.conversationId ?? incoming.conversationId ?? null,
    turnId: current.turnId ?? incoming.turnId ?? null,
    messageId: current.messageId ?? incoming.messageId ?? null,
  };
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
  const sanitized = redactSecret(stripPrivateReasoning(payload)) as AgyJson;
  const event = text(sanitized.event) ?? "unknown";
  const resolvedConv =
    text(sanitized.conversation_id) ??
    text(sanitized.conversationId) ??
    (isRecord(sanitized.step_update) ? (text(sanitized.step_update.conversation_id) ?? text(sanitized.step_update.conversationId)) : undefined) ??
    conversationId;
  const executionMetadata = extractRuntimeExecutionMetadata(sanitized);
  const metadataSpread = executionMetadata.source === "runtime" ? { executionMetadata } : {};

  if (event === "init") {
    return {
      id: `agy:${resolvedConv ?? "unknown"}:init`,
      kind: "job.progress",
      message: "Antigravity worker initialized",
      payload: { conversationId: resolvedConv, ...metadataSpread, raw: sanitized },
    };
  }
  if (event === "subagent_info" && isRecord(sanitized.subagent_info)) {
    const info = sanitized.subagent_info;
    const name = text(info.name) ?? text(info.agent_name) ?? text(info.id) ?? "Antigravity subagent";
    const state = text(info.state) ?? text(info.status);
    return {
      id: `agy:${resolvedConv ?? "unknown"}:subagent:${text(info.id) ?? name}:${state ?? "updated"}`,
      kind: "job.progress",
      message: `Subagent ${name}${state === undefined ? " updated" : `: ${state}`}`,
      payload: {
        conversationId: resolvedConv,
        subagent: {
          id: text(info.id) ?? null,
          name,
          state: state ?? null,
          model: text(info.model) ?? null,
        },
        raw: sanitized,
      },
    };
  }
  if (event === "step_update" && isRecord(sanitized.step_update)) {
    const step = sanitized.step_update;
    const stepType = text(step.step_type) ?? "unknown";
    const state = text(step.state) ?? "unknown";
    const stepId = `agy:${resolvedConv ?? "unknown"}:${String(step.step_index ?? "unknown")}:${state}`;
    if (stepType === "tool") {
      return {
        id: stepId,
        kind: "job.tool",
        message: text(step.tool_name) ?? "Antigravity tool",
        payload: { conversationId: resolvedConv, state, tool: step.tool_name, detail: step.tool_info ?? {}, ...metadataSpread, raw: sanitized },
      };
    }
    if (stepType === "agent_response") {
      const content = text(step.text_delta) ?? text(step.delta) ?? text(step.text) ?? text(step.response) ?? text(step.content) ?? "";
      const msgId = text(step.message_id) ?? text(step.messageId);
      const stepIdx = step.step_index !== undefined && step.step_index !== null ? String(step.step_index) : undefined;
      const messageKey = msgId !== undefined ? `msg:${msgId}` : stepIdx !== undefined ? `step:${stepIdx}` : "response:default";
      const isDone = state.toUpperCase() === "DONE" || state.toUpperCase() === "COMPLETED" || step.final === true;
      const providerIdentity = extractProviderMessageIdentity(sanitized, "agy", resolvedConv);
      return {
        id: stepId,
        kind: "job.message",
        message: content,
        payload: {
          conversationId: resolvedConv,
          state,
          usage: step.usage ?? {},
          durationSeconds: step.duration_seconds,
          ...metadataSpread,
          workerMessage: {
            messageKey,
            content,
            final: isDone,
            providerIdentity,
          } satisfies WorkerMessagePayload,
          raw: sanitized,
        },
      };
    }
    return {
      id: stepId,
      kind: "job.progress",
      message: `Antigravity ${stepType} ${state}`,
      payload: { conversationId: resolvedConv, stepType, state, ...metadataSpread, raw: sanitized },
    };
  }
  return {
    kind: "job.progress",
    message: `Antigravity event: ${event}`,
    payload: { conversationId: resolvedConv, ...metadataSpread, raw: sanitized },
  };
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

export function resultFromPayload(
  payload: AgyJson,
  fallbackConversationId?: string,
  incompleteToolFailure?: string,
  streamedSummary?: string,
): JobResult {
  if (!isRecord(payload.result)) throw new RunnerError("Antigravity result event has no result object", "UNKNOWN_FAILURE");
  const result = payload.result;
  if (text(result.status) !== "SUCCESS") {
    throw new RunnerError(redactString(text(result.error) ?? "Antigravity reported an unsuccessful result"), "UNKNOWN_FAILURE");
  }
  const response = text(result.response) ?? text(result.summary);
  if (response === undefined && incompleteToolFailure !== undefined) {
    throw new RunnerError(`Antigravity reported success without a summary after ${incompleteToolFailure}`, "UNKNOWN_FAILURE", true);
  }
  const resolvedSummary = response ?? (streamedSummary !== undefined && streamedSummary.trim().length > 0 ? streamedSummary : undefined);
  const conversationId = text(result.conversation_id) ?? text(result.conversationId) ?? fallbackConversationId;
  return {
    summary: redactString(resolvedSummary ?? NO_SUMMARY_FALLBACK),
    tests: [],
    filesChanged: [],
    risks: [],
    ...(conversationId !== undefined ? { conversationId: redactString(conversationId) } : {}),
  };
}

interface InternalMessageEntry {
  messageKey: string;
  content: string;
  final: boolean;
  providerIdentity: ProviderMessageIdentity | null;
  seenDeltas: Set<string>;
  stateCounts: Map<string, number>;
}

/**
 * Reconciles fragmented deltas, snapshots, repeated stream events, runtime
 * execution metadata, and final results for a single worker execution.
 */
export class AgyStreamSession {
  readonly #provider: string;
  #conversationId: string | undefined;
  #turnId: string | undefined;
  #effectiveModel: string | null = null;
  #effectiveEffort: Effort | null = null;
  #executionMetadataSource: MetadataSource = "unknown";
  #incompleteToolFailure: string | undefined;
  #pendingResult: JobResult | null = null;
  readonly #messages = new Map<string, InternalMessageEntry>();
  readonly #stepToMessageKey = new Map<string, string>();
  readonly #seenNonMessageSignatures = new Set<string>();
  #lastMessageKey: string | null = null;

  constructor(options: AgyStreamSessionOptions = {}) {
    this.#provider = options.provider ?? "agy";
    this.#conversationId = options.initialConversationId;
  }

  get conversationId(): string | undefined {
    return this.#conversationId;
  }

  get turnId(): string | undefined {
    return this.#turnId;
  }

  get executionMetadata(): RuntimeExecutionMetadata {
    return {
      effectiveModel: this.#effectiveModel,
      effectiveEffort: this.#effectiveEffort,
      source: this.#executionMetadataSource,
    };
  }

  get pendingResult(): JobResult | null {
    return this.#pendingResult;
  }

  getReconciledMessages(): WorkerMessagePayload[] {
    return [...this.#messages.values()]
      .filter((entry) => entry.content.trim().length > 0)
      .map((entry) => ({
        messageKey: entry.messageKey,
        content: entry.content,
        final: entry.final,
        providerIdentity: entry.providerIdentity,
      }));
  }

  consumePayload(rawPayload: Record<string, unknown>): AgyStreamStepOutcome {
    if (isPrivateReasoningEvent(rawPayload)) {
      return { events: [] };
    }

    const payload = redactSecret(stripPrivateReasoning(rawPayload)) as AgyJson;
    const events: RunnerEvent[] = [];

    const prevMeta = this.executionMetadata;
    const extractedMeta = extractRuntimeExecutionMetadata(payload);
    if (extractedMeta.effectiveModel !== null) {
      this.#effectiveModel = extractedMeta.effectiveModel;
      this.#executionMetadataSource = "runtime";
    }
    if (extractedMeta.effectiveEffort !== null) {
      this.#effectiveEffort = extractedMeta.effectiveEffort;
      this.#executionMetadataSource = "runtime";
    }
    const metadataChanged =
      this.#effectiveModel !== prevMeta.effectiveModel ||
      this.#effectiveEffort !== prevMeta.effectiveEffort;

    const candidateConv =
      text(payload.conversation_id) ??
      text(payload.conversationId) ??
      (isRecord(payload.step_update) ? (text(payload.step_update.conversation_id) ?? text(payload.step_update.conversationId)) : undefined) ??
      (isRecord(payload.result) ? (text(payload.result.conversation_id) ?? text(payload.result.conversationId)) : undefined) ??
      (isRecord(payload.init) ? (text(payload.init.conversation_id) ?? text(payload.init.conversationId)) : undefined);

    const prevConv = this.#conversationId;
    if (candidateConv !== undefined && candidateConv !== this.#conversationId) {
      this.#conversationId = candidateConv;
      events.push({
        id: `agy:${candidateConv}:conversation`,
        kind: "job.progress",
        message: "Conversation ID established",
        payload: {
          conversationId: candidateConv,
          ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
          ...(this.#executionMetadataSource === "runtime" ? { executionMetadata: this.executionMetadata } : {}),
        },
      });
    }

    const candidateTurn =
      text(payload.turn_id) ??
      text(payload.turnId) ??
      (isRecord(payload.step_update) ? (text(payload.step_update.turn_id) ?? text(payload.step_update.turnId)) : undefined) ??
      (isRecord(payload.result) ? (text(payload.result.turn_id) ?? text(payload.result.turnId)) : undefined) ??
      (isRecord(payload.init) ? (text(payload.init.turn_id) ?? text(payload.init.turnId)) : undefined);
    const prevTurn = this.#turnId;
    if (candidateTurn !== undefined) {
      this.#turnId = candidateTurn;
    }

    const toolFailure = toolFailureFromPayload(payload);
    if (toolFailure !== undefined) {
      this.#incompleteToolFailure = toolFailure;
    }

    if (payload.event === "result") {
      const lastEntry = this.#lastMessageKey !== null ? this.#messages.get(this.#lastMessageKey) : undefined;
      const result = resultFromPayload(payload, this.#conversationId, this.#incompleteToolFailure, lastEntry?.content);
      this.#pendingResult = result;

      const resultObj = isRecord(payload.result) ? payload.result : {};
      const rawResponse = text(resultObj.response) ?? text(resultObj.summary);
      const resultIdentity = extractProviderMessageIdentity(payload, this.#provider, this.#conversationId, this.#turnId);

      if (rawResponse !== undefined) {
        this.#incompleteToolFailure = undefined;
        const finalContent = redactString(rawResponse);
        const msgIdKey =
          resultIdentity?.messageId !== null && resultIdentity?.messageId !== undefined
            ? `msg:${resultIdentity.messageId}`
            : undefined;
        const targetKey =
          msgIdKey !== undefined && this.#messages.has(msgIdKey)
            ? msgIdKey
            : this.#lastMessageKey ?? msgIdKey ?? "result:final";

        const existing = this.#messages.get(targetKey);
        if (existing !== undefined) {
          const prevContent = existing.content;
          const prevIdentityJson = JSON.stringify(existing.providerIdentity);
          if (existing.content.length === 0 || finalContent.startsWith(existing.content) || !existing.content.startsWith(finalContent)) {
            existing.content = finalContent;
          }
          existing.providerIdentity = mergeProviderIdentity(existing.providerIdentity, resultIdentity);
          existing.final = true;
          this.#lastMessageKey = targetKey;

          if (existing.content !== prevContent || JSON.stringify(existing.providerIdentity) !== prevIdentityJson || metadataChanged) {
            events.push({
              id: `agy:${this.#conversationId ?? "unknown"}:${targetKey}:final`,
              kind: "job.message",
              message: existing.content,
              payload: {
                conversationId: this.#conversationId,
                ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
                state: "DONE",
                ...(this.#executionMetadataSource === "runtime" ? { executionMetadata: this.executionMetadata } : {}),
                workerMessage: {
                  messageKey: existing.messageKey,
                  content: existing.content,
                  final: true,
                  providerIdentity: existing.providerIdentity,
                } satisfies WorkerMessagePayload,
                raw: payload,
              },
            });
          }
        } else if (finalContent.trim().length > 0) {
          const entry: InternalMessageEntry = {
            messageKey: targetKey,
            content: finalContent,
            final: true,
            providerIdentity: resultIdentity,
            seenDeltas: new Set([`done:${finalContent}`]),
            stateCounts: new Map([["DONE", 1]]),
          };
          this.#messages.set(targetKey, entry);
          this.#lastMessageKey = targetKey;
          events.push({
            id: `agy:${this.#conversationId ?? "unknown"}:${targetKey}:final`,
            kind: "job.message",
            message: finalContent,
            payload: {
              conversationId: this.#conversationId,
              ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
              state: "DONE",
              ...(this.#executionMetadataSource === "runtime" ? { executionMetadata: this.executionMetadata } : {}),
              workerMessage: {
                messageKey: entry.messageKey,
                content: entry.content,
                final: true,
                providerIdentity: entry.providerIdentity,
              } satisfies WorkerMessagePayload,
              raw: payload,
            },
          });
        }
      } else if (lastEntry !== undefined) {
        const prevIdentityJson = JSON.stringify(lastEntry.providerIdentity);
        lastEntry.providerIdentity = mergeProviderIdentity(lastEntry.providerIdentity, resultIdentity);
        lastEntry.final = true;
        if (JSON.stringify(lastEntry.providerIdentity) !== prevIdentityJson || metadataChanged) {
          events.push({
            id: `agy:${this.#conversationId ?? "unknown"}:${lastEntry.messageKey}:final`,
            kind: "job.message",
            message: lastEntry.content,
            payload: {
              conversationId: this.#conversationId,
              ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
              state: "DONE",
              ...(this.#executionMetadataSource === "runtime" ? { executionMetadata: this.executionMetadata } : {}),
              workerMessage: {
                messageKey: lastEntry.messageKey,
                content: lastEntry.content,
                final: true,
                providerIdentity: lastEntry.providerIdentity,
              } satisfies WorkerMessagePayload,
              raw: payload,
            },
          });
        }
      } else if (metadataChanged || this.#conversationId !== prevConv || this.#turnId !== prevTurn) {
        events.push({
          id: `agy:${this.#conversationId ?? "unknown"}:result-meta`,
          kind: "job.progress",
          message: "Antigravity result metadata recorded",
          payload: {
            conversationId: this.#conversationId,
            ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
            ...(this.#executionMetadataSource === "runtime" ? { executionMetadata: this.executionMetadata } : {}),
            raw: payload,
          },
        });
      }

      return { events, result };
    }

    if (payload.event === "step_update" && isRecord(payload.step_update) && text(payload.step_update.step_type) === "agent_response") {
      const stepEvent = this.#consumeAgentResponseStep(payload, payload.step_update);
      if (stepEvent !== null) {
        events.push(stepEvent);
      }
      return { events };
    }

    const normalized = normalizeAgyEvent(payload, this.#conversationId);
    const enrichedPayload: Record<string, unknown> = {
      ...(normalized.payload ?? {}),
      conversationId: this.#conversationId,
      ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
      ...(this.#executionMetadataSource === "runtime" ? { executionMetadata: this.executionMetadata } : {}),
    };
    const eventWithMeta: RunnerEvent = {
      ...normalized,
      payload: enrichedPayload,
    };
    const nonMsgSig = `${eventWithMeta.id ?? eventWithMeta.kind}:${eventWithMeta.message}`;
    if (!this.#seenNonMessageSignatures.has(nonMsgSig)) {
      this.#seenNonMessageSignatures.add(nonMsgSig);
      events.push(eventWithMeta);
    }

    return { events };
  }

  #consumeAgentResponseStep(payload: AgyJson, step: AgyJson): RunnerEvent | null {
    const msgId = text(step.message_id) ?? text(step.messageId) ?? text(payload.message_id) ?? text(payload.messageId);
    const stepIdx =
      step.step_index !== undefined && step.step_index !== null
        ? String(step.step_index)
        : step.stepIndex !== undefined && step.stepIndex !== null
          ? String(step.stepIndex)
          : undefined;

    let messageKey: string;
    if (stepIdx !== undefined && this.#stepToMessageKey.has(stepIdx)) {
      messageKey = this.#stepToMessageKey.get(stepIdx)!;
    } else if (msgId !== undefined) {
      messageKey = `msg:${msgId}`;
      if (stepIdx !== undefined) this.#stepToMessageKey.set(stepIdx, messageKey);
    } else if (stepIdx !== undefined) {
      messageKey = `step:${stepIdx}`;
      this.#stepToMessageKey.set(stepIdx, messageKey);
    } else if (this.#turnId !== undefined) {
      messageKey = `turn:${this.#turnId}`;
    } else {
      messageKey = "response:default";
    }

    const rawDelta = text(step.text_delta) ?? text(step.delta);
    const rawSnapshot = text(step.text) ?? text(step.response) ?? text(step.content);
    const deltaText = rawDelta !== undefined ? redactString(rawDelta) : undefined;
    const snapshotText = rawSnapshot !== undefined ? redactString(rawSnapshot) : undefined;
    const state = text(step.state) ?? "unknown";
    const isDone = state.toUpperCase() === "DONE" || state.toUpperCase() === "COMPLETED" || step.final === true;
    const explicitChunkId = step.delta_index ?? step.chunk_index ?? step.sequence ?? step.id ?? payload.id ?? payload.event_id;

    let entry = this.#messages.get(messageKey);
    if (entry === undefined) {
      entry = {
        messageKey,
        content: "",
        final: false,
        providerIdentity: null,
        seenDeltas: new Set(),
        stateCounts: new Map(),
      };
      this.#messages.set(messageKey, entry);
    }

    const deltaSig =
      explicitChunkId !== undefined && explicitChunkId !== null
        ? `chunk:${String(explicitChunkId)}`
        : isDone
          ? `done:${snapshotText ?? deltaText ?? ""}`
          : `delta:${state}:${deltaText ?? snapshotText ?? ""}`;

    if (entry.seenDeltas.has(deltaSig)) {
      return null;
    }
    if (entry.final && !isDone && (deltaText !== undefined ? entry.content.includes(deltaText) : true)) {
      return null;
    }

    entry.seenDeltas.add(deltaSig);

    if (snapshotText !== undefined) {
      if (entry.content.length === 0 || snapshotText.startsWith(entry.content)) {
        entry.content = snapshotText;
      } else if (!entry.content.endsWith(snapshotText) && snapshotText !== entry.content) {
        entry.content += snapshotText;
      }
    } else if (deltaText !== undefined) {
      if (isDone && entry.content.length > 0 && (deltaText === entry.content || entry.content.endsWith(deltaText))) {
        // Final step repeated accumulated text or trailing chunk
      } else if (isDone && entry.content.length > 0 && deltaText.startsWith(entry.content)) {
        entry.content = deltaText;
      } else {
        entry.content += deltaText;
      }
    }

    const stepIdentity = extractProviderMessageIdentity(payload, this.#provider, this.#conversationId, this.#turnId);
    entry.providerIdentity = mergeProviderIdentity(entry.providerIdentity, stepIdentity);
    entry.final = entry.final || isDone;

    if (entry.content.length === 0) {
      return null;
    }

    this.#incompleteToolFailure = undefined;
    this.#lastMessageKey = messageKey;

    const stateCount = (entry.stateCounts.get(state) ?? 0) + 1;
    entry.stateCounts.set(state, stateCount);
    const baseStepId = `agy:${this.#conversationId ?? "unknown"}:${String(step.step_index ?? messageKey)}:${state}`;
    const eventId = stateCount === 1 ? baseStepId : `${baseStepId}:${stateCount}`;

    return {
      id: eventId,
      kind: "job.message",
      message: deltaText ?? snapshotText ?? entry.content,
      payload: {
        conversationId: this.#conversationId,
        ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
        state,
        usage: step.usage ?? {},
        durationSeconds: step.duration_seconds,
        ...(this.#executionMetadataSource === "runtime" ? { executionMetadata: this.executionMetadata } : {}),
        workerMessage: {
          messageKey: entry.messageKey,
          content: entry.content,
          final: entry.final,
          providerIdentity: entry.providerIdentity,
        } satisfies WorkerMessagePayload,
        raw: payload,
      },
    };
  }
}

function classifyFailure(stderr: string, code: number | null): RunnerError {
  const diagnostic = stderr.toLowerCase();
  if (diagnostic.includes("not logged") || diagnostic.includes("token source") || diagnostic.includes("authentication")) {
    return new RunnerError("Antigravity authentication is required. Run agy interactively to authenticate.", "AUTH_REQUIRED", true);
  }
  if (diagnostic.includes("quota") || diagnostic.includes("rate limit") || diagnostic.includes("429")) {
    return new RunnerError("Antigravity quota or rate limit reached.", "QUOTA_EXCEEDED", true);
  }
  if (diagnostic.includes("print timeout") || diagnostic.includes("timed out")) {
    return new RunnerError("Antigravity print timeout expired.", "PRINT_TIMEOUT");
  }
  return new RunnerError(`Antigravity exited without a successful result (code ${code ?? "unknown"}). ${ redactString(stderr).slice(-500) }`, "UNKNOWN_FAILURE");
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.pid === undefined) {
      reject(new RunnerError("Antigravity process has no PID to terminate", "CANCEL_TIMEOUT"));
      return;
    }
    const timer = setTimeout(() => reject(new RunnerError("Antigravity process termination was not confirmed", "CANCEL_TIMEOUT")), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
      killer.once("error", () => {
        try {
          child.kill();
        } catch {
          /* close handler or timeout resolves */
        }
      });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        /* close handler or timeout resolves */
      }
    }
  });
}

export class AgyRunner implements JobRunner {
  readonly #options: AgyRunnerOptions;
  constructor(options: AgyRunnerOptions = {}) {
    this.#options = options;
  }

  execute(job: JobRecord, emit: (event: RunnerEvent) => void, signal: AbortSignal): Promise<JobResult> {
    const executionPath = job.worktreePath ?? job.workspacePath;
    if (executionPath === null) {
      return Promise.reject(new RunnerError("Worktree job is missing its isolated execution path", "UNKNOWN_FAILURE", true));
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(resolveAgyExecutable(this.#options.executable), buildAgyArguments(job, this.#options), {
          cwd: executionPath,
          shell: false,
          windowsHide: true,
          stdio: "pipe",
        });
      } catch (error) {
        reject(error);
        return;
      }
      const maxLineBytes = this.#options.maxLineBytes ?? 4 * 1024 * 1024;
      const maxStderrBytes = this.#options.maxStderrBytes ?? 64 * 1024;
      const session = new AgyStreamSession({
        provider: "agy",
        initialConversationId: job.conversationId ?? undefined,
      });
      let stdout = "";
      let stdoutBytes = 0;
      let discardStdout = false;
      let stderr = "";
      let stderrPartial = "";
      let stderrBytes = 0;
      let settled = false;
      let aborting = false;
      const settle = (callback: () => void): void => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          callback();
        }
      };
      const onAbort = (): void => {
        aborting = true;
        void terminateProcessTree(child, this.#options.killTimeoutMs ?? 5_000).then(
          () => settle(() => reject(new DOMException("Antigravity job canceled", "AbortError"))),
          (error: unknown) => settle(() => reject(error)),
        );
      };
      const consume = (line: string): void => {
        if (line.trim().length === 0 || settled || aborting) return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          emit({ kind: "job.progress", message: "Malformed Antigravity NDJSON ignored", payload: { raw: redactString(line.slice(0, 1_000)) } });
          return;
        }
        const parsed = EventSchema.safeParse(decoded);
        if (!parsed.success || !isRecord(parsed.data)) {
          emit({ kind: "job.progress", message: "Malformed Antigravity NDJSON ignored", payload: { raw: redactString(line.slice(0, 1_000)) } });
          return;
        }
        try {
          const outcome = session.consumePayload(parsed.data);
          for (const event of outcome.events) {
            if (settled || aborting) return;
            emit(event);
          }
        } catch (error) {
          settle(() => reject(error));
        }
      };
      const processStdout = (chunk: string): void => {
        let rest = chunk;
        while (rest.length > 0) {
          const index = rest.indexOf("\n");
          const segment = index < 0 ? rest : rest.slice(0, index);
          const bytes = Buffer.byteLength(segment);
          if (discardStdout) {
            if (index < 0) return;
            discardStdout = false;
            rest = rest.slice(index + 1);
            continue;
          }
          if (stdoutBytes + bytes > maxLineBytes) {
            stdout = "";
            stdoutBytes = 0;
            discardStdout = index < 0;
            emit({ kind: "job.progress", message: "Oversized Antigravity NDJSON line discarded", payload: { warning: "LINE_TOO_LARGE" } });
            if (index < 0) return;
            rest = rest.slice(index + 1);
            continue;
          }
          stdout += segment;
          stdoutBytes += bytes;
          if (index < 0) return;
          const line = stdout.endsWith("\r") ? stdout.slice(0, -1) : stdout;
          stdout = "";
          stdoutBytes = 0;
          consume(line);
          rest = rest.slice(index + 1);
        }
      };
      const flushStderr = (): void => {
        if (stderrPartial.length === 0 || settled || aborting) return;
        const line = redactString(stderrPartial.slice(0, 1_000));
        stderrPartial = "";
        emit({ kind: "job.progress", message: `agy diagnostic: ${line}`, payload: {} });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", processStdout);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        let rest = chunk;
        while (rest.length > 0) {
          const index = rest.indexOf("\n");
          const part = index < 0 ? rest : rest.slice(0, index);
          if (stderrBytes < maxStderrBytes) {
            const redacted = redactString(part);
            const accepted = redacted.slice(0, Math.max(0, maxStderrBytes - stderrBytes));
            stderr += accepted;
            stderrBytes += Buffer.byteLength(accepted);
            stderrPartial += accepted;
            if (index >= 0) flushStderr();
          }
          if (index < 0) return;
          rest = rest.slice(index + 1);
        }
      });
      child.once("error", (error) =>
        settle(() =>
          reject(
            error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
              ? new RunnerError("Antigravity executable was not found", "EXECUTABLE_NOT_FOUND", true)
              : error,
          ),
        ),
      );
      child.once("close", (code) => {
        if (stdout.length > 0 && !aborting) consume(stdout);
        flushStderr();
        if (settled || aborting) return;
        if (session.pendingResult !== null && code === 0) {
          settle(() => resolve(session.pendingResult as JobResult));
          return;
        }
        settle(() => reject(classifyFailure(stderr, code)));
      });
    });
  }
}