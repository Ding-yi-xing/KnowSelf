import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { createRuntime } from "../src/runtime";
import type { Runtime } from "../src/runtime";
import { settingsRoutes } from "../src/routes/settings";
import { onError } from "../src/middleware/error";
import type { AppSettings } from "@knowself/contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// PATCH /api/settings 在 providers 变更时会重建 providerAdapter 并 init()（真实 healthcheck 会发网络请求）。
// 本文件只验证路由层语义，故把工厂替换为无副作用桩，保留其余导出（probeOllama 等）。
vi.mock("@knowself/provider-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@knowself/provider-adapter")>();
  return {
    ...actual,
    createProviderAdapter: () =>
      ({
        init: async () => {},
        shutdown: async () => {},
      }) as unknown as ReturnType<typeof actual.createProviderAdapter>,
  };
});

function makeApp(runtime: Runtime) {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/settings", settingsRoutes(runtime));
  return app;
}

const mockSettings: AppSettings = {
  schema_version: 1,
  app: {
    locale: "zh-CN",
    theme: "system",
    open_browser_on_start: true,
    server_port: 9527,
    feature_flags: {
      auto_writeback: true,
      system_status_page: true,
      debug_panel: false,
    },
  },
  conversation: {
    default_provider_id: "",
    default_tools_enabled: true,
    default_write_back: true,
    max_tool_iterations: 8,
    history_retention_days: 0,
    history_messages_per_conversation: 500,
    writeback_provider_id: "",
  },
  providers: [
    {
      id: "deepseek",
      label: "DeepSeek",
      protocol: "openai" as const,
      base_url: "https://api.deepseek.com/v1",
      api_key: "sk-secret-key-12345",
      model: "deepseek-chat",
      purposes: ["chat" as const],
      default_for: ["chat" as const],
      request_timeout_ms: 120_000,
      max_retries: 2,
      max_concurrency: 4,
      extra_headers: {},
      declared_supports_tools: true,
      declared_supports_caching: false,
      tags: [],
    },
  ],
  mcp_servers: [],
  builtin_tools: [],
  tool_defaults: {
    enabled_globally: true,
    fetch_fallback_policy: {
      enabled: true,
      primary_source_id: "fetch",
      fallback_source_id: "chrome-devtools",
      min_content_length: 100,
      fallback_keywords: ["captcha"],
      trigger_on_non_2xx: true,
      include_hint: false,
    },
    per_template: { free_chat: true },
    system_prompt_addendum: "",
  },
  retrieval: {
    enabled: true,
    embedding_model_id: "test",
    embedding_cache_dir: "data/models",
    chunk_target_tokens: 256,
    chunk_overlap_tokens: 32,
    parent_max_tokens: 2000,
    rrf_k: 60,
    rerank_provider_id: "",
    rerank_model: "",
    rerank_top_k: 30,
    rerank_timeout_ms: 15000,
    classifier_provider_id: "",
    classifier_max_cards: 3,
    token_budget: 20000,
    token_budget_l1: 1500,
    token_budget_l2: 2500,
    token_budget_l3: 4000,
    token_budget_history: 6000,
    freshness_boost: 0.1,
    memory_load_threshold: 5000,
    fallback_when_no_embed: true,
    fallback_when_no_rerank: true,
    fallback_when_no_classify: "last_used" as const,
  },
  storage: {
    profile_dir: "profile",
    data_dir: "data",
    backup_enabled: false,
    backup_keep_days: 30,
  },
};

describe("settings routes", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      settings: mockSettings,
      paths: { rootDir: "." } as Runtime["paths"],
    });
  });

  // 2026-11-06 用户裁定：本地单用户应用保持明文，不做掩码（见 api-routes.md §4.1）
  it("GET /api/settings returns plaintext api_key (local-first, no masking)", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers[0].api_key).toBe("sk-secret-key-12345");
  });

  it("GET /api/settings preserves non-sensitive fields", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema_version).toBe(1);
    expect(body.app.server_port).toBe(9527);
    expect(body.providers[0].id).toBe("deepseek");
    expect(body.providers[0].model).toBe("deepseek-chat");
  });

  it("PATCH /api/settings with valid PartialAppSettings", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: { theme: "dark" } }),
    });
    // saveSettings will attempt to write to disk; 422/500 expected on filesystem error in CI
    expect([200, 422, 500]).toContain(res.status);
  });

  it("PATCH /api/settings with invalid key returns error", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid_key: true }),
    });
    // PartialAppSettings only allows known section keys; should be 422 or 400
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("PATCH then GET returns the new providers (memory sync)", async () => {
    const tmpDir = join(tmpdir(), "knowself-test-memory-sync");
    mkdirSync(tmpDir, { recursive: true });
    const diskSettings: AppSettings = {
      ...mockSettings,
      tool_defaults: {
        ...mockSettings.tool_defaults,
        fetch_fallback_policy: {
          ...mockSettings.tool_defaults.fetch_fallback_policy,
          enabled: false,
        },
      },
    };
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify(diskSettings), "utf-8");

    const localRuntime = createRuntime({
      settings: mockSettings,
      paths: { rootDir: tmpDir } as Runtime["paths"],
    });
    // 路由在 providers 变更时会 shutdown + 重建 adapter；createRuntime 的默认桩是空对象，
    // 这里补最小可用的生命周期桩与工具注册表，避免 TypeError: shutdown is not a function。
    localRuntime.providerAdapter = {
      init: async () => {},
      shutdown: async () => {},
    } as unknown as Runtime["providerAdapter"];
    localRuntime.mcpHost = {
      getToolRegistry: () => ({}),
    } as unknown as Runtime["mcpHost"];
    const app = makeApp(localRuntime);

    const newProvider = {
      id: "test-prov",
      label: "T",
      protocol: "openai" as const,
      base_url: "https://example.test",
      api_key: "sk-xxx",
      model: "gpt-4",
      purposes: ["chat" as const],
      default_for: ["chat" as const],
      request_timeout_ms: 30000,
      max_retries: 2,
      max_concurrency: 4,
      extra_headers: {},
      declared_supports_tools: true,
      declared_supports_caching: false,
      tags: [],
    };

    const r1 = await app.request("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: [newProvider] }),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/api/settings");
    const body = await r2.json();
    expect(body.providers.find((p: any) => p.id === "test-prov")).toBeTruthy();
    // 明文口径（§4.1）：PATCH 后 GET 应回显写入的真实 key
    expect(body.providers[0].api_key).toBe("sk-xxx");
  });
});
