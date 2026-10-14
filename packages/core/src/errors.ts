import type { JobErrorCode } from "@orquest/contracts";

export class RunnerError extends Error {
  readonly code: JobErrorCode;
  readonly isBlocked: boolean;

  constructor(message: string, code: JobErrorCode, isBlocked = false) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.isBlocked = isBlocked;
  }
}