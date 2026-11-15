import { describe, it, expect, vi } from "vitest";
import { runHealthcheck } from "../src/healthcheck";
import { createOpenAiAdapter } from "../src/adapter/openai";
import type { ProviderConfig } from "@knowself/contracts";

const testConfig: ProviderConfig = {
  id: "test-p",
  label: "Test Provider",
  protocol: "openai",
  base_url: "https://api.example.com",
  api_key: "sk-test",
  model: "test-model",
  purposes: ["chat"],
  default_for: [],
  request_timeout_ms: 60000,
  max_retries: 1,
  max_concurrency: 4,
  extra_headers: {},
  declared_supports_tools: true,
  declared_supports_caching: true,
  tags: [],
} as ProviderConfig;

const adapter = createOpenAiAdapter(testConfig);

describe("runHealthcheck", () => {
  it("reports ping_ok=true when server responds 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await runHealthcheck(
      adapter,
      testConfig,
      { ping: true, tools: false, caching: false },
      mockFetch as never,
    );

    expect(result.ping_ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it("reports ping_ok=false when server responds non-200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await runHealthcheck(
      adapter,
      testConfig,
      { ping: true, tools: false, caching: false },
      mockFetch as never,
    );

    expect(result.ping_ok).toBe(false);
    expect(result.error).toContain("500");
  });

  it("reports error when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await runHealthcheck(
      adapter,
      testConfig,
      { ping: true, tools: false, caching: false },
      mockFetch as never,
    );

    expect(result.ping_ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("skips ping when probe.ping is false", async () => {
    const mockFetch = vi.fn();

    const result = await runHealthcheck(
      adapter,
      testConfig,
      { ping: false, tools: false, caching: false },
      mockFetch as never,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.ping_ok).toBe(false);
  });

  it("skips tools check when declared_supports_tools is false", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const noToolsConfig = { ...testConfig, declared_supports_tools: false };

    const result = await runHealthcheck(
      adapter,
      noToolsConfig,
      { ping: false, tools: true, caching: false },
      mockFetch as never,
    );

    expect(result.tools_ok).toBe(false);
  });

  it("reports tools_ok when declared_supports_tools is true and probe.tools is true", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await runHealthcheck(
      adapter,
      testConfig,
      { ping: false, tools: true, caching: false },
      mockFetch as never,
    );

    expect(result.tools_ok).toBe(true);
  });

  it("reports caching_ok when declared and probed", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await runHealthcheck(
      adapter,
      testConfig,
      { ping: false, tools: false, caching: true },
      mockFetch as never,
    );

    expect(result.caching_ok).toBe(true);
  });

  it("captures ping fetch timeout as error", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 200)),
      );

    const result = await runHealthcheck(
      adapter,
      testConfig,
      { ping: true, tools: false, caching: false },
      mockFetch as never,
    );

    expect(result.ping_ok).toBe(false);
    expect(result.error).toContain("Timeout");
  });
});
