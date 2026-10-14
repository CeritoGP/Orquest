import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decodeCursor, encodeCursor, type JobDiffQueryOutput, type JobDiffResponse, type JobRecord } from "@orquest/contracts";
import { isSameOrSubpath } from "./path.js";

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseCommit: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

interface DiffCursor {
  index: number;
}

const maxGitBuffer = 8 * 1024 * 1024;
const maxDiffResponseBytes = 2 * 1024 * 1024;

function runGit(cwd: string, args: readonly string[], allowedStatuses: readonly number[] = [0]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: maxGitBuffer,
  });
  if (result.error) throw new Error(`Unable to execute git: ${result.error.message}`);
  const status = result.status ?? -1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!allowedStatuses.includes(status)) {
    const detail = stderr.trim().slice(-1_000) || stdout.trim().slice(-1_000) || `exit ${status}`;
    throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
  return { stdout, stderr, status };
}

function nulList(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function normalizedRelativePath(worktreePath: string, candidate: string): string {
  if (candidate.includes("\0") || isAbsolute(candidate)) throw new Error("Git returned an unsafe changed-file path");
  const absolute = resolve(worktreePath, candidate);
  if (!isSameOrSubpath(worktreePath, absolute)) throw new Error("Git returned a path outside the worktree");
  return candidate.replaceAll("\\", "/");
}

function samePath(first: string, second: string): boolean {
  const difference = relative(first, second);
  return difference === "";
}

export class WorktreeManager {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  create(workspacePath: string, jobId: string): WorktreeInfo {
    const canonicalWorkspace = realpathSync.native(resolve(workspacePath));
    const repositoryRootOutput = runGit(canonicalWorkspace, ["rev-parse", "--show-toplevel"]).stdout.trim();
    const repositoryRoot = realpathSync.native(resolve(repositoryRootOutput));
    if (!samePath(repositoryRoot, canonicalWorkspace)) {
      throw new Error("Worktree jobs require workspacePath to be the Git repository root");
    }

    const baseCommit = runGit(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw new Error("Unable to resolve a valid Git base commit");

    mkdirSync(this.#root, { recursive: true });
    const canonicalRoot = realpathSync.native(this.#root);
    const repositoryKey = createHash("sha256").update(repositoryRoot.toLowerCase()).digest("hex").slice(0, 16);
    const repositoryWorktrees = join(canonicalRoot, repositoryKey);
    mkdirSync(repositoryWorktrees, { recursive: true });
    const targetPath = resolve(repositoryWorktrees, jobId);
    if (!isSameOrSubpath(canonicalRoot, targetPath)) throw new Error("Computed worktree path escaped the Orquest worktree root");
    if (existsSync(targetPath)) throw new Error(`Worktree path already exists for job ${jobId}`);

    const branchName = `orquest/${jobId.slice(0, 8)}`;
    runGit(repositoryRoot, ["worktree", "add", "--no-track", "-b", branchName, targetPath, baseCommit]);
    const worktreePath = realpathSync.native(targetPath);
    if (!isSameOrSubpath(canonicalRoot, worktreePath)) throw new Error("Created worktree resolved outside the Orquest worktree root");
    return { worktreePath, branchName, baseCommit };
  }

  listChangedFiles(job: Pick<JobRecord, "worktreePath" | "baseCommit">): string[] {
    if (!job.worktreePath || !job.baseCommit) return [];
    const worktreePath = realpathSync.native(resolve(job.worktreePath));
    const tracked = nulList(runGit(worktreePath, ["diff", "--name-only", "-z", job.baseCommit, "--"]).stdout);
    const untracked = nulList(runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z", "--"]).stdout);
    return [...new Set([...tracked, ...untracked].map((file) => normalizedRelativePath(worktreePath, file)))].sort();
  }

  getDiff(job: JobRecord, query: JobDiffQueryOutput): JobDiffResponse {
    if (job.accessMode !== "worktree" || !job.worktreePath || !job.baseCommit) {
      return {
        jobId: job.id,
        available: false,
        reason: "Job does not have an isolated worktree",
        files: [],
        diff: "",
        nextCursor: null,
        hasMore: false,
      };
    }

    const worktreePath = realpathSync.native(resolve(job.worktreePath));
    const changedFiles = this.listChangedFiles(job);
    let start = 0;
    if (query.cursor) {
      const decoded = decodeCursor<DiffCursor>(query.cursor);
      if (!decoded || !Number.isInteger(decoded.index) || decoded.index < 0 || decoded.index > changedFiles.length) {
        throw new Error("Invalid cursor: Malformed or out-of-range diff cursor");
      }
      start = decoded.index;
    }

    const trackedFiles = new Set(nulList(runGit(worktreePath, ["ls-files", "--cached", "-z", "--"]).stdout).map((file) => normalizedRelativePath(worktreePath, file)));
    const requestedFiles = changedFiles.slice(start, start + query.limit);
    const returnedFiles: string[] = [];
    let diff = "";
    let truncated = false;

    for (const file of requestedFiles) {
      const args = trackedFiles.has(file)
        ? ["diff", "--no-ext-diff", "--binary", job.baseCommit, "--", file]
        : ["diff", "--no-index", "--binary", "--", "/dev/null", file];
      const patch = runGit(worktreePath, args, trackedFiles.has(file) ? [0] : [0, 1]).stdout;
      const separator = diff.length === 0 || patch.length === 0 ? "" : "\n";
      const candidate = `${diff}${separator}${patch}`;
      if (Buffer.byteLength(candidate, "utf8") > maxDiffResponseBytes) {
        if (returnedFiles.length === 0) {
          const availableBytes = Math.max(0, maxDiffResponseBytes - Buffer.byteLength("\n[diff truncated]\n", "utf8"));
          diff = `${Buffer.from(patch, "utf8").subarray(0, availableBytes).toString("utf8")}\n[diff truncated]\n`;
          returnedFiles.push(file);
        }
        truncated = true;
        break;
      }
      diff = candidate;
      returnedFiles.push(file);
    }

    const nextIndex = start + returnedFiles.length;
    const hasMore = truncated || nextIndex < changedFiles.length;
    return {
      jobId: job.id,
      available: true,
      ...(truncated ? { reason: "Diff page reached the 2 MiB response limit" } : {}),
      files: returnedFiles,
      diff,
      nextCursor: hasMore ? encodeCursor({ index: nextIndex } satisfies DiffCursor) : null,
      hasMore,
    };
  }
}