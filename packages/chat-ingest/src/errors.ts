/**
 * chat-ingest 错误码（DESIGN-11 §8.1 逐字；**不新增** contracts 的 `SourceErrorCode`）。
 * 工单 6 落了前 6 个；本工单（Tier / 增量 / proposal / committer）补齐 §8.1 的其余 5 个。
 */
export type ChatIngestErrorCode =
  | "EXPORT_DIR_NOT_FOUND"
  | "EXPORT_FORMAT_UNKNOWN"
  | "READER_FAILED"
  | "ENCODING_UNDECODABLE"
  | "DESCRIPTOR_INVALID"
  | "NORMALIZE_FAILED"
  | "CURSOR_REGRESSION"
  | "STAGE_FAILED"
  | "COMMIT_FAILED"
  | "PROPOSAL_DECIDE_FAILED"
  /** §8.1「错误映射到既有错误码」：committer 未注入等目标引用问题复用该码。 */
  | "INVALID_TARGET_REF";

/** 携带错误码的异常；`cause` 保留底层原因（node 侧错误不得吞掉）。 */
export class ChatIngestError extends Error {
  readonly code: ChatIngestErrorCode;

  constructor(code: ChatIngestErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatIngestError";
    this.code = code;
  }
}

export function isChatIngestError(value: unknown): value is ChatIngestError {
  return value instanceof ChatIngestError;
}

/** 把任意抛出物转成可读消息（`useUnknownInCatchVariables` 下不得直接读 `.message`）。 */
export function describeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}
