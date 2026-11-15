import { describe, it, expect } from "vitest";
import { makeInitialHealth, transitionOnSuccess, transitionOnFailure } from "../src/failover";

const NOW = "2026-05-27T00:00:00.000Z";

describe("makeInitialHealth", () => {
  it("creates healthy state with zero failures", () => {
    const h = makeInitialHealth("p1", NOW);
    expect(h.state).toBe("healthy");
    expect(h.consecutive_failures).toBe(0);
    expect(h.last_error).toBeNull();
    expect(h.reactivate_at).toBeNull();
  });
});

describe("transitionOnSuccess", () => {
  it("keeps healthy as healthy", () => {
    const h = transitionOnSuccess(makeInitialHealth("p1", NOW), 100, NOW);
    expect(h.state).toBe("healthy");
    expect(h.consecutive_failures).toBe(0);
  });

  it("restores degraded to healthy", () => {
    const degraded = { ...makeInitialHealth("p1", NOW), state: "degraded" as const };
    const h = transitionOnSuccess(degraded, 100, NOW);
    expect(h.state).toBe("healthy");
  });

  it("keeps dead as dead before reactivation time", () => {
    const dead = {
      ...makeInitialHealth("p1", NOW),
      state: "dead" as const,
      reactivate_at: "2026-06-01T00:00:00.000Z",
    };
    const h = transitionOnSuccess(dead, 100, NOW);
    expect(h.state).toBe("dead");
  });

  it("moves dead to degraded after reactivation time (half-open)", () => {
    const dead = {
      ...makeInitialHealth("p1", NOW),
      state: "dead" as const,
      reactivate_at: "2026-05-26T00:00:00.000Z",
    };
    const h = transitionOnSuccess(dead, 100, NOW);
    expect(h.state).toBe("degraded");
  });
});

describe("transitionOnFailure", () => {
  it("moves healthy to degraded on first failure", () => {
    const h = transitionOnFailure(
      makeInitialHealth("p1", NOW),
      { code: "UPSTREAM_5XX", message: "500", retryable: true, upstream_status: 500 },
      NOW,
    );
    expect(h.state).toBe("degraded");
    expect(h.consecutive_failures).toBe(1);
  });

  it("moves degraded to dead after 3 failures", () => {
    let health = makeInitialHealth("p1", NOW);
    const err = {
      code: "UPSTREAM_5XX" as const,
      message: "fail",
      retryable: true,
      upstream_status: 500,
    };

    health = transitionOnFailure(health, err, NOW);
    expect(health.state).toBe("degraded");
    expect(health.consecutive_failures).toBe(1);

    health = transitionOnFailure(health, err, NOW);
    expect(health.state).toBe("degraded");
    expect(health.consecutive_failures).toBe(2);

    health = transitionOnFailure(health, err, NOW);
    expect(health.state).toBe("dead");
    expect(health.consecutive_failures).toBe(3);
    expect(health.reactivate_at).not.toBeNull();
  });
});

/**
 * W-7/C：失败时把错误码与可重试性一起写进健康对象。
 *
 * 之前只写 `last_error` 文本，健康面板看不出「被限流」和「key 失效」的区别
 * —— 一个是等一会儿再试，一个是去换 key，提示完全不同。
 */
describe("transitionOnFailure 保留 code / retryable（W-7/C）", () => {
  it("401 → last_error_code=AUTH_FAILED、retryable=false", () => {
    const h = transitionOnFailure(
      makeInitialHealth("p1", NOW),
      { code: "AUTH_FAILED", message: "HTTP 401: invalid api key", retryable: false, upstream_status: 401 },
      NOW,
    );
    expect(h.last_error_code).toBe("AUTH_FAILED");
    expect(h.last_error_retryable).toBe(false);
    expect(h.last_error).toContain("invalid api key");
  });

  it("503 → last_error_code=UPSTREAM_5XX、retryable=true", () => {
    const h = transitionOnFailure(
      makeInitialHealth("p1", NOW),
      { code: "UPSTREAM_5XX", message: "HTTP 503: overloaded", retryable: true, upstream_status: 503 },
      NOW,
    );
    expect(h.last_error_code).toBe("UPSTREAM_5XX");
    expect(h.last_error_retryable).toBe(true);
  });

  it("429 → last_error_code=RATE_LIMITED、retryable=true（与 5xx 区分）", () => {
    const h = transitionOnFailure(
      makeInitialHealth("p1", NOW),
      {
        code: "RATE_LIMITED",
        message: "HTTP 429: inference exceeds tpm/rpm limit",
        retryable: true,
        upstream_status: 429,
      },
      NOW,
    );
    expect(h.last_error_code).toBe("RATE_LIMITED");
    expect(h.last_error_retryable).toBe(true);
  });

  it("成功后清空上次失败码", () => {
    const failed = transitionOnFailure(
      makeInitialHealth("p1", NOW),
      { code: "AUTH_FAILED", message: "HTTP 401", retryable: false, upstream_status: 401 },
      NOW,
    );
    expect(failed.last_error_code).toBe("AUTH_FAILED");

    const recovered = transitionOnSuccess(failed, 120, NOW);
    expect(recovered.last_error).toBeNull();
    expect(recovered.last_error_code).toBeNull();
    expect(recovered.last_error_retryable).toBeNull();
  });
});
