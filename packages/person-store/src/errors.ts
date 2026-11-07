/**
 * person-store 错误类型（DESIGN-13 §7.6）。
 * 密钥类错误（ENCRYPTION_KEY_MISSING / ENCRYPTION_KEY_INVALID）由 `@knowself/config` 实现
 * （DESIGN-13 §7.2），本包只 re-export，不重复定义（避免同一错误码两个类）。
 */

export type PersonStoreErrorCode =
  | "PERSON_NOT_FOUND"
  | "ALIAS_UID_CONFLICT"
  | "MERGE_SELF_FORBIDDEN"
  | "MERGE_CYCLE"
  | "MERGE_ALREADY_MERGED"
  | "MANUAL_LOCKED"
  | "BATCH_INVALID"
  | "CURSOR_REGRESSION"
  | "APPEND_ONLY_VIOLATION"
  | "ENCRYPTION_MODE_MISMATCH"
  | "DB_CORRUPT"
  | "IMPORT_ORIGIN_LAYER_FORBIDDEN"
  | "EXPORT_BUNDLE_INVALID";

export class PersonStoreError extends Error {
  public readonly code: PersonStoreErrorCode;
  public readonly ref: string | undefined;
  public readonly traceId: string | undefined;

  constructor(code: PersonStoreErrorCode, message: string, ref?: string, traceId?: string) {
    super(message);
    this.name = "PersonStoreError";
    this.code = code;
    this.ref = ref;
    this.traceId = traceId;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      ref: this.ref,
      trace_id: this.traceId,
    };
  }
}

/** 人物不存在（DESIGN-13 §7.6）。 */
export class PersonNotFoundError extends PersonStoreError {
  constructor(message: string, personId?: string) {
    super("PERSON_NOT_FOUND", message, personId);
  }
}

/** 平台 ID 撞唯一键（`uq_aliases_platform_uid`）。 */
export class AliasConflictError extends PersonStoreError {
  constructor(message: string, ref?: string) {
    super("ALIAS_UID_CONFLICT", message, ref);
  }
}

/** 归并硬拒绝（DESIGN-13 §5.3）。 */
export class MergeForbiddenError extends PersonStoreError {
  constructor(
    code: "MERGE_SELF_FORBIDDEN" | "MERGE_CYCLE" | "MERGE_ALREADY_MERGED",
    message: string,
    ref?: string,
  ) {
    super(code, message, ref);
  }
}

/** 人工显式写锁定行且未 `force`。 */
export class ManualLockedError extends PersonStoreError {
  constructor(message: string, ref?: string) {
    super("MANUAL_LOCKED", message, ref);
  }
}

/** 批次不存在 / 已回滚（DESIGN-13 §4.3 步骤 1）。 */
export class BatchInvalidError extends PersonStoreError {
  constructor(message: string, batchId?: string) {
    super("BATCH_INVALID", message, batchId);
  }
}

/** 游标回退尝试（除 `restoreCursors` 外，游标单调不回退）。 */
export class CursorRegressionError extends PersonStoreError {
  constructor(message: string, ref?: string) {
    super("CURSOR_REGRESSION", message, ref);
  }
}

/** 对 `chat_messages` 的 UPDATE / DELETE（append-only 触发器）。 */
export class AppendOnlyViolationError extends PersonStoreError {
  constructor(message: string, messageId?: string) {
    super("APPEND_ONLY_VIOLATION", message, messageId);
  }
}

/** 库的 `encryption_mode` 与配置不符（DESIGN-13 §7.3 步骤 10）。 */
export class EncryptionModeMismatchError extends PersonStoreError {
  constructor(message: string) {
    super("ENCRYPTION_MODE_MISMATCH", message);
  }
}

/** `schema_version` 高于代码预期（拒绝打开）。 */
export class SchemaVersionError extends PersonStoreError {
  constructor(message: string) {
    super("DB_CORRUPT", message);
  }
}

/** 导入载荷含原文层（`chat_messages` 等）。 */
export class ImportForbiddenError extends PersonStoreError {
  constructor(message: string) {
    super("IMPORT_ORIGIN_LAYER_FORBIDDEN", message);
  }
}

/** 导出清单含密钥 / `retrieval.sqlite`。 */
export class ExportBundleError extends PersonStoreError {
  constructor(message: string) {
    super("EXPORT_BUNDLE_INVALID", message);
  }
}

export { EncryptionKeyInvalidError, EncryptionKeyMissingError } from "@knowself/config";
