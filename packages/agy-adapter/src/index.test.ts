import { describe, expect, it } from "vitest";
import { buildAgyArguments, normalizeAgyEvent, resultFromPayload, toolFailureFromPayload } from "./index.js";

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
    const args = buildAgyArguments({ ...job, accessMode: "worktree", worktreePath: "C:/state/worktree", branchName: "orquest/test", baseCommit: "0123456789012345678901234567890123456789" });
    expect(args).toContain("accept-edits");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
  it("normalizes Antigravity tool and text events", () => {
    expect(normalizeAgyEvent({ event: "step_update", step_update: { step_type: "tool", state: "DONE", step_index: 1, tool_name: "run_command", tool_info: { output: "ok" } } })).toMatchObject({ kind: "job.tool", message: "run_command" });
    expect(normalizeAgyEvent({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", step_index: 2, text_delta: "Inspecting files" } })).toMatchObject({ kind: "job.message", message: "Inspecting files" });
    expect(normalizeAgyEvent({ event: "subagent_info", subagent_info: { id: "sub-1", agent_name: "reviewer", state: "RUNNING", model: "auto" } })).toMatchObject({ kind: "job.progress", message: "Subagent reviewer: RUNNING", payload: { subagent: { id: "sub-1", name: "reviewer", state: "RUNNING" } } });
  });
  it("does not treat a canceled tool and empty success result as a completed job", () => {
    const failure = toolFailureFromPayload({ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "run_command", tool_info: { error: { type: "TOOL_ERROR", message: "context canceled" } } } });
    expect(failure).toBe("run_command failed: context canceled");
    expect(() => resultFromPayload({ event: "result", result: { status: "SUCCESS" } }, undefined, failure)).toThrow("context canceled");
  });
});
