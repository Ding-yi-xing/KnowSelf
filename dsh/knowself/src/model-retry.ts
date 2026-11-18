/**
 * 模型调用的「供应商繁忙」无限重试。
 *
 * 背景：微信自动回复生成走 `host.llm.stream(...)`，是**直接调 dsh LLM 服务**，
 * 不经过 dsh 的 agent loop；而 dsh 的 `llm-retry` 插件挂在 `agent/request-error`
 * 瀑布上，所以那条无限重试策略对自动回复完全不生效——429 会一路冒到回复 worker，
 * 连续 3 次就把任务自动暂停（`REPLY_WORKER_LIMITS.failureLimit`）。
 *
 * 这里在「一次生成」外面套同等语义的重试：
 *   - 429 / RATE_LIMIT / 5xx / 超时 / 传输中断 → 无限重试（默认不限次数）；
 *   - 鉴权、额度、请求非法等终态错误 → 立刻抛，不掩盖真实故障；
 *   - 中途被打断（用户点停止、授权撤销、租约丢失）→ 立刻抛 AbortError，不吞。
 *
 * 为什么整段缓冲而不是边流边吐：重试意味着上一次产出作废，若已经把半截文本交给
 * 上游，重试会拼出重复内容。现有消费方（回复 worker、画像、蒸馏）都是先聚合再使用，
 * 因此每次只把**成功那一轮**的完整文本吐出去。
 *
 * @module @knowself/dsh-plugin/model-retry
 */

import type { ChatChunk, ChatOptions } from "@knowself/contracts";

/** 退避参数：2s 起步、指数增长、60s 封顶、±50% 抖动（多客户端不同步撞车）。 */
export const MODEL_RETRY_DEFAULTS = {
  initialDelayMs: 2_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.5,
} as const;

/** 明确可重试的失败码（与 dsh `RetryPolicy` 的可重试集合对齐）。 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE",
  "OVERLOADED",
  "RATE_LIMITED",
  "UPSTREAM_5XX",
  "STREAM_BROKEN",
]);

/** 明确不可重试的失败码：重试只会把错误藏起来。 */
const TERMINAL_CODES: ReadonlySet<string> = new Set([
  "AUTH",
  "AUTH_FAILED",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "INVALID_REQUEST",
  "INVALID_CREDENTIAL",
  "CONTEXT_WINDOW_EXCEEDED",
  "IMAGE_OFFLOAD_REQUIRED",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_DEAD",
  "ABORTED",
  "CANCELLED",
]);

/** 可重试的 HTTP 状态。 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * 供应商繁忙的文案兜底：有些网关 429 不写状态码，只回「并发已满」「服务繁忙」，
 * dsh 侧会归成 `PI_AI_ERROR`（默认终态）。这里按文案救回来，否则这类繁忙
 * 会绕过无限重试直接把回复判失败。
 */
const BUSY_TEXT = /rate.?limit|too many requests|\b429\b|overloaded|server (?:is )?busy|temporarily unavailable|超时|timeout|timed out|socket|ECONN[A-Z]+|other side closed|premature close|terminated|繁忙|并发|限流|排队|稍后重试/i;

/** 一次模型调用失败的结构化描述。 */
export class ModelFailure extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /** 上游/适配器显式给出的可重试标记（`ChatChunk.error.retryable`）。 */
  readonly retryable: boolean | undefined;

  constructor(
    message: string,
    detail: { code?: string | undefined; status?: number | undefined; retryAfterMs?: number | undefined; retryable?: boolean | undefined } = {},
  ) {
    super(message);
    this.name = "ModelFailure";
    this.code = detail.code;
    this.status = detail.status;
    this.retryAfterMs = Number.isFinite(detail.retryAfterMs) && (detail.retryAfterMs ?? 0) > 0 ? detail.retryAfterMs : undefined;
    this.retryable = detail.retryable;
  }
}

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(source: unknown, key: string): boolean | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

/** 把任意抛出物规整成可判定的失败描述（兼容 dsh `LlmError`、适配器 `ProviderError`、裸 Error）。 */
export function describeModelFailure(error: unknown): { code?: string; status?: number; retryAfterMs?: number; retryable?: boolean; message: string } {
  if (error instanceof ModelFailure) {
    return {
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      message: error.message,
    };
  }
  const failure = (error as { failure?: unknown } | null)?.failure;
  const code = readString(error, "code") ?? readString(failure, "code");
  const status = readNumber(error, "status") ?? readNumber(failure, "status") ?? readNumber(error, "upstream_status");
  const retryAfterMs = readNumber(error, "retryAfterMs")
    ?? readNumber(failure, "providerRetryAfterMs")
    ?? readNumber(error, "retry_after_ms")
    ?? readNumber(failure, "retryAfterMs");
  const retryable = readBoolean(error, "retryable");
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(retryable === undefined ? {} : { retryable }),
    message,
  };
}

/**
 * 判定一次失败是否值得无限重试。
 *
 * 优先信任结构化字段（code / status / retryable），再退回文案；未识别的一律**不重试**，
 * 避免把真正的程序缺陷或非法请求变成死循环。
 */
export function isRetryableModelFailure(error: unknown): boolean {
  // 用户主动停止/租约丢失不是「供应商繁忙」，不能拿去重试。
  if (error instanceof Error && error.name === "AbortError") return false;
  const failure = describeModelFailure(error);
  if (failure.code !== undefined) {
    if (TERMINAL_CODES.has(failure.code)) return false;
    if (RETRYABLE_CODES.has(failure.code)) return true;
  }
  if (failure.status !== undefined && RETRYABLE_STATUS.has(failure.status)) return true;
  if (failure.retryable !== undefined) return failure.retryable;
  return BUSY_TEXT.test(failure.message);
}

/** 第 `attempt` 次失败后的等待时长（1-based；含抖动，不超过 maxDelayMs）。 */
export function modelRetryDelayMs(
  attempt: number,
  config: {
    initialDelayMs?: number | undefined;
    maxDelayMs?: number | undefined;
    jitterRatio?: number | undefined;
    retryAfterMs?: number | undefined;
    random?: (() => number) | undefined;
  } = {},
): number {
  const initial = config.initialDelayMs ?? MODEL_RETRY_DEFAULTS.initialDelayMs;
  const max = config.maxDelayMs ?? MODEL_RETRY_DEFAULTS.maxDelayMs;
  const jitterRatio = config.jitterRatio ?? MODEL_RETRY_DEFAULTS.jitterRatio;
  const random = config.random ?? Math.random;
  const retryAfter = config.retryAfterMs;
  if (retryAfter !== undefined && retryAfter > 0) return Math.min(retryAfter, max);
  const exponent = Math.min(Math.max(attempt, 1) - 1, 20);
  const exponential = Math.min(initial * 2 ** exponent, max);
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random();
  return Math.max(1, Math.min(Math.round(exponential * jitter), max));
}

/** 可中断的等待：signal 一断立刻返回，不留下悬挂定时器。 */
export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(typeof reason === "string" && reason !== "" ? reason : "model call aborted");
  error.name = "AbortError";
  return error;
}

export type GenerateFn = (options: ChatOptions, signal: AbortSignal) => AsyncIterable<ChatChunk>;

export interface ModelRetryConfig {
  /** 首次失败的等待基线，默认 2000ms。 */
  initialDelayMs?: number;
  /** 单次等待上限，默认 60000ms。 */
  maxDelayMs?: number;
  /** 抖动比例（0~1），默认 0.5。 */
  jitterRatio?: number;
  /** 总尝试次数上限；默认 Infinity（用户要求「一直重试直到手动停止」）。 */
  maxAttempts?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 每次决定重试时回调（用于日志/观测）。 */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * 给任意 `generate(options, signal)` 套上「繁忙无限重试」。
 *
 * 每次尝试独立重开一个流（因此调用方自带的单次超时仍然逐次生效），整段缓冲，
 * 只有成功那一轮会把文本吐出。
 */
export function withModelRetry(generate: GenerateFn, config: ModelRetryConfig = {}): GenerateFn {
  const sleep = config.sleep ?? sleepWithSignal;
  const maxAttempts = config.maxAttempts ?? Number.POSITIVE_INFINITY;
  return (options: ChatOptions, signal: AbortSignal): AsyncIterable<ChatChunk> => {
    let attempt = 0;
    return (async function* retrying(): AsyncGenerator<ChatChunk> {
      for (;;) {
        if (signal.aborted) throw abortError(signal);
        attempt += 1;
        try {
          let text = "";
          for await (const chunk of generate(options, signal)) {
            if (signal.aborted) throw abortError(signal);
            if (chunk.type === "text") {
              text += chunk.delta;
              continue;
            }
            if (chunk.type === "error") {
              throw new ModelFailure(chunk.message, {
                status: chunk.upstream_status ?? undefined,
                ...(chunk.upstream_status === 429 ? { code: "RATE_LIMIT" } : {}),
                retryable: chunk.retryable,
                retryAfterMs: chunk.retry_after_ms ?? undefined,
              });
            }
          }
          // 成功：只吐出这一轮的完整文本（消费方都是先聚合再使用）。
          if (text !== "") yield { type: "text", delta: text };
          return;
        } catch (error) {
          if (signal.aborted) throw abortError(signal);
          if (attempt >= maxAttempts) throw error;
          if (!isRetryableModelFailure(error)) throw error;
          const failure = describeModelFailure(error);
          const delayMs = modelRetryDelayMs(attempt, {
            initialDelayMs: config.initialDelayMs,
            maxDelayMs: config.maxDelayMs,
            jitterRatio: config.jitterRatio,
            retryAfterMs: failure.retryAfterMs,
            random: config.random,
          });
          config.onRetry?.({ attempt, delayMs, error });
          await sleep(delayMs, signal);
          if (signal.aborted) throw abortError(signal);
        }
      }
    })();
  };
}
