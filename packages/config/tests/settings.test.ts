import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the actual load/save functions against a temp directory.
// Since the module uses ESM, we import directly.

describe("loadSettings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-config-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid settings.json", async () => {
    const { loadSettings } = await import("../dist/settings.js");
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify(makeMinimalSettings()), "utf-8");
    const s = loadSettings(tmpDir);
    expect(s.schema_version).toBe(1);
    expect(s.app.locale).toBe("zh-CN");
    expect(s.providers).toHaveLength(1);
  });

  it("throws SettingsParseError for missing file", async () => {
    const { loadSettings, SettingsParseError } = await import("../dist/settings.js");
    expect(() => loadSettings(tmpDir)).toThrow(SettingsParseError);
  });

  it("throws SettingsParseError for invalid JSON", async () => {
    const { loadSettings, SettingsParseError } = await import("../dist/settings.js");
    writeFileSync(join(tmpDir, "settings.json"), "not json", "utf-8");
    expect(() => loadSettings(tmpDir)).toThrow(SettingsParseError);
  });

  it("throws SettingsValidationError for missing required field", async () => {
    const { loadSettings, SettingsValidationError } = await import("../dist/settings.js");
    const invalid = makeMinimalSettings();
    (invalid as Record<string, unknown>).app = {};
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify(invalid), "utf-8");
    expect(() => loadSettings(tmpDir)).toThrow(SettingsValidationError);
  });
});

describe("saveSettings", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-config-"));
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify(makeMinimalSettings()), "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves partial patch and re-reads correctly", async () => {
    const { loadSettings, saveSettings } = await import("../dist/settings.js");
    const saved = saveSettings(tmpDir, {
      app: { locale: "en-US" as const },
    });
    expect(saved.app.locale).toBe("en-US");
    // Re-read from disk
    const reloaded = loadSettings(tmpDir);
    expect(reloaded.app.locale).toBe("en-US");
    // Other fields unchanged
    expect(reloaded.app.theme).toBe("system");
  });

  it("rejects invalid default_provider_id reference", async () => {
    const { saveSettings, SettingsReferenceError } = await import("../dist/settings.js");
    expect(() =>
      saveSettings(tmpDir, {
        conversation: { default_provider_id: "nonexistent" },
      }),
    ).toThrow(SettingsReferenceError);
  });

  it("rejects duplicate purpose default_for", async () => {
    const { loadSettings, saveSettings, SettingsReferenceError } =
      await import("../dist/settings.js");
    const s = loadSettings(tmpDir);
    // Give the first provider default_for=["chat"] so that the duplicate is detected
    const providers = [
      { ...s.providers[0]!, default_for: ["chat" as const] },
      {
        ...s.providers[0]!,
        id: "dup-provider",
        default_for: ["chat" as const],
      } as (typeof s.providers)[number],
    ];
    expect(() => saveSettings(tmpDir, { providers })).toThrow(SettingsReferenceError);
  });

  it("uses atomic write (temp file cleaned up)", async () => {
    const { saveSettings } = await import("../dist/settings.js");
    const { readdirSync } = await import("node:fs");

    saveSettings(tmpDir, { app: { theme: "dark" as const } });
    // No .tmp files left behind
    const files = readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

function makeMinimalSettings() {
  return {
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
      default_provider_id: "test-provider",
      default_tools_enabled: true,
      default_write_back: true,
      max_tool_iterations: 8,
      history_retention_days: 0,
      history_messages_per_conversation: 500,
      writeback_provider_id: "test-provider",
    },
    providers: [
      {
        id: "test-provider",
        label: "Test",
        protocol: "openai" as const,
        base_url: "https://api.example.com/v1",
        api_key: "sk-test",
        model: "test-model",
        purposes: ["chat"] as const,
        default_for: [],
        request_timeout_ms: 60000,
        max_retries: 1,
        max_concurrency: 4,
        extra_headers: {},
        declared_supports_tools: false,
        declared_supports_caching: false,
        tags: [],
      },
    ],
    mcp_servers: [
      {
        id: "fetch",
        label: "Fetch",
        transport_config: {
          transport: "stdio" as const,
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-fetch"],
          env: {},
        },
        enabled: true,
        purpose: "",
        startup_timeout_ms: 30000,
        request_timeout_ms: 60000,
        max_concurrency: 4,
        restart_on_crash: true,
        max_restarts: 3,
        dead_cooldown_ms: 300000,
      },
    ],
    builtin_tools: [],
    tool_defaults: {
      enabled_globally: true,
      fetch_fallback_policy: {
        enabled: false,
        primary_source_id: "fetch",
        fallback_source_id: "chrome-devtools",
        min_content_length: 100,
        fallback_keywords: [],
        trigger_on_non_2xx: true,
        include_hint: false,
      },
      per_template: {},
      system_prompt_addendum: "",
    },
    retrieval: {
      enabled: true,
      embedding_model_id: "Xenova/bge-small-zh-v1.5",
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
}
