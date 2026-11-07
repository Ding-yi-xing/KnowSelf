import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@knowself/config", () => ({
  loadSettings: vi.fn(() => defaultSettings()),
  // 形状须与 `DataPaths`（`packages/config/src/paths.ts`）一致：缺字段会让被测代码
  // 读到 `undefined` 而不报错（tests/ 不入 tsc 类型检查，见 apps/server/tsconfig.json）。
  getDataPaths: vi.fn(() => ({
    rootDir: "/tmp",
    dataDir: "/tmp/data",
    profileDbPath: ":memory:",
    conversationsDbPath: ":memory:",
    sourcesDir: "/tmp/sources",
    exportsDir: "/tmp/exports",
    retrievalDbPath: ":memory:",
    modelsDir: "/tmp/models",
    personsDbPath: ":memory:",
    automationDir: "/tmp/automation",
    automationDbPath: ":memory:",
  })),
  ensureDataDirs: vi.fn(),
}));

vi.mock("@knowself/profile-store", () => ({
  createProfileStore: vi.fn(() => mockProfileStore()),
}));

vi.mock("@knowself/mcp-host", () => ({
  createMcpHost: vi.fn(() => Promise.resolve(mockMcpHost())),
}));

vi.mock("@knowself/provider-adapter", () => ({
  createProviderAdapter: vi.fn(() => mockProviderAdapter()),
}));

vi.mock("@knowself/ingestion", () => ({
  createIngestion: vi.fn(() => ({})),
}));

vi.mock("@knowself/context-router", () => ({
  createContextRouter: vi.fn(() => ({
    shutdown: vi.fn(),
  })),
}));

// person-store 是 `bootRuntime` 第 1b 步（V3 工单 7c-2 接入）。不 mock 会走真实
// `openPersonDb` → SQLCipher 密钥解析 + 原生 better-sqlite3，超出本文件「编排接线」
// 的测试意图（其余 5 个包同样在工厂边界 mock）。
vi.mock("@knowself/person-store", () => ({
  createPersonStore: vi.fn(() => ({ close: vi.fn() })),
}));

function defaultSettings() {
  return {
    schema_version: 1,
    app: {
      locale: "zh-CN",
      theme: "system",
      open_browser_on_start: true,
      server_port: 9527,
      feature_flags: { auto_writeback: true, system_status_page: true, debug_panel: false },
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
    providers: [{ id: "test", api_key: "sk-secret" }],
    mcp_servers: [],
    builtin_tools: [],
    tool_defaults: {
      enabled_globally: true,
      fetch_fallback_policy: {},
      per_template: { free_chat: true },
      system_prompt_addendum: "",
    },
    retrieval: {},
    storage: {
      profile_dir: "profile",
      data_dir: "data",
      backup_enabled: false,
      backup_keep_days: 30,
    },
  };
}

function mockProfileStore() {
  return {
    core: {},
    cards: {},
    journal: {},
    sources: {},
    proposals: {},
    links: {},
    templates: { seedBuiltins: vi.fn() },
    events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
    write: vi.fn(),
    exportProfile: vi.fn(),
    close: vi.fn(),
  };
}

function mockMcpHost() {
  return {
    init: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
    getToolRegistry: vi.fn(() => ({
      list: vi.fn(() => []),
      get: vi.fn(() => null),
      invoke: vi.fn(),
      onChange: vi.fn(() => vi.fn()),
      mergeFromSource: vi.fn(),
      registerClient: vi.fn(),
      getClient: vi.fn(() => undefined),
    })),
  };
}

function mockProviderAdapter() {
  return {
    init: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
    runWithTools: vi.fn(),
    chat: vi.fn(),
  };
}

import { bootRuntime } from "../src/orchestrator/init";
import { gracefulShutdown } from "../src/orchestrator/shutdown";
import type { Runtime } from "../src/runtime";

describe("bootRuntime", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ce-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
    vi.restoreAllMocks();
  });

  it("在临时数据目录下能初始化全 6 个 packages 并返回 runtime", async () => {
    const { runtime } = await bootRuntime(tmpDir);
    expect(runtime).toHaveProperty("profileStore");
    expect(runtime).toHaveProperty("conversationStore");
    expect(runtime).toHaveProperty("mcpHost");
    expect(runtime).toHaveProperty("providerAdapter");
    expect(runtime).toHaveProperty("ingestion");
    expect(runtime).toHaveProperty("contextRouter");
    expect(runtime).toHaveProperty("abortRegistry");
  });

  it("在 settings.json 不存在时用默认 settings 初始化", async () => {
    const { settings } = await bootRuntime(tmpDir);
    expect(settings.schema_version).toBe(1);
  });

  it("在 settings.json 损坏时抛 PARSE_FAILED", async () => {
    const { loadSettings } = await import("@knowself/config");
    vi.mocked(loadSettings).mockImplementationOnce(() => {
      throw Object.assign(new Error("parse error"), { code: "PARSE_FAILED" });
    });
    await expect(bootRuntime(tmpDir)).rejects.toThrow();
  });

  it("bootRuntime 返回的 runtime.settings 包含 providers", async () => {
    const { settings } = await bootRuntime(tmpDir);
    expect(settings.providers).toHaveLength(1);
  });
});

describe("gracefulShutdown", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  function makeRuntime(items: Runtime["shutdownItems"] = []): Runtime {
    return {
      settings: {} as any,
      paths: {} as any,
      profileStore: { close: vi.fn() } as any,
      conversationStore: {} as any,
      mcpHost: {} as any,
      providerAdapter: {} as any,
      ingestion: {} as any,
      contextRouter: {} as any,
      abortRegistry: {} as any,
      personStore: { close: vi.fn() } as any,
      conversationsDb: { close: vi.fn() } as any,
      profileDb: {} as any,
      shutdownItems: items,
    };
  }

  it("关闭所有持有句柄的资源", async () => {
    const profileClose = vi.fn();
    const dbClose = vi.fn();
    const mcpShutdown = vi.fn(() => Promise.resolve());
    const items = [
      { name: "mcp-host", fn: mcpShutdown },
      { name: "profile-db", fn: profileClose },
      { name: "conversations-db", fn: dbClose },
    ];
    const runtime = makeRuntime(items);
    await gracefulShutdown(runtime, "SIGINT");
    expect(profileClose).toHaveBeenCalled();
    expect(mcpShutdown).toHaveBeenCalled();
    expect(dbClose).toHaveBeenCalled();
  });

  it("在某个资源 close 抛错时不影响其它资源关闭", async () => {
    const profileClose = vi.fn(() => {
      throw new Error("close failed");
    });
    const dbClose = vi.fn(() => Promise.resolve());
    const items = [
      { name: "profile-db", fn: profileClose },
      { name: "conversations-db", fn: dbClose },
    ];
    const runtime = makeRuntime(items);
    await gracefulShutdown(runtime, "SIGTERM");
    expect(profileClose).toHaveBeenCalled();
    expect(dbClose).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
