import type { CaasFamily } from "./types.ts";

export type CaasErrorCode =
  | "CONFIGURATION"
  | "CANCELLED"
  | "TIMEOUT"
  | "UPSTREAM_STATUS"
  | "RETRY_EXHAUSTED"
  | "MEDIA_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "RECORD_LIMIT"
  | "INVALID_JSON"
  | "INVALID_RECORD"
  | "POLICY_REJECTED";

export class CaasAdapterError extends Error {
  readonly code: CaasErrorCode;
  readonly family: CaasFamily | undefined;
  readonly status: number | undefined;

  constructor(code: CaasErrorCode, message: string, options?: { family?: CaasFamily; status?: number }) {
    super(message);
    this.name = "CaasAdapterError";
    this.code = code;
    this.family = options?.family;
    this.status = options?.status;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
