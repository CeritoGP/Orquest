import { realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";

export function isSameOrSubpath(parentPath: string, candidatePath: string): boolean {
  const parent = process.platform === "win32" ? parentPath.toLowerCase() : parentPath;
  const candidate = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function validateWorkspacePath(rawPath: string, allowedRoots: readonly string[], requireAllowedRoot: boolean): string {
  const canonical = realpathSync.native(resolve(rawPath));
  if (canonical === parse(canonical).root) throw new Error("Workspace path cannot be a filesystem root");
  if (allowedRoots.length === 0) {
    if (requireAllowedRoot) throw new Error("Execution denied: ORQUEST_ALLOWED_ROOTS is required for the real agy runner");
    return canonical;
  }
  const allowed = allowedRoots.some((root) => {
    try { return isSameOrSubpath(realpathSync.native(resolve(root)), canonical); } catch { return false; }
  });
  if (!allowed) throw new Error("Workspace path is outside ORQUEST_ALLOWED_ROOTS");
  return canonical;
}