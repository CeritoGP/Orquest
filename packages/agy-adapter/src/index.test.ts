import { describe, expect, it } from "vitest";
import {
  AgyStreamSession,
  buildAgyArguments,
  extractProviderMessageIdentity,
  extractRuntimeExecutionMetadata,
  isPrivateReasoningEvent,
  NO_SUMMARY_FALLBACK,
  normalizeAgyEvent,
  redactSecret,
  redactString,
  resultFromPayload,
  stripPrivateReasoning,
  toolFailureFromPayload,
} from "./index.js";

const job = {
  id: "60b74742-8f56-4598-b40f-e4d6d75afc0a",
  title: "Inspect repository",
  task: "Inspect the repository.",
  workspacePath: "C:/repo",
  profileId: "quick",
  agent: "reviewer",
  accessMode: "read-only" as const,
  model: "gemini-3.8-flash-medium",
  effort: "high" as const,
  acceptanceCriteria: [],
  verificationCommands: [],
  priority: 50,
  dependsOnJobIds: [],
  reviewOfJobId: null,
  status: "RUNNING" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  stoppedAt: null,
  taskSessionId: "59b74742-8f56-4598-b40f-e4d6d75afc0a",
  attemptIndex: 1,
  conversationId: null,
  worktreePath: null,
  branchName: null,
  baseCommit: null,
  errorCode: null,
  result: null,
  errorMessage: null,
  effectiveModel: null,
  effectiveEffort: null,
  executionMetadataSource: "unknown" as const,
  orchestrator: null,
  profileSnapshot: null,
};

describe("agy adapter", () => {
  it("uses safe read-only argument arrays", () => {
    const args = buildAgyArguments(job, { printTimeout: "15m" });
    expect(args).toContain("--mode");
    expect(args).toContain("plan");
    expect(args).toContain("--sandbox");
    expect(args).toContain("gemini-3.8-flash-medium");
    expect(args).toContain("reviewer");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("uses accept-edits only for isolated worktree jobs", () => {
    const args = buildAgyArguments({
      ...job,
      accessMode: "worktree",
      worktreePath: "C:/state/worktree",
      branchName: "orquest/test",
      baseCommit: "0123456789012345678901234567890123456789",
    });
    expect(args).toContain("accept-edits");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("normalizes Antigravity tool and text events", () => {
    expect(
      normalizeAgyEvent({
        event: "step_update",
        step_update: { step_type: "tool", state: "DONE", step_index: 1, tool_name: "run_command", tool_info: { output: "ok" } },
      }),
    ).toMatchObject({ kind: "job.tool", message: "run_command" });
    expect(
      normalizeAgyEvent({
        event: "step_update",
        step_update: { step_type: "agent_response", state: "ACTIVE", step_index: 2, text_delta: "Inspecting files" },
      }),
    ).toMatchObject({ kind: "job.message", message: "Inspecting files" });
    expect(
      normalizeAgyEvent({
        event: "subagent_info",
        subagent_info: { id: "sub-1", agent_name: "reviewer", state: "RUNNING", model: "auto" },
      }),
    ).toMatchObject({
      kind: "job.progress",
      message: "Subagent reviewer: RUNNING",
      payload: { subagent: { id: "sub-1", name: "reviewer", state: "RUNNING" } },
    });
  });

  it("does not treat a canceled tool and empty success result as a completed job", () => {
    const failure = toolFailureFromPayload({
      event: "step_update",
      step_update: { step_type: "tool", state: "DONE", tool_name: "run_command", tool_info: { error: { type: "TOOL_ERROR", message: "context canceled" } } },
    });
    expect(failure).toBe("run_command failed: context canceled");
    expect(() => resultFromPayload({ event: "result", result: { status: "SUCCESS" } }, undefined, failure)).toThrow("context canceled");
  });

  describe("D03 stream reconciliation, metadata provenance, and sanitization", () => {
    it("reconciles fragmented deltas, repeated stream events, and final result without duplicating messages", () => {
      const session = new AgyStreamSession({ provider: "agy" });
      const rawStream = [
        { event: "init", conversation_id: "conv-100", turn_id: "turn-1" },
        {
          event: "step_update",
          step_update: {
            step_type: "agent_response",
            state: "ACTIVE",
            step_index: 2,
            message_id: "msg-1",
            text_delta: "Primera parte, ",
          },
        },
        // Duplicate delta replay
        {
          event: "step_update",
          step_update: {
            step_type: "agent_response",
            state: "ACTIVE",
            step_index: 2,
            message_id: "msg-1",
            text_delta: "Primera parte, ",
          },
        },
        {
          event: "step_update",
          step_update: {
            step_type: "agent_response",
            state: "ACTIVE",
            step_index: 2,
            message_id: "msg-1",
            text_delta: "segunda parte.",
          },
        },
        // Snapshot step completion repeating full text
        {
          event: "step_update",
          step_update: {
            step_type: "agent_response",
            state: "DONE",
            step_index: 2,
            message_id: "msg-1",
            text: "Primera parte, segunda parte.",
          },
        },
        // Replay entire delta sequence after completion
        {
          event: "step_update",
          step_update: {
            step_type: "agent_response",
            state: "ACTIVE",
            step_index: 2,
            message_id: "msg-1",
            text_delta: "Primera parte, ",
          },
        },
        {
          event: "result",
          result: {
            status: "SUCCESS",
            conversation_id: "conv-100",
            turn_id: "turn-1",
            message_id: "msg-1",
            response: "Primera parte, segunda parte.",
          },
        },
      ];

      for (const item of rawStream) {
        session.consumePayload(item);
      }

      const reconciled = session.getReconciledMessages();
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]).toEqual({
        messageKey: "msg:msg-1",
        content: "Primera parte, segunda parte.",
        final: true,
        providerIdentity: {
          provider: "agy",
          conversationId: "conv-100",
          turnId: "turn-1",
          messageId: "msg-1",
        },
      });
      expect(session.pendingResult?.summary).toBe("Primera parte, segunda parte.");
    });

    it("preserves streamed response when final result omits summary and uses fallback only when no response exists", () => {
      const withDeltas = new AgyStreamSession({ provider: "agy" });
      withDeltas.consumePayload({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          state: "ACTIVE",
          step_index: 1,
          text_delta: "Hallazgos públicos del worker.",
        },
      });
      const outcomeWithDeltas = withDeltas.consumePayload({
        event: "result",
        result: { status: "SUCCESS", conversation_id: "conv-no-summary" },
      });
      expect(outcomeWithDeltas.result?.summary).toBe("Hallazgos públicos del worker.");
      expect(withDeltas.getReconciledMessages()).toHaveLength(1);
      expect(withDeltas.getReconciledMessages()[0]?.content).toBe("Hallazgos públicos del worker.");
      expect(withDeltas.getReconciledMessages()[0]?.providerIdentity).toEqual({
        provider: "agy",
        conversationId: "conv-no-summary",
        turnId: null,
        messageId: null,
      });

      const withoutDeltas = new AgyStreamSession({ provider: "agy" });
      const outcomeWithoutDeltas = withoutDeltas.consumePayload({
        event: "result",
        result: { status: "SUCCESS" },
      });
      expect(outcomeWithoutDeltas.result?.summary).toBe(NO_SUMMARY_FALLBACK);
      expect(withoutDeltas.getReconciledMessages()).toEqual([]);
    });

    it("records runtime model and effort only when reported by the protocol and never treats 'auto' as concrete", () => {
      expect(extractRuntimeExecutionMetadata({ event: "init", model: "auto" })).toEqual({
        effectiveModel: null,
        effectiveEffort: null,
        source: "unknown",
      });
      expect(extractRuntimeExecutionMetadata({ event: "init" })).toEqual({
        effectiveModel: null,
        effectiveEffort: null,
        source: "unknown",
      });
      expect(
        extractRuntimeExecutionMetadata({
          event: "init",
          model: "gemini-3.8-pro",
          effort: "high",
        }),
      ).toEqual({
        effectiveModel: "gemini-3.8-pro",
        effectiveEffort: "high",
        source: "runtime",
      });
      expect(
        extractRuntimeExecutionMetadata({
          event: "subagent_info",
          subagent_info: { id: "sub-1", model: "gemini-3.8-flash" },
        }),
      ).toEqual({
        effectiveModel: null,
        effectiveEffort: null,
        source: "unknown",
      });
      expect(extractProviderMessageIdentity({ event: "step_update", step_update: { step_type: "agent_response" } })).toBeNull();
    });

    it("excludes private reasoning events and strips private reasoning fields while redacting secrets", () => {
      expect(
        isPrivateReasoningEvent({
          event: "step_update",
          step_update: { step_type: "thought", state: "ACTIVE", text_delta: "Cadena interna privada" },
        }),
      ).toBe(true);
      expect(
        isPrivateReasoningEvent({
          event: "step_update",
          step_update: { step_type: "agent_response", state: "ACTIVE", thought_delta: "Pensamiento oculto sin texto público" },
        }),
      ).toBe(true);

      const session = new AgyStreamSession({ provider: "agy" });
      const thoughtOutcome = session.consumePayload({
        event: "step_update",
        step_update: {
          step_type: "reasoning",
          state: "ACTIVE",
          text_delta: "Internal reasoning with token=secret-internal-token",
        },
      });
      expect(thoughtOutcome.events).toEqual([]);

      const publicOutcome = session.consumePayload({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          state: "DONE",
          step_index: 3,
          thought: "Must not leak internal thought",
          reasoning_content: "Must not leak reasoning_content",
          text_delta: "Respuesta con Authorization: Bearer secret-jwt-token y api_key=sk-1234567890abcdef",
        },
      });
      expect(publicOutcome.events).toHaveLength(1);
      const serialized = JSON.stringify(publicOutcome.events[0]);
      expect(serialized).not.toContain("Must not leak");
      expect(serialized).not.toContain("secret-jwt-token");
      expect(serialized).not.toContain("sk-1234567890abcdef");
      expect(publicOutcome.events[0]?.message).toContain("Authorization: Bearer [REDACTED]");
      expect(publicOutcome.events[0]?.message).toContain("api_key=[REDACTED]");

      const stripped = stripPrivateReasoning({
        text: "visible",
        thought: "hidden",
        nested: { reasoning_delta: "hidden-delta", ok: true },
      });
      expect(stripped).toEqual({ text: "visible", nested: { ok: true } });
      expect(redactString("Bearer tok_abc123; password: my_password")).toBe("Bearer [REDACTED]; password: [REDACTED]");
      expect(redactSecret({ apiKey: "secret-key", publicField: "token=abc123" })).toEqual({
        apiKey: "[REDACTED]",
        publicField: "token=[REDACTED]",
      });
    });
  });
});
