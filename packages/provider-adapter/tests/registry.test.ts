import { describe, it, expect } from "vitest";
import { createRegistry } from "../dist/registry.js";
import type { ProviderConfig } from "@knowself/contracts";
import { makeInitialHealth, transitionOnFailure } from "../dist/failover.js";

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    label: "P1",
    protocol: "openai",
    base_url: "https://api.example.com/v1",
    api_key: "sk-test",
    model: "test",
    purposes: ["chat"],
    default_for: [],
    request_timeout_ms: 60000,
    max_retries: 1,
    max_concurrency: 4,
    extra_headers: {},
    declared_supports_tools: false,
    declared_supports_caching: false,
    tags: [],
    ...overrides,
  } as ProviderConfig;
}

describe("createRegistry", () => {
  describe("pickProvider", () => {
    it("returns null when no providers match the purpose", () => {
      const reg = createRegistry([makeConfig({ purposes: ["chat"] })]);
      expect(reg.pickProvider("rerank")).toBeNull();
    });

    it("returns the only matching provider", () => {
      const reg = createRegistry([makeConfig({ id: "chat", purposes: ["chat"] })]);
      const picked = reg.pickProvider("chat");
      expect(picked).not.toBeNull();
      expect(picked!.id).toBe("chat");
    });

    it("filters by purpose correctly", () => {
      const reg = createRegistry([
        makeConfig({ id: "chat-only", purposes: ["chat"] }),
        makeConfig({ id: "rerank-only", purposes: ["rerank"] }),
      ]);
      const picked = reg.pickProvider("rerank");
      expect(picked!.id).toBe("rerank-only");
    });

    it("sorts by latency_p50_ms ascending", () => {
      const reg = createRegistry([
        makeConfig({ id: "slow", purposes: ["chat"] }),
        makeConfig({ id: "fast", purposes: ["chat"] }),
      ]);
      reg.updateHealth("slow", {
        ...makeInitialHealth("slow", new Date().toISOString()),
        latency_p50_ms: 500,
      });
      reg.updateHealth("fast", {
        ...makeInitialHealth("fast", new Date().toISOString()),
        latency_p50_ms: 100,
      });

      const picked = reg.pickProvider("chat");
      expect(picked!.id).toBe("fast");
    });

    it("excludes dead providers by default", () => {
      const reg = createRegistry([makeConfig({ id: "dead-one", purposes: ["chat"] })]);
      reg.updateHealth("dead-one", {
        ...makeInitialHealth("dead-one", new Date().toISOString()),
        state: "dead",
      });

      expect(reg.pickProvider("chat")).toBeNull();
    });

    it("includes degraded providers in candidates", () => {
      const reg = createRegistry([makeConfig({ id: "degraded-only", purposes: ["chat"] })]);
      reg.updateHealth("degraded-only", {
        ...makeInitialHealth("degraded-only", new Date().toISOString()),
        state: "degraded",
      });

      expect(reg.pickProvider("chat")!.id).toBe("degraded-only");
    });

    it("includes dead provider after reactivate_at has passed (half-open)", () => {
      const reg = createRegistry([makeConfig({ id: "recovering", purposes: ["chat"] })]);
      const err = {
        code: "UPSTREAM_5XX" as const,
        message: "fail",
        retryable: true,
        upstream_status: 500,
      };
      let health = makeInitialHealth("recovering", new Date().toISOString());
      // 3 failures → dead
      health = transitionOnFailure(health, err, new Date().toISOString());
      health = transitionOnFailure(health, err, new Date().toISOString());
      health = transitionOnFailure(health, err, new Date().toISOString());
      expect(health.state).toBe("dead");

      // Manually override reactivate_at to the past
      health.reactivate_at = new Date(Date.now() - 1000).toISOString();
      reg.updateHealth("recovering", health);

      // pickProvider still excludes dead (half-open requires a success to move to degraded)
      expect(reg.pickProvider("chat")).toBeNull();
    });
  });

  describe("listHealth", () => {
    it("returns all provider health states", () => {
      const reg = createRegistry([makeConfig({ id: "a" }), makeConfig({ id: "b" })]);
      expect(reg.listHealth()).toHaveLength(2);
    });
  });

  describe("list", () => {
    it("returns all provider configs", () => {
      const reg = createRegistry([makeConfig({ id: "a" })]);
      expect(reg.list()).toHaveLength(1);
    });
  });
});
