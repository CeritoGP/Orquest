import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJob } from "./index.js";
import { WorktreeManager } from "./worktree.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function createRepository(): { repository: string; worktreeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "orquest-worktree-test-"));
  temporaryDirectories.push(root);
  const repository = join(root, "repo");
  const worktreeRoot = join(root, "state", "worktrees");
  mkdirSync(repository, { recursive: true });
  git(repository, "init");
  git(repository, "config", "user.email", "orquest@example.invalid");
  git(repository, "config", "user.name", "Orquest Test");
  writeFileSync(join(repository, "tracked.txt"), "original\n", "utf8");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "initial");
  return { repository, worktreeRoot };
}

describe("WorktreeManager", () => {
  it("isolates writer changes and returns a paginated diff", () => {
    const { repository, worktreeRoot } = createRepository();
    const manager = new WorktreeManager(worktreeRoot);
    const baseJob = createJob({
      title: "Implement isolated change",
      task: "Change tracked.txt and create added.txt",
      workspacePath: repository,
      accessMode: "worktree",
    });
    const info = manager.create(repository, baseJob.id);
    const job = { ...baseJob, ...info };

    writeFileSync(join(info.worktreePath, "tracked.txt"), "changed\n", "utf8");
    writeFileSync(join(info.worktreePath, "added.txt"), "new file\n", "utf8");

    expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe("original\n");
    expect(manager.listChangedFiles(job)).toEqual(["added.txt", "tracked.txt"]);

    const first = manager.getDiff(job, { limit: 1 });
    expect(first.available).toBe(true);
    expect(first.files).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.diff).toContain(first.files[0]);

    const second = manager.getDiff(job, { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.files).toHaveLength(1);
    expect(second.files[0]).not.toBe(first.files[0]);
    expect(second.hasMore).toBe(false);
    expect(`${first.diff}\n${second.diff}`).toContain("changed");
    expect(`${first.diff}\n${second.diff}`).toContain("new file");
  }, 15_000);

  it("rejects a workspace that is only a subdirectory of a repository", () => {
    const { repository, worktreeRoot } = createRepository();
    const nested = join(repository, "nested");
    mkdirSync(nested);
    const manager = new WorktreeManager(worktreeRoot);
    expect(() => manager.create(nested, "550e8400-e29b-41d4-a716-446655440000")).toThrow("repository root");
  });
});