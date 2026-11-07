import type { SettingsErrorCode } from "@knowself/contracts";

export class SettingsError extends Error {
  public readonly code: SettingsErrorCode;
  public readonly path: string | undefined;
  public readonly traceId: string | undefined;

  constructor(code: SettingsErrorCode, message: string, path?: string, traceId?: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
    this.path = path;
    this.traceId = traceId;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      path: this.path,
      trace_id: this.traceId,
    };
  }
}

export class SettingsParseError extends SettingsError {
  constructor(message: string, path?: string) {
    super("PARSE_FAILED", message, path);
  }
}

export class SettingsValidationError extends SettingsError {
  constructor(message: string, path?: string) {
    super("VALIDATION", message, path);
  }
}

export class SettingsWriteError extends SettingsError {
  constructor(message: string, path?: string) {
    super("WRITE_FAILED", message, path);
  }
}

export class SettingsReferenceError extends SettingsError {
  constructor(message: string, path?: string) {
    super("REFERENCE_INVALID", message, path);
  }
}

export class SettingsVersionError extends SettingsError {
  constructor(message: string, path?: string) {
    super("VERSION_MISMATCH", message, path);
  }
}

// ──────────────────────────────────────────────────
//  persons 加密密钥错误（DESIGN-13 §7.2 / §7.6，NFR-10）
//  不变量：错误消息只带载体路径与期望长度，绝不回显密钥内容。
// ──────────────────────────────────────────────────

export type PersonsKeyErrorCode = "ENCRYPTION_KEY_MISSING" | "ENCRYPTION_KEY_INVALID";

export class PersonsKeyError extends Error {
  public readonly code: PersonsKeyErrorCode;
  public readonly path: string | undefined;

  constructor(code: PersonsKeyErrorCode, message: string, path?: string) {
    super(message);
    this.name = "PersonsKeyError";
    this.code = code;
    this.path = path;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      path: this.path,
    };
  }
}

/** 密钥载体不存在（DESIGN-13 §7.6 / NFR-10：server 拒绝启动）。 */
export class EncryptionKeyMissingError extends PersonsKeyError {
  constructor(path: string) {
    super("ENCRYPTION_KEY_MISSING", `persons 加密密钥载体不存在：${path}`, path);
  }
}

/** 密钥格式非法（非 base64 / 解码后长度 ≠ 32 字节）。 */
export class EncryptionKeyInvalidError extends PersonsKeyError {
  constructor(message: string, path?: string) {
    super("ENCRYPTION_KEY_INVALID", message, path);
  }
}
