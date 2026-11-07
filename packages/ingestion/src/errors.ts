/**
 * errors.ts — IngestionError 基类 + 9 个具名子类
 *
 * 每个错误类对应 source.ts SourceErrorCode 中的一项错误码。
 * 错误中间件按 error.code 映射 HTTP 状态码。
 */

import type { SourceErrorCode, SourceErrorPayload } from "@knowself/contracts";

/** ingestion 包所有错误的基类。 */
export class IngestionError extends Error {
  readonly code: SourceErrorCode;

  constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = "IngestionError";
    this.code = code;
  }

  toPayload(): SourceErrorPayload {
    return { code: this.code, message: this.message };
  }
}

/** 404 — source id 不存在。 */
export class SourceNotFoundError extends IngestionError {
  constructor(sourceId: string) {
    super("SOURCE_NOT_FOUND", `Source not found: ${sourceId}`);
    this.name = "SourceNotFoundError";
  }
}

/** 404 — proposal id 不存在。 */
export class ProposalNotFoundError extends IngestionError {
  constructor(proposalId: string) {
    super("PROPOSAL_NOT_FOUND", `Proposal not found: ${proposalId}`);
    this.name = "ProposalNotFoundError";
  }
}

/** 400 — MIME 类型不在白名单。 */
export class UnsupportedMimeError extends IngestionError {
  constructor(mime: string) {
    super("UNSUPPORTED_MIME", `Unsupported MIME type: ${mime}`);
    this.name = "UnsupportedMimeError";
  }
}

/** 422 — extractor 执行失败（pdf-parse / mammoth / etc）。 */
export class ExtractorFailedError extends IngestionError {
  constructor(mime: string, detail: string) {
    super("EXTRACTOR_FAILED", `Extractor failed for ${mime}: ${detail}`);
    this.name = "ExtractorFailedError";
  }
}

/** 502 — kind=url 拉取失败。 */
export class UrlFetchFailedError extends IngestionError {
  constructor(url: string, detail: string) {
    super("URL_FETCH_FAILED", `Failed to fetch URL ${url}: ${detail}`);
    this.name = "UrlFetchFailedError";
  }
}

/** 413 — 上传文件超过大小限制。 */
export class FileTooLargeError extends IngestionError {
  constructor(maxBytes: number) {
    super("FILE_TOO_LARGE", `File exceeds maximum size of ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

/** 409 — proposal 已终态，不能再决策。 */
export class ProposalNotPendingError extends IngestionError {
  constructor(proposalId: string, status: string) {
    super("PROPOSAL_NOT_PENDING", `Proposal ${proposalId} is ${status}, cannot decide again`);
    this.name = "ProposalNotPendingError";
  }
}

/** 502 — 蒸馏 LLM 调用失败。 */
export class DistillFailedError extends IngestionError {
  constructor(detail: string) {
    super("DISTILL_FAILED", `Distill failed: ${detail}`);
    this.name = "DistillFailedError";
  }
}

/** 400 — proposal target 引用的 cardKey / date 不合法。 */
export class InvalidTargetRefError extends IngestionError {
  constructor(detail: string) {
    super("INVALID_TARGET_REF", `Invalid target reference: ${detail}`);
    this.name = "InvalidTargetRefError";
  }
}
