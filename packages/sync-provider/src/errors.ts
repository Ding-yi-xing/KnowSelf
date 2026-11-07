import type { SyncErrorCode } from "@knowself/contracts";

export class SyncError extends Error {
  public readonly code: SyncErrorCode;
  public readonly details: string | undefined;

  constructor(code: SyncErrorCode, message: string, details?: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.details = details;
  }
}
