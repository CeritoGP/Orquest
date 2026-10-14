import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Effort, JobAccessMode } from "@orquest/contracts";

export interface ExecutionProfile {
  model?: string;
  effort?: Effort;
  agent?: string;
  accessMode?: JobAccessMode;
}

export type ExecutionProfiles = ReadonlyMap<string, ExecutionProfile>;

const effortValues = new Set<Effort>(["low", "medium", "high", "max"]);
const accessValues = new Set<JobAccessMode>(["read-only", "worktree"]);

export const defaultExecutionProfiles: ExecutionProfiles = new Map([
  ["quick", { model: "auto", effort: "low", accessMode: "read-only" }],
  ["researcher", { model: "auto", effort: "medium", accessMode: "read-only" }],
  ["implementer", { model: "auto", effort: "high", accessMode: "worktree" }],
  ["reviewer", { model: "auto", effort: "high", accessMode: "read-only" }],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Profile field ${field} must be a non-empty string`);
  return value.trim();
}

function parseProfile(id: string, value: unknown): ExecutionProfile {
  if (!isRecord(value)) throw new Error(`Profile ${id} must be a mapping`);
  const model = optionalString(value.model, `${id}.model`);
  const agent = optionalString(value.agent, `${id}.agent`);
  const effort = optionalString(value.effort, `${id}.effort`);
  const accessMode = optionalString(value.accessMode ?? value.access, `${id}.access`);
  if (effort !== undefined && !effortValues.has(effort as Effort)) throw new Error(`Profile ${id} has unsupported effort ${effort}`);
  if (accessMode !== undefined && !accessValues.has(accessMode as JobAccessMode)) throw new Error(`Profile ${id} has unsupported access mode ${accessMode}`);
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort: effort as Effort }),
    ...(agent === undefined ? {} : { agent }),
    ...(accessMode === undefined ? {} : { accessMode: accessMode as JobAccessMode }),
  };
}

export function loadExecutionProfiles(filePath?: string): Map<string, ExecutionProfile> {
  const profiles = new Map(defaultExecutionProfiles);
  if (filePath === undefined || !existsSync(filePath)) return profiles;
  const parsed = parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.profiles)) throw new Error("Profiles file must contain a profiles mapping");
  for (const [id, value] of Object.entries(parsed.profiles)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error(`Invalid profile ID: ${id}`);
    profiles.set(id, parseProfile(id, value));
  }
  return profiles;
}