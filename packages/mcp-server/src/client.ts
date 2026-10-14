import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonClientOptions {
  daemonUrl?: string | undefined;
  token?: string | undefined;
  tokenPath?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  defaultTimeoutMs?: number | undefined;
}

export interface DaemonClient {
  readonly baseUrl: string;
  request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
}

export function assertLoopbackUrl(urlInput: string | URL): URL {
  const parsed = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "::ffff:127.0.0.1";
  if (!isLoopback) {
    throw new Error(`Security violation: daemon URL must be a loopback address, got "${parsed.hostname}"`);
  }
  return parsed;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*)?bearer\s+[^\s,;]+/gi, (_match, prefix) => {
      if (prefix) {
        return prefix.includes(":") ? "Authorization: Bearer [REDACTED]" : "authorization=Bearer [REDACTED]";
      }
      return "Bearer [REDACTED]";
    })
    .replace(/(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*(?!bearer\s*\[redacted\])[^\s,;]+/gi, "$1=[REDACTED]");
}

export function resolveClientToken(options?: { explicitToken?: string | undefined; tokenPath?: string | undefined }): string | null {
  if (options?.explicitToken && options.explicitToken.trim() !== "") {
    return options.explicitToken.trim();
  }

  const envToken = process.env.ORQUEST_DAEMON_TOKEN;
  if (envToken && envToken.trim() !== "") {
    return envToken.trim();
  }

  const stateRoot = process.env.ORQUEST_HOME ?? join(homedir(), "AppData", "Local", "OrquestBridge");
  const tokenFile = options?.tokenPath ?? join(stateRoot, "daemon.token");

  try {
    if (existsSync(tokenFile)) {
      const raw = readFileSync(tokenFile, "utf8").trim();
      if (raw.length > 0) {
        return raw;
      }
    }
  } catch {
    // Ignore unreadable token files
  }

  return null;
}

export class DefaultDaemonClient implements DaemonClient {
  readonly baseUrl: string;
  private readonly token?: string | undefined;
  private readonly tokenPath?: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: DaemonClientOptions = {}) {
    const rawUrl = options.daemonUrl ?? process.env.ORQUEST_DAEMON_URL ?? "http://127.0.0.1:4317";
    const validated = assertLoopbackUrl(rawUrl);
    this.baseUrl = validated.toString().replace(/\/+$/, "");
    this.token = options.token;
    this.tokenPath = options.tokenPath;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
  }

  private resolveToken(): string | null {
    return resolveClientToken({
      explicitToken: this.token,
      tokenPath: this.tokenPath,
    });
  }

  async request<T>(path: string, init?: RequestInit, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    const targetUrl = new URL(path, this.baseUrl);
    assertLoopbackUrl(targetUrl);

    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      accept: "application/json",
    };

    const token = this.resolveToken();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Daemon request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const response = await this.fetchFn(targetUrl.toString(), {
        ...init,
        signal: controller.signal,
        headers: {
          ...headers,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });

      const rawText = await response.text();
      let payload: unknown = {};
      if (rawText.trim().length > 0) {
        try {
          payload = JSON.parse(rawText);
        } catch {
          payload = { error: rawText };
        }
      }

      if (!response.ok) {
        const errorMsg =
          typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Daemon request failed (${response.status})`;
        throw new Error(redactSecrets(errorMsg));
      }

      return payload as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Daemon request timed out after ${timeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : "Unexpected error during daemon request";
      throw new Error(redactSecrets(message));
    } finally {
      clearTimeout(timer);
    }
  }
}
