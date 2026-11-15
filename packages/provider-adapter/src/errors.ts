import type { ProviderErrorCode, ProviderErrorPayload } from "@knowself/contracts";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string | undefined;
  readonly upstreamStatus: number | null;
  readonly retryable: boolean;
  readonly traceId: string | undefined;

  constructor(
    code: ProviderErrorCode,
    message: string,
    providerId?: string,
    upstreamStatus?: number | null,
    retryable = false,
    traceId?: string,
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.providerId = providerId;
    this.upstreamStatus = upstreamStatus ?? null;
    this.retryable = retryable;
    this.traceId = traceId;
  }

  toPayload(): ProviderErrorPayload {
    return {
      code: this.code,
      message: this.message,
      provider_id: this.providerId,
      upstream_status: this.upstreamStatus,
      retryable: this.retryable,
      trace_id: this.traceId,
    };
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(providerId?: string) {
    super(
      "PROVIDER_NOT_FOUND",
      `Provider not found: ${providerId ?? "unknown"}`,
      providerId,
      null,
      false,
    );
  }
}
export class ProviderDeadError extends ProviderError {
  constructor(providerId?: string) {
    super("PROVIDER_DEAD", `Provider dead: ${providerId ?? "unknown"}`, providerId, null, true);
  }
}
export class AuthFailedError extends ProviderError {
  constructor(providerId?: string, status?: number) {
    super(
      "AUTH_FAILED",
      `Auth failed: ${providerId ?? "unknown"}`,
      providerId,
      status ?? null,
      false,
    );
  }
}
export class RateLimitedError extends ProviderError {
  constructor(providerId?: string) {
    super("RATE_LIMITED", `Rate limited: ${providerId ?? "unknown"}`, providerId, 429, true);
  }
}
export class Upstream5xxError extends ProviderError {
  constructor(providerId?: string, status?: number) {
    super(
      "UPSTREAM_5XX",
      `Upstream error: ${providerId ?? "unknown"}`,
      providerId,
      status ?? null,
      true,
    );
  }
}
export class StreamBrokenError extends ProviderError {
  constructor(providerId?: string) {
    super("STREAM_BROKEN", `Stream broken: ${providerId ?? "unknown"}`, providerId, null, true);
  }
}
export class ToolLoopOverflowError extends ProviderError {
  constructor(providerId?: string) {
    super(
      "TOOL_LOOP_OVERFLOW",
      `Tool loop overflow: ${providerId ?? "unknown"}`,
      providerId,
      null,
      false,
    );
  }
}
export class ProviderAbortedError extends ProviderError {
  constructor(providerId?: string) {
    super("ABORTED", `Aborted: ${providerId ?? "unknown"}`, providerId, null, false);
  }
}

/**
 * 把上游 HTTP 状态码映射成 provider 侧错误码。
 *
 * - 401/403 → `AUTH_FAILED`：上层 `apps/server/src/errors.ts` 会把它映射成 401
 *   而不是 502，用户看到的是「检查 key」而不是「网关炸了」；
 * - 429 → `RATE_LIMITED`：限流是**可重试**的，必须与 5xx 区分开，
 *   否则健康面板看不出「是被限流了」而不是「上游挂了」；
 * - 其余一律 `UPSTREAM_5XX`（含 404：模型名不存在属上游/配置问题，不是鉴权问题）。
 *
 * @param status 上游 HTTP 状态码；null/undefined 表示没有拿到状态码
 * @returns 对应的 `ProviderErrorCode`
 */
export function codeForUpstreamStatus(
  status: number | null | undefined,
): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "UPSTREAM_5XX";
}

/**
 * 上游状态码是否值得重试。
 *
 * 5xx 与 429 都可重试；4xx（除 429）都是确定性拒绝，重试纯属浪费配额。
 * 单独成函数是为了让 `chat.ts` 与 `structured.ts` 用**同一套**判定，
 * 避免两边各写一份 `status >= 500` 而漏掉 429。
 *
 * @param status 上游 HTTP 状态码；null/undefined 视为不重试（没有状态码通常
 *   是本地错误，如参数非法）
 * @returns 是否应重试
 */
export function isRetryableStatus(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return status >= 500 || status === 429;
}
