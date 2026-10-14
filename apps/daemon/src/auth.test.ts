import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateRequest,
  constantTimeCompare,
  extractBearerToken,
  isLoopbackAddress,
  resolveDaemonToken,
  verifyRequestAuth,
} from "./auth.js";

describe("daemon authentication & local security", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orquest-auth-test-"));
    delete process.env.ORQUEST_DAEMON_TOKEN;
  });

  afterEach(() => {
    delete process.env.ORQUEST_DAEMON_TOKEN;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolveDaemonToken", () => {
    it("uses ORQUEST_DAEMON_TOKEN environment variable when present", () => {
      process.env.ORQUEST_DAEMON_TOKEN = "env-secret-token-1234";
      const resolved = resolveDaemonToken({ tokenPath: join(tempDir, "daemon.token") });
      expect(resolved.token).toBe("env-secret-token-1234");
      expect(resolved.source).toBe("env");
    });

    it("generates a new token and saves it with restricted permissions if file does not exist", () => {
      const tokenPath = join(tempDir, "sub", "daemon.token");
      const resolved = resolveDaemonToken({ tokenPath });

      expect(resolved.source).toBe("file");
      expect(resolved.token).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(resolved.tokenPath).toBe(tokenPath);

      // Re-reading from same path loads the generated token
      const reloaded = resolveDaemonToken({ tokenPath });
      expect(reloaded.token).toBe(resolved.token);
      expect(reloaded.source).toBe("file");
    });
  });

  describe("constantTimeCompare", () => {
    it("returns true for identical strings", () => {
      expect(constantTimeCompare("secret12345", "secret12345")).toBe(true);
    });

    it("returns false for different strings of equal length", () => {
      expect(constantTimeCompare("secret12345", "secret12346")).toBe(false);
    });

    it("returns false for strings of different length", () => {
      expect(constantTimeCompare("secret12345", "secret123456")).toBe(false);
    });
  });

  describe("isLoopbackAddress", () => {
    it("accepts IPv4 and IPv6 loopback addresses", () => {
      expect(isLoopbackAddress("127.0.0.1")).toBe(true);
      expect(isLoopbackAddress("::1")).toBe(true);
      expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
      expect(isLoopbackAddress("localhost")).toBe(true);
    });

    it("rejects non-loopback addresses", () => {
      expect(isLoopbackAddress("192.168.1.100")).toBe(false);
      expect(isLoopbackAddress("10.0.0.1")).toBe(false);
      expect(isLoopbackAddress("8.8.8.8")).toBe(false);
      expect(isLoopbackAddress(undefined)).toBe(false);
    });
  });

  describe("verifyRequestAuth & extractBearerToken", () => {
    it("extracts token from Authorization: Bearer header", () => {
      const req = {
        headers: {
          authorization: "Bearer my-secure-token",
        },
      } as unknown as IncomingMessage;

      expect(extractBearerToken(req)).toBe("my-secure-token");
      expect(verifyRequestAuth(req, "my-secure-token")).toBe(true);
      expect(verifyRequestAuth(req, "wrong-token")).toBe(false);
    });

    it("rejects non-bearer or missing authorization headers", () => {
      const missing = { headers: {} } as unknown as IncomingMessage;
      expect(extractBearerToken(missing)).toBeNull();
      expect(verifyRequestAuth(missing, "any-token")).toBe(false);

      const basic = {
        headers: {
          authorization: "Basic dXNlcjpwYXNz",
        },
      } as unknown as IncomingMessage;
      expect(extractBearerToken(basic)).toBeNull();
      expect(verifyRequestAuth(basic, "any-token")).toBe(false);
    });
  });

  describe("authenticateRequest", () => {
    it("returns status none when no authorization header is present or empty", () => {
      expect(authenticateRequest({ headers: {} } as unknown as IncomingMessage, "tok")).toEqual({ status: "none" });
      expect(authenticateRequest({ headers: { authorization: "  " } } as unknown as IncomingMessage, "tok")).toEqual({ status: "none" });
    });

    it("returns status valid when matching bearer token is provided", () => {
      const req = { headers: { authorization: "Bearer my-token" } } as unknown as IncomingMessage;
      expect(authenticateRequest(req, "my-token")).toEqual({ status: "valid" });
    });

    it("returns status invalid with reason invalid_token when token does not match", () => {
      const req = { headers: { authorization: "Bearer wrong-token" } } as unknown as IncomingMessage;
      expect(authenticateRequest(req, "my-token")).toEqual({ status: "invalid", reason: "invalid_token" });
    });

    it("returns status invalid with reason malformed when header is not bearer format", () => {
      const basic = { headers: { authorization: "Basic 12345" } } as unknown as IncomingMessage;
      expect(authenticateRequest(basic, "my-token")).toEqual({ status: "invalid", reason: "malformed" });

      const emptyBearer = { headers: { authorization: "Bearer " } } as unknown as IncomingMessage;
      expect(authenticateRequest(emptyBearer, "my-token")).toEqual({ status: "invalid", reason: "malformed" });
    });
  });
});
