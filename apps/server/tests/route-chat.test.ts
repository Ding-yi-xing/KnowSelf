import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createConversationStore } from "../src/persistence/conversation";
import { createAbortRegistry } from "../src/lib/abort";
import { chatRoutes } from "../src/routes/chat";
import { onError } from "../src/middleware/error";
import type { Runtime } from "../src/runtime";
import { createRuntime } from "../src/runtime";

function makeApp(runtime: Runtime) {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/chat", chatRoutes(runtime));
  return app;
}

describe("chat routes", () => {
  let db: Database.Database;
  let runtime: Runtime;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, last_provider_id TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, provider_id TEXT, model TEXT, turn_id TEXT);
    `);

    const store = createConversationStore(db);
    const abortRegistry = createAbortRegistry();

    runtime = createRuntime({
      conversationStore: store,
      abortRegistry: abortRegistry,
      settings: {
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
        providers: [],
        mcp_servers: [],
        builtin_tools: [],
        tool_defaults: {
          enabled_globally: true,
          fetch_fallback_policy: {} as never,
          per_template: { free_chat: true },
          system_prompt_addendum: "",
        },
        retrieval: {} as never,
        storage: {
          profile_dir: "profile",
          data_dir: "data",
          backup_enabled: false,
          backup_keep_days: 30,
        },
      } as Runtime["settings"],
      mcpHost: {
        getToolRegistry: () => ({
          list: () => [],
          get: () => null,
          invoke: () => ({}) as never,
          onChange: () => {},
        }),
      } as Runtime["mcpHost"],
      providerAdapter: {
        runWithTools: async function* () {
          yield { type: "text" as const, delta: "ok" } as never;
        },
        chat: async function* () {
          yield { type: "text" as const, delta: "ok" } as never;
        },
      } as Runtime["providerAdapter"],
      contextRouter: {
        buildContext: async () => ({
          messages: [{ role: "system", content: [{ kind: "text", text: "You are helpful." }] }],
          metadata: {
            l1_tokens: 0,
            l2_card_keys: [],
            l2_tokens: 0,
            l3_doc_ids: [],
            l3_tokens: 0,
            history_tokens: 0,
            total_tokens: 10,
            expected_cache_hits: 0,
            degradations: [],
            timings_ms: {
              classify: 0,
              fts5: 0,
              vector: 0,
              rerank: 0,
              expand: 0,
              budget: 0,
              total: 0,
            },
          },
        }),
      } as Runtime["contextRouter"],
      ingestion: { scheduleAutoDistill: () => {} } as Runtime["ingestion"],
    });
  });

  afterAll(() => db.close());

  it("POST /api/chat returns SSE stream", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    runtime.conversationStore.ensureConversation(convId, { title: "Test" });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convId,
        user_message: "hello",
        provider_id: "test",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  it("POST /api/chat validates input -> 422 for invalid", async () => {
    const app = makeApp(runtime);

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bad: true }),
    });

    expect(res.status).toBe(422);
  });

  it("POST /api/chat/abort returns success for valid id", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    runtime.abortRegistry.register(convId);

    const res = await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: convId }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("POST /api/chat/abort returns false for unknown id", async () => {
    const app = makeApp(runtime);

    const res = await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: randomUUID() }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("POST /api/chat passes registered tools to provider when tools are enabled", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    let seenTools: unknown[] | undefined;

    runtime.mcpHost = {
      getToolRegistry: () => ({
        list: () => [
          {
            name: "fetch__fetch" as never,
            source_id: "fetch" as never,
            bare_name: "fetch" as never,
            description: "Fetch URL",
            input_schema: { type: "object" },
            tags: [],
            declared_dangerous: false,
            timeout_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        get: () => null,
        invoke: () => ({}) as never,
        onChange: () => () => {},
        mergeFromSource: () => {},
        registerClient: () => {},
        getClient: () => undefined,
      }),
      init: async () => {},
      getStatus: () => ({ servers: [], tool_count: 0, all_ready: true, collected_at: "" }),
      shutdown: async () => {},
    } as Runtime["mcpHost"];
    runtime.providerAdapter = {
      runWithTools: async function* (opts) {
        seenTools = opts.tools;
        yield { type: "text" as const, delta: "ok" } as never;
      },
      chat: async function* () {
        yield { type: "text" as const, delta: "ok" } as never;
      },
    } as Runtime["providerAdapter"];

    runtime.conversationStore.ensureConversation(convId, { title: "Test" });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convId,
        user_message: "please use available tools",
        provider_id: "test",
      }),
    });

    await res.text();

    expect(res.status).toBe(200);
    expect(seenTools).toEqual([
      expect.objectContaining({
        name: "fetch__fetch",
        description: "Fetch URL",
      }),
    ]);
  });

  it("POST /api/chat prefetches explicit URLs and avoids provider tool schemas", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    let seenTools: unknown[] | undefined;
    let seenMessages: unknown[] | undefined;

    runtime.mcpHost = {
      getToolRegistry: () => ({
        list: () => [
          {
            name: "fetch__fetch" as never,
            source_id: "fetch" as never,
            bare_name: "fetch" as never,
            description: "Fetch URL",
            input_schema: { type: "object" },
            tags: [],
            declared_dangerous: false,
            timeout_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        get: (name) => (name === "fetch__fetch" ? ({} as never) : null),
        invoke: async () =>
          ({
            tool_use_id: "prefetch-1",
            name: "fetch__fetch",
            is_error: false,
            output: JSON.stringify({
              url: "https://example.test/article",
              status: 200,
              contentType: "text/plain",
              text: "article body",
            }),
            error_code: null,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 1,
            source_id: "fetch",
          }) as never,
        onChange: () => () => {},
        mergeFromSource: () => {},
        registerClient: () => {},
        getClient: () => undefined,
      }),
      init: async () => {},
      getStatus: () => ({ servers: [], tool_count: 0, all_ready: true, collected_at: "" }),
      shutdown: async () => {},
    } as Runtime["mcpHost"];
    runtime.providerAdapter = {
      runWithTools: async function* (opts) {
        seenTools = opts.tools;
        seenMessages = opts.messages;
        yield { type: "text" as const, delta: "ok" } as never;
      },
      chat: async function* () {
        yield { type: "text" as const, delta: "ok" } as never;
      },
    } as Runtime["providerAdapter"];

    runtime.conversationStore.ensureConversation(convId, { title: "Test" });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convId,
        user_message: "read https://example.test/article",
        provider_id: "test",
      }),
    });

    await res.text();

    expect(res.status).toBe(200);
    expect(seenTools).toEqual([]);
    expect(JSON.stringify(seenMessages)).toContain("article body");
  });

  it("POST /api/chat prefetches bare domains as HTTPS URLs", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    let seenTools: unknown[] | undefined;
    let seenMessages: unknown[] | undefined;
    let seenToolInput: unknown;

    runtime.mcpHost = {
      getToolRegistry: () => ({
        list: () => [
          {
            name: "fetch__fetch" as never,
            source_id: "fetch" as never,
            bare_name: "fetch" as never,
            description: "Fetch URL",
            input_schema: { type: "object" },
            tags: [],
            declared_dangerous: false,
            timeout_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        get: (name) => (name === "fetch__fetch" ? ({} as never) : null),
        invoke: async (call: { input: unknown }) => {
          seenToolInput = call.input;
          return {
            tool_use_id: "prefetch-1",
            name: "fetch__fetch",
            is_error: false,
            output: JSON.stringify({
              url: "https://www.dyx.company/",
              status: 200,
              contentType: "text/html",
              text: "dyx-blog personal homepage",
            }),
            error_code: null,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 1,
            source_id: "fetch",
          } as never;
        },
        onChange: () => () => {},
        mergeFromSource: () => {},
        registerClient: () => {},
        getClient: () => undefined,
      }),
      init: async () => {},
      getStatus: () => ({ servers: [], tool_count: 0, all_ready: true, collected_at: "" }),
      shutdown: async () => {},
    } as Runtime["mcpHost"];
    runtime.providerAdapter = {
      runWithTools: async function* (opts) {
        seenTools = opts.tools;
        seenMessages = opts.messages;
        yield { type: "text" as const, delta: "ok" } as never;
      },
      chat: async function* () {
        yield { type: "text" as const, delta: "ok" } as never;
      },
    } as Runtime["providerAdapter"];

    runtime.conversationStore.ensureConversation(convId, { title: "Test" });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convId,
        user_message: "请打开并用一句话总结：www.dyx.company",
        provider_id: "test",
      }),
    });

    await res.text();

    expect(res.status).toBe(200);
    expect(seenToolInput).toEqual({ url: "https://www.dyx.company" });
    expect(seenTools).toEqual([]);
    expect(JSON.stringify(seenMessages)).toContain("dyx-blog personal homepage");
  });

  it("POST /api/chat disables tools for providers that do not declare tool support", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    let seenTools: unknown[] | undefined;
    let seenMessages: unknown[] | undefined;

    runtime.mcpHost = {
      getToolRegistry: () => ({
        list: () => [
          {
            name: "fetch__fetch" as never,
            source_id: "fetch" as never,
            bare_name: "fetch" as never,
            description: "Fetch exact URL",
            input_schema: { type: "object" },
            tags: [],
            declared_dangerous: false,
            timeout_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        get: () => null,
        invoke: () => ({}) as never,
        onChange: () => () => {},
        mergeFromSource: () => {},
        registerClient: () => {},
        getClient: () => undefined,
      }),
      init: async () => {},
      getStatus: () => ({ servers: [], tool_count: 0, all_ready: true, collected_at: "" }),
      shutdown: async () => {},
    } as Runtime["mcpHost"];
    runtime.providerAdapter = {
      listProviders: () =>
        [
          {
            id: "test",
            declared_supports_tools: false,
          },
        ] as never,
      runWithTools: async function* (opts) {
        seenTools = opts.tools;
        seenMessages = opts.messages;
        yield { type: "text" as const, delta: "limited answer" } as never;
      },
      chat: async function* () {
        yield { type: "text" as const, delta: "ok" } as never;
      },
    } as Runtime["providerAdapter"];

    runtime.conversationStore.ensureConversation(convId, { title: "Test" });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convId,
        user_message: "please use available tools",
        provider_id: "test",
      }),
    });

    await res.text();

    expect(res.status).toBe(200);
    expect(seenTools).toEqual([]);
    expect(JSON.stringify(seenMessages)).not.toContain("runtime cannot actively search");
  });

  it("POST /api/chat does not treat fetch as search for open web lookup prompts", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    let seenTools: unknown[] | undefined;
    let seenMessages: unknown[] | undefined;
    let seenSearchInput: unknown;

    runtime.mcpHost = {
      getToolRegistry: () => ({
        list: () => [
          {
            name: "fetch__fetch" as never,
            source_id: "fetch" as never,
            bare_name: "fetch" as never,
            description: "Fetch exact URL",
            input_schema: { type: "object" },
            tags: [],
            declared_dangerous: false,
            timeout_ms: 60000,
            created_at: new Date().toISOString(),
          },
          {
            name: "web_search__search" as never,
            source_id: "web_search" as never,
            bare_name: "search" as never,
            description: "Search web",
            input_schema: { type: "object" },
            tags: [],
            declared_dangerous: false,
            timeout_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        get: (name) => (name === "web_search__search" ? ({} as never) : null),
        invoke: async (call: { input: unknown }) => {
          seenSearchInput = call.input;
          return {
            tool_use_id: "prefetch-search-1",
            name: "web_search__search",
            is_error: false,
            output: JSON.stringify({
              query: "\u5e2e\u6211\u627e\u4e00\u4e0b\u798f\u5efa\u6709\u54ea\u4e9b\u56fd\u4f01\u5355\u4f4d",
              results: [
                {
                  title: "\u798f\u5efa\u7701\u56fd\u8d44\u59d4",
                  url: "https://gzw.fujian.gov.cn/",
                  snippet: "\u7701\u5c5e\u4f01\u4e1a\u76f8\u5173\u4fe1\u606f",
                },
              ],
            }),
            error_code: null,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 1,
            source_id: "web_search",
          } as never;
        },
        onChange: () => () => {},
        mergeFromSource: () => {},
        registerClient: () => {},
        getClient: () => undefined,
      }),
      init: async () => {},
      getStatus: () => ({ servers: [], tool_count: 0, all_ready: true, collected_at: "" }),
      shutdown: async () => {},
    } as Runtime["mcpHost"];
    runtime.providerAdapter = {
      listProviders: () =>
        [
          {
            id: "test",
            declared_supports_tools: true,
          },
        ] as never,
      runWithTools: async function* (opts) {
        seenTools = opts.tools;
        seenMessages = opts.messages;
        yield { type: "text" as const, delta: "limited answer" } as never;
      },
      chat: async function* () {
        yield { type: "text" as const, delta: "ok" } as never;
      },
    } as Runtime["providerAdapter"];

    runtime.conversationStore.ensureConversation(convId, { title: "Test" });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convId,
        user_message:
          "\u5e2e\u6211\u627e\u4e00\u4e0b\u798f\u5efa\u6709\u54ea\u4e9b\u56fd\u4f01\u5355\u4f4d",
        provider_id: "test",
      }),
    });

    await res.text();

    expect(res.status).toBe(200);
    expect(seenSearchInput).toEqual({
      query: "\u5e2e\u6211\u627e\u4e00\u4e0b\u798f\u5efa\u6709\u54ea\u4e9b\u56fd\u4f01\u5355\u4f4d",
      max_results: 6,
    });
    expect(seenTools).toEqual([]);
    expect(JSON.stringify(seenMessages)).toContain("WEB_SEARCH");
    expect(JSON.stringify(seenMessages)).toContain("https://gzw.fujian.gov.cn/");
  });

  it("POST /api/chat retries without tools when provider rejects tool schemas with HTTP 400", async () => {
    const app = makeApp(runtime);
    const convId = randomUUID();
    const seenToolsByCall: unknown[] = [];
    let seenRetryMessages: unknown[] | undefined;

    runtime.mcpHost = {
      getToolRegistry: () => ({
        list: () => [
          {
            name: "fetch__fetch" as never,
            source_id: "fetch" as never,
            bare_name: "fetch" as never,
            description: "Fetch exact URL",
            input_schema: { type: "object" },
            tags: [],
            declared_dangerous: false,
            timeout_ms: 60000,
            created_at: new Date().toISOString(),
          },
        ],
        get: () => null,
        invoke: () => ({}) as never,
        onChange: () => () => {},
        mergeFromSource: () => {},
        registerClient: () => {},
        getClient: () => undefined,
      }),
      init: async () => {},
      getStatus: () => ({ servers: [], tool_count: 0, all_ready: true, collected_at: "" }),
      shutdown: async () => {},
    } as Runtime["mcpHost"];
    runtime.providerAdapter = {
      listProviders: () =>
        [
          {
            id: "test",
            declared_supports_tools: true,
          },
        ] as never,
      runWithTools: async function* (opts) {
        seenToolsByCall.push(opts.tools ?? []);
        if (seenToolsByCall.length === 1) {
          yield {
            type: "error" as const,
            upstream_status: 400,
            message: "HTTP 400",
            retryable: false,
          } as never;
          return;
        }
        seenRetryMessages = opts.messages;
        yield { type: "text" as const, delta: "fallback ok" } as never;
      },
      chat: async function* () {
        yield { type: "text" as const, delta: "ok" } as never;
      },
    } as Runtime["providerAdapter"];

    runtime.conversationStore.ensureConversation(convId, { title: "Test" });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: convId,
        user_message: "please use available tools",
        provider_id: "test",
      }),
    });

    const body = await res.text();

    expect(res.status).toBe(200);
    expect(seenToolsByCall).toHaveLength(2);
    expect(seenToolsByCall[0]).toEqual([
      expect.objectContaining({
        name: "fetch__fetch",
      }),
    ]);
    expect(seenToolsByCall[1]).toEqual([]);
    expect(JSON.stringify(seenRetryMessages)).toContain("fetch");
    expect(JSON.stringify(seenRetryMessages)).toContain("URL");
    expect(body).toContain("fallback ok");
    expect(body).not.toContain("PROVIDER_FAIL");
    expect(body).not.toContain("HTTP 400");
  });
});
