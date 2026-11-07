import type { ProfileErrorCode, ProfileRefKind } from "@knowself/contracts";

export class ProfileError extends Error {
  public readonly code: ProfileErrorCode;
  public readonly refKind: ProfileRefKind | undefined;
  public readonly refId: string | undefined;
  public readonly traceId: string | undefined;

  constructor(
    code: ProfileErrorCode,
    message: string,
    refKind?: ProfileRefKind,
    refId?: string,
    traceId?: string,
  ) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.refKind = refKind;
    this.refId = refId;
    this.traceId = traceId;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      ref_kind: this.refKind,
      ref_id: this.refId,
      trace_id: this.traceId,
    };
  }
}

export class ProfileNotFoundError extends ProfileError {
  constructor(message: string, refKind?: ProfileRefKind, refId?: string) {
    super("PROFILE_NOT_FOUND", message, refKind, refId);
  }
}

export class DbBusyError extends ProfileError {
  constructor(message: string) {
    super("DB_BUSY", message);
  }
}

export class DbCorruptError extends ProfileError {
  constructor(message: string) {
    super("DB_CORRUPT", message);
  }
}

export class ConstraintViolationError extends ProfileError {
  constructor(message: string, refKind?: ProfileRefKind, refId?: string) {
    super("CONSTRAINT_VIOLATION", message, refKind, refId);
  }
}

export class InvalidTargetRefError extends ProfileError {
  constructor(message: string, refKind?: ProfileRefKind, refId?: string) {
    super("INVALID_TARGET_REF", message, refKind, refId);
  }
}

export class AutowriteRejectedError extends ProfileError {
  constructor(message: string) {
    super("AUTOWRITE_REJECTED", message);
  }
}
