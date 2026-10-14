import { describe, expect, it } from "vitest";
import { parseVerificationCommand } from "./verification.js";

describe("verification command policy", () => {
  it("parses the bounded npm and git command allowlist", () => {
    expect(parseVerificationCommand("npm.cmd run lint")).toMatchObject({
      executable: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "lint"],
    });
    expect(parseVerificationCommand("git diff --check")).toEqual({
      executable: "git",
      args: ["diff", "--check"],
    });
  });

  it("rejects commands that would require a shell or an unbounded allowlist", () => {
    expect(() => parseVerificationCommand("cmd /c del *")).toThrow("not allowed");
    expect(() => parseVerificationCommand("npm.cmd run deploy")).toThrow("not allowed");
  });
});