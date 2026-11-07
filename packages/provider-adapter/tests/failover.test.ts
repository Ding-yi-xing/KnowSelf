import { describe, it, expect } from "vitest";
import { makeInitialHealth, transitionOnSuccess, transitionOnFailure } from "../dist/failover.js";

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
