import {
  EffortSchema,
  type Effort,
  type JobRecord,
  type JobResult,
  type MetadataSource,
  type ProviderMessageIdentity,
} from "@orquest/contracts";
import type { JobRunner, RunnerEvent } from "@orquest/core";

export interface FakeAgyScriptStep {
  id?: string;
  kind?: "job.progress" | "job.tool" | "job.message";
  message?: string;
  textDelta?: string;
  textSnapshot?: string;
  messageKey?: string;
  messageId?: string | null;
  turnId?: string | null;
  final?: boolean;
  privateReasoning?: boolean;
  thought?: string;
  repeat?: number;
  payload?: Record<string, unknown>;
}

export interface FakeAgyRunnerOptions {
  stepDelayMs?: number;
  provider?: string;
  unknownIdentity?: boolean;
  conversationId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
  reportedModel?: string | null;
  reportedEffort?: Effort | null;
  steps?: readonly FakeAgyScriptStep[];
  replayStream?: boolean;
  finalSummary?: string | null;
  holdUntilAbort?: boolean;
  onReadyForAbort?: (job: JobRecord) => void;
}

const nonConcreteModelPattern = /^(?:auto|default|unknown|none|unspecified|null)$/i;
const privateReasoningKeyPattern =
  /^(?:thought|thoughts|thought_delta|thought_signature|thinking|thinking_delta|thinking_content|reasoning|reasoning_delta|reasoning_content|private_reasoning|internal_thought|internal_monologue|chain_of_thought)$/i;
const sensitiveKeyPattern =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|token|password|passwd|secret|authorization|cookie)/i;

function redactFakeString(value: string): string {
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

function sanitizeFakeValue(value: unknown): unknown {
  if (typeof value === "string") return redactFakeString(value);
  if (Array.isArray(value)) return value.map(sanitizeFakeValue);
  if (typeof value !== "object" || value === null) return value;
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (privateReasoningKeyPattern.test(key)) continue;
    entries.push([key, sensitiveKeyPattern.test(key) ? "[REDACTED]" : sanitizeFakeValue(entry)]);
  }
  return Object.fromEntries(entries);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  }
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Operation aborted", "AbortError")),
      { once: true },
    );
  });
}

function normalizeReportedModel(model: string | null | undefined): string | null {
  if (model === undefined || model === null) return null;
  const trimmed = model.trim();
  if (trimmed.length === 0 || nonConcreteModelPattern.test(trimmed)) return null;
  return redactFakeString(trimmed).slice(0, 160);
}

function normalizeReportedEffort(effort: Effort | null | undefined): Effort | null {
  if (effort === undefined || effort === null) return null;
  const parsed = EffortSchema.safeParse(effort);
  return parsed.success ? parsed.data : null;
}

export class FakeAgyRunner implements JobRunner {
  readonly #options: FakeAgyRunnerOptions;

  constructor(options: FakeAgyRunnerOptions = {}) {
    this.#options = options;
  }

  async execute(job: JobRecord, emit: (event: RunnerEvent) => void, signal: AbortSignal): Promise<JobResult> {
    if (signal.aborted) {
      throw new DOMException("Operation aborted", "AbortError");
    }

    const stepDelayMs = this.#options.stepDelayMs ?? 180;
    const provider = this.#options.provider ?? "fake-agy";
    const unknownIdentity = this.#options.unknownIdentity === true;
    const conversationId = unknownIdentity
      ? null
      : this.#options.conversationId !== undefined
        ? this.#options.conversationId
        : (job.conversationId ?? `fake-${job.id}`);
    const defaultTurnId = unknownIdentity
      ? null
      : this.#options.turnId !== undefined
        ? this.#options.turnId
        : `fake-turn-${job.id}`;
    const defaultMessageId = unknownIdentity
      ? null
      : this.#options.messageId !== undefined
        ? this.#options.messageId
        : `fake-msg-${job.id}`;

    const effectiveModel = normalizeReportedModel(this.#options.reportedModel);
    const effectiveEffort = normalizeReportedEffort(this.#options.reportedEffort);
    const metadataSource: MetadataSource =
      effectiveModel !== null || effectiveEffort !== null ? "runtime" : "unknown";
    const executionMetadata = {
      effectiveModel,
      effectiveEffort,
      source: metadataSource,
    };

    const redactedTitle = redactFakeString(job.title);
    const defaultSteps: FakeAgyScriptStep[] = [
      {
        id: "accepted",
        kind: "job.message",
        messageKey: "turn-response",
        textDelta: `Worker accepted: ${redactedTitle}`,
        final: false,
      },
      {
        id: "inspect",
        kind: "job.progress",
        message: "Inspecting workspace and task constraints",
        payload: { percent: 25 },
      },
      {
        id: "read-files",
        kind: "job.tool",
        message: "read_files",
        payload: { tool: "read_files", files: ["README.md", "AGENTS.md"] },
      },
      {
        id: "handoff",
        kind: "job.progress",
        message: "Producing structured handoff",
        payload: { percent: 75 },
      },
    ];

    const configuredSteps = this.#options.steps ?? defaultSteps;
    const passCount = this.#options.replayStream === true ? 2 : 1;
    const messagesByKey = new Map<
      string,
      {
        messageKey: string;
        content: string;
        final: boolean;
        providerIdentity: ProviderMessageIdentity | null;
        seenStepSignatures: Set<string>;
        emitCount: number;
      }
    >();
    const seenEventIds = new Set<string>();
    let lastMessageKey: string | null = null;

    const buildIdentity = (
      stepTurnId?: string | null,
      stepMessageId?: string | null,
    ): ProviderMessageIdentity | null => {
      if (unknownIdentity) return null;
      const resolvedConv = conversationId !== null ? redactFakeString(conversationId) : null;
      const resolvedTurn =
        stepTurnId !== undefined
          ? (stepTurnId !== null ? redactFakeString(stepTurnId) : null)
          : (defaultTurnId !== null ? redactFakeString(defaultTurnId) : null);
      const resolvedMsg =
        stepMessageId !== undefined
          ? (stepMessageId !== null ? redactFakeString(stepMessageId) : null)
          : (defaultMessageId !== null ? redactFakeString(defaultMessageId) : null);
      if (resolvedConv === null && resolvedTurn === null && resolvedMsg === null) {
        return null;
      }
      return {
        provider,
        conversationId: resolvedConv,
        turnId: resolvedTurn,
        messageId: resolvedMsg,
      };
    };

    for (let pass = 0; pass < passCount; pass += 1) {
      for (const [stepIndex, step] of configuredSteps.entries()) {
        const repeatCount = Math.max(1, step.repeat ?? 1);
        for (let rep = 0; rep < repeatCount; rep += 1) {
          if (signal.aborted) {
            throw new DOMException("Operation aborted", "AbortError");
          }

          if (step.privateReasoning === true) {
            await wait(stepDelayMs, signal);
            continue;
          }

          const kind = step.kind ?? "job.message";
          const rawStepPayload = {
            ...(step.payload ?? {}),
            ...(step.thought !== undefined ? { thought: step.thought } : {}),
          };
          const basePayload = sanitizeFakeValue(rawStepPayload) as Record<string, unknown>;
          const commonPayload: Record<string, unknown> = {
            ...basePayload,
            ...(conversationId !== null ? { conversationId: redactFakeString(conversationId) } : {}),
            ...(defaultTurnId !== null ? { turnId: redactFakeString(defaultTurnId) } : {}),
            ...(metadataSource === "runtime" ? { executionMetadata } : {}),
          };

          if (kind === "job.message") {
            const messageKey = step.messageKey ?? (step.messageId ? `msg:${step.messageId}` : "turn-response");
            const deltaText =
              step.textDelta !== undefined
                ? redactFakeString(step.textDelta)
                : step.message !== undefined && step.textSnapshot === undefined
                  ? redactFakeString(step.message)
                  : undefined;
            const snapshotText = step.textSnapshot !== undefined ? redactFakeString(step.textSnapshot) : undefined;
            const isFinal = step.final === true;
            const stepSig = `${step.id ?? `step-${stepIndex}`}:${isFinal ? "final" : "delta"}:${snapshotText ?? deltaText ?? ""}`;

            let entry = messagesByKey.get(messageKey);
            if (entry === undefined) {
              entry = {
                messageKey,
                content: "",
                final: false,
                providerIdentity: buildIdentity(step.turnId, step.messageId),
                seenStepSignatures: new Set(),
                emitCount: 0,
              };
              messagesByKey.set(messageKey, entry);
            }

            if (entry.seenStepSignatures.has(stepSig)) {
              await wait(stepDelayMs, signal);
              continue;
            }
            if (entry.final && !isFinal && deltaText !== undefined && entry.content.includes(deltaText)) {
              await wait(stepDelayMs, signal);
              continue;
            }
            entry.seenStepSignatures.add(stepSig);

            if (snapshotText !== undefined) {
              if (entry.content.length === 0 || snapshotText.startsWith(entry.content)) {
                entry.content = snapshotText;
              } else if (!entry.content.endsWith(snapshotText) && snapshotText !== entry.content) {
                entry.content += snapshotText;
              }
            } else if (deltaText !== undefined) {
              if (isFinal && entry.content.length > 0 && (deltaText === entry.content || entry.content.endsWith(deltaText))) {
                // Already accumulated
              } else if (isFinal && entry.content.length > 0 && deltaText.startsWith(entry.content)) {
                entry.content = deltaText;
              } else {
                entry.content += deltaText;
              }
            }

            entry.final = entry.final || isFinal;
            if (entry.content.length > 0) {
              entry.emitCount += 1;
              lastMessageKey = messageKey;
              const eventId = step.id ?? `fake-${messageKey}-${entry.emitCount}`;
              emit({
                id: eventId,
                kind: "job.message",
                message: deltaText ?? snapshotText ?? entry.content,
                payload: {
                  ...commonPayload,
                  workerMessage: {
                    messageKey: entry.messageKey,
                    content: entry.content,
                    final: entry.final,
                    providerIdentity: entry.providerIdentity,
                  },
                },
              });
            }
          } else {
            const eventId = step.id ?? `fake-step-${stepIndex}`;
            if (!seenEventIds.has(eventId)) {
              seenEventIds.add(eventId);
              emit({
                id: eventId,
                kind,
                message: redactFakeString(step.message ?? kind),
                payload: commonPayload,
              });
            }
          }

          await wait(stepDelayMs, signal);
        }
      }
    }

    if (this.#options.holdUntilAbort === true) {
      this.#options.onReadyForAbort?.(job);
      await waitForAbort(signal);
    }

    const defaultSummary = `Fake runner completed "${redactedTitle}". No Antigravity process was started.`;
    const explicitFinalSummary =
      this.#options.finalSummary === undefined
        ? (this.#options.steps === undefined ? defaultSummary : undefined)
        : this.#options.finalSummary;

    const lastMessage = lastMessageKey !== null ? messagesByKey.get(lastMessageKey) : undefined;
    let resolvedSummary: string;
    if (explicitFinalSummary !== null && explicitFinalSummary !== undefined) {
      resolvedSummary = redactFakeString(explicitFinalSummary);
      if (lastMessage !== undefined) {
        if (
          this.#options.steps === undefined ||
          resolvedSummary === lastMessage.content ||
          resolvedSummary.startsWith(lastMessage.content)
        ) {
          lastMessage.content = resolvedSummary;
          lastMessage.final = true;
        }
      }
    } else if (lastMessage !== undefined && lastMessage.content.trim().length > 0) {
      lastMessage.final = true;
      resolvedSummary = lastMessage.content;
    } else {
      resolvedSummary = "Antigravity completed without a text summary.";
    }

    if (metadataSource === "runtime" && configuredSteps.length === 0) {
      emit({
        id: "fake-runtime-meta",
        kind: "job.progress",
        message: "Fake runtime metadata recorded",
        payload: {
          ...(conversationId !== null ? { conversationId: redactFakeString(conversationId) } : {}),
          ...(defaultTurnId !== null ? { turnId: redactFakeString(defaultTurnId) } : {}),
          executionMetadata,
        },
      });
    }

    return {
      summary: resolvedSummary,
      tests: [{ command: "fake verification", status: "passed", output: "Fake runner completed successfully." }],
      filesChanged: [],
      risks: ["This is a deterministic local simulation; no Antigravity process was started."],
      ...(conversationId !== null ? { conversationId: redactFakeString(conversationId) } : {}),
    };
  }
}
