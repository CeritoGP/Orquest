import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage } from "node:http";

export interface ResolvedToken {
  token: string;
  source: "env" | "file";
  tokenPath?: string | undefined;
}

export function resolveDaemonToken(options?: { explicitToken?: string | undefined; tokenPath?: string | undefined }): ResolvedToken {
  const explicit = options?.explicitToken ?? process.env.ORQUEST_DAEMON_TOKEN;
  if (explicit !== undefined && explicit.trim() !== "") {
    return { token: explicit.trim(), source: "env" };
  }

  const tokenPath = options?.tokenPath;
  if (!tokenPath) {
    throw new Error("Cannot resolve daemon token: no token path provided and ORQUEST_DAEMON_TOKEN is not set");
  }

  if (existsSync(tokenPath)) {
    const raw = readFileSync(tokenPath, "utf8").trim();
    if (raw.length > 0) {
      return { token: raw, source: "file", tokenPath };
    }
  }

  mkdirSync(dirname(tokenPath), { recursive: true });
  const generated = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, generated, { mode: 0o600 });
  return { token: generated, source: "file", tokenPath };
}

export function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

export type AuthState =
  | { status: "none" }
  | { status: "valid" }
  | { status: "invalid"; reason: "malformed" | "invalid_token" };

export function authenticateRequest(request: IncomingMessage, expectedToken: string): AuthState {
  const authHeader = request.headers.authorization ?? request.headers.Authorization;
  if (typeof authHeader !== "string" || authHeader.trim() === "") {
    return { status: "none" };
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match || !match[1] || match[1].trim() === "") {
    return { status: "invalid", reason: "malformed" };
  }

  const provided = match[1].trim();
  if (constantTimeCompare(provided, expectedToken)) {
    return { status: "valid" };
  }

  return { status: "invalid", reason: "invalid_token" };
}

export function extractBearerToken(request: IncomingMessage): string | null {
  const authHeader = request.headers.authorization ?? request.headers.Authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

export function verifyRequestAuth(request: IncomingMessage, expectedToken: string): boolean {
  return authenticateRequest(request, expectedToken).status === "valid";
}
