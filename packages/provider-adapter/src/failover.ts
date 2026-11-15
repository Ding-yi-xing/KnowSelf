import type { ProviderHealth, ProviderErrorPayload } from "@knowself/contracts";

const LATENCY_WINDOW = 20;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEAD_COOLDOWN_MS = 5 * 60 * 1000;

export function makeInitialHealth(providerId: string, _now: string): ProviderHealth {
  return {
    provider_id: providerId,
    state: "healthy",
    probed_supports_tools: false,
    probed_supports_caching: false,
    latency_p50_ms: null,
    consecutive_failures: 0,
    last_error: null,
    last_checked_at: null,
    reactivate_at: null,
  };
}

export function transitionOnSuccess(
  prev: ProviderHealth,
  latencyMs: number,
  now: string,
): ProviderHealth {
  const halfOpen = prev.state === "dead" && prev.reactivate_at && now >= prev.reactivate_at;

  let _nextState = prev.state;
  if (prev.state === "degraded" || halfOpen) {
    _nextState = "degraded"; // half-open stays degraded until multiple successes
  }

  return {
    ...prev,
    state: prev.state === "dead" ? (halfOpen ? "degraded" : "dead") : "healthy",
    latency_p50_ms: updateLatency(prev.latency_p50_ms, latencyMs),
    consecutive_failures: 0,
    last_error: null,
    // 成功即清空上次失败码，避免面板上「已恢复」却还挂着 AUTH_FAILED（W-7/C）
    last_error_code: null,
    last_error_retryable: null,
    last_checked_at: now,
    reactivate_at: null,
  };
}

export function transitionOnFailure(
  prev: ProviderHealth,
  error: ProviderErrorPayload,
  now: string,
): ProviderHealth {
  const failures = prev.consecutive_failures + 1;

  let state = prev.state;
  if (prev.state === "healthy") {
    state = "degraded";
  } else if (prev.state === "degraded" && failures >= MAX_CONSECUTIVE_FAILURES) {
    state = "dead";
  }

  return {
    ...prev,
    state,
    consecutive_failures: failures,
    last_error: error.message.slice(0, 512),
    // W-7/C：错误码与可重试性必须一起落到健康对象上，否则健康面板只能看到
    // 一段自由文本，分不清「被限流」和「key 失效」。
    last_error_code: error.code,
    last_error_retryable: error.retryable,
    last_checked_at: now,
    reactivate_at:
      state === "dead" ? new Date(Date.now() + DEAD_COOLDOWN_MS).toISOString() : prev.reactivate_at,
  };
}

function updateLatency(prev: number | null, next: number): number {
  if (prev === null) return next;
  return (prev * (LATENCY_WINDOW - 1) + next) / LATENCY_WINDOW;
}
