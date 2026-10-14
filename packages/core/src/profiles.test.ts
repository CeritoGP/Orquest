import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionProfiles, loadExecutionProfiles } from "./profiles.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("execution profiles", () => {
  it("provides safe built-ins", () => {
    expect(defaultExecutionProfiles.get("implementer")).toMatchObject({ effort: "high", accessMode: "worktree" });
    expect(defaultExecutionProfiles.get("reviewer")).toMatchObject({ effort: "high", accessMode: "read-only" });
  });

  it("loads a YAML override without discarding built-ins", () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-profiles-test-"));
    directories.push(directory);
    const file = join(directory, "profiles.yaml");
    writeFileSync(file, "version: 1\nprofiles:\n  audit:\n    agent: reviewer\n    model: gemini-test\n    effort: max\n    access: read-only\n");

    const profiles = loadExecutionProfiles(file);
    expect(profiles.get("quick")).toBeDefined();
    expect(profiles.get("audit")).toEqual({ agent: "reviewer", model: "gemini-test", effort: "max", accessMode: "read-only" });
  });

  it("rejects invalid profile values", () => {
    const directory = mkdtempSync(join(tmpdir(), "orquest-profiles-invalid-test-"));
    directories.push(directory);
    const file = join(directory, "profiles.yaml");
    writeFileSync(file, "profiles:\n  unsafe:\n    access: shell\n");
    expect(() => loadExecutionProfiles(file)).toThrow("unsupported access mode");
  });
});