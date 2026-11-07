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
