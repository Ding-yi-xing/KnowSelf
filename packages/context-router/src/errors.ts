/**
 * context-router 错误类层次
 *
 * RetrievalError 基类 + 5 个具名子类，
 * 错误码与 contracts/retrieval.ts RetrievalErrorCodeSchema 对齐。
 */

export class RetrievalError extends Error {
  public readonly code: string;
  public readonly trace_id: string | undefined;

  constructor(code: string, message: string, trace_id?: string) {
    super(message);
    this.code = code;
    this.trace_id = trace_id;
    this.name = "RetrievalError";
  }
}

export class EmbedModelLoadFailedError extends RetrievalError {
  constructor(message: string, trace_id?: string) {
    super("EMBED_MODEL_LOAD_FAILED", message, trace_id);
    this.name = "EmbedModelLoadFailedError";
  }
}

export class DbCorruptError extends RetrievalError {
  constructor(message: string, trace_id?: string) {
    super("DB_CORRUPT", message, trace_id);
    this.name = "DbCorruptError";
  }
}

export class IndexBusyError extends RetrievalError {
  constructor(message: string, trace_id?: string) {
    super("INDEX_BUSY", message, trace_id);
    this.name = "IndexBusyError";
  }
}

export class BudgetOverflowError extends RetrievalError {
  constructor(message: string, trace_id?: string) {
    super("BUDGET_OVERFLOW", message, trace_id);
    this.name = "BudgetOverflowError";
  }
}

export class RetrievalAbortedError extends RetrievalError {
  constructor(message: string, trace_id?: string) {
    super("ABORTED", message, trace_id);
    this.name = "RetrievalAbortedError";
  }
}
