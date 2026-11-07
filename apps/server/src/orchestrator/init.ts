import { loadSettings } from "@knowself/config";
import { getDataPaths, ensureDataDirs } from "@knowself/config";
import { createProfileStore } from "@knowself/profile-store";
import type { ProfileStore } from "@knowself/profile-store";
import { createMcpHost } from "@knowself/mcp-host";
import type { McpHost } from "@knowself/mcp-host";
import { createProviderAdapter } from "@knowself/provider-adapter";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import { createIngestion } from "@knowself/ingestion";
import type { Ingestion } from "@knowself/ingestion";
import { createContextRouter } from "@knowself/context-router";
import type { ContextRouter } from "@knowself/context-router";
import { createPersonStore } from "@knowself/person-store";
import type { PersonStore } from "@knowself/person-store";
import type { AppSettings } from "@knowself/contracts";
import { openConversationsDb } from "../persistence/db";
import { createConversationStore } from "../persistence/conversation";
import { createAbortRegistry } from "../lib/abort";
import type { Runtime } from "../runtime";
import { gracefulShutdown } from "./shutdown";
import { startChatIndexSync } from "./chat-index-sync";
import { createChatMessageCommitter } from "@knowself/chat-ingest";

export interface BootResult {
  runtime: Runtime;
  settings: AppSettings;
}

export async function bootRuntime(rootDir: string): Promise<BootResult> {
  const settings = loadSettings(rootDir);
  const paths = getDataPaths(rootDir, settings.storage.data_dir);
  ensureDataDirs(paths);

  // 1. Profile store
  const profileStore: ProfileStore = createProfileStore({
    dbPath: paths.profileDbPath,
    sourcesDir: paths.sourcesDir,
    exportsDir: paths.exportsDir,
  });
  profileStore.templates.seedBuiltins();

  // 1b. Person store（persons.sqlite；mining 只读路由的数据源，DESIGN-12 §8.5）
  // 加密密钥走 DESIGN-13 §7.2 的载体优先级（ENV > 密钥文件）；`selfDisplayName`
  // 用 person-store 的文档兜底值 `'我'`（settings 无该字段，不臆造）。
  const personStore: PersonStore = createPersonStore({ dbPath: paths.personsDbPath });

  // 2. Conversations store
  const conversationsDb = openConversationsDb(paths.conversationsDbPath);
  const conversationStore = createConversationStore(conversationsDb);

  // 3. MCP host
  const mcpHost: McpHost = await createMcpHost({
    servers: settings.mcp_servers,
    builtin: settings.builtin_tools,
    toolDefaults: settings.tool_defaults,
  });
  await mcpHost.init();

  const toolRegistry = mcpHost.getToolRegistry();

  // 4. Provider adapter
  const providerAdapter: ProviderAdapter = createProviderAdapter({
    configs: settings.providers,
    toolRegistry,
  });
  await providerAdapter.init();

  // 5. Ingestion
  const ingestion: Ingestion = createIngestion({
    store: profileStore,
    providerAdapter,
    toolRegistry,
    sourcesDir: paths.sourcesDir,
    distillProviderId: settings.conversation.writeback_provider_id || "",
    // V3 / DESIGN-11 §7.2 #5：chat_message proposal 的落档提交器。
    // 不注入时 acceptProposal 的 chat_message 分支会抛 INVALID_TARGET_REF（不静默成功）。
    chatCommitter: createChatMessageCommitter(personStore),
  });

  // 6. Context router
  const contextRouter: ContextRouter = createContextRouter({
    profileStore,
    providerAdapter,
    config: settings.retrieval,
    dbPath: paths.retrievalDbPath,
    embeddingCacheDir: paths.modelsDir,
    // V3：聊天原文索引（K-33/K-36）。只读 person-store 公开读接口，
    // 索引写 retrieval.sqlite，不改 persons.sqlite。
    chatStore: personStore,
  });

  // 7. Abort registry
  const abortRegistry = createAbortRegistry();

  // 8. Shutdown items
  const shutdownItems: Array<{ name: string; fn: () => Promise<void> }> = [];

  const runtime: Runtime = {
    settings,
    paths,
    profileStore,
    conversationStore,
    mcpHost,
    providerAdapter,
    ingestion,
    contextRouter,
    abortRegistry,
    personStore,
    conversationsDb,
    profileDb: conversationsDb, // placeholder; actual profile db is inside profileStore
    shutdownItems,
  };

  // 9. 索引预热（V3，DESIGN-10 §7.4 "启动补偿"）
  //    索引是派生缓存：启动时后台重建，不阻塞 listen，失败只告警。
  //    ⚠️ 此前 V2 从未调用 buildFullIndex/buildChatIndex，L3 检索长期恒为空——本步补上断电点。
  //    跳过开关：`KNOWSELF_SKIP_BOOT_INDEX=1`；测试环境（NODE_ENV=test）默认跳过，
  //    避免后台任务与 init→shutdown 的用例竞态访问已关闭的 db。
  const skipBootIndex =
    process.env.KNOWSELF_SKIP_BOOT_INDEX === "1" || process.env.NODE_ENV === "test";
  if (!skipBootIndex) {
    void (async () => {
      try {
        const r = await contextRouter.buildFullIndex();
        console.info(`[index] profile 索引就绪：${r.chunkCount} chunks / ${r.durationMs}ms`);
      } catch (e) {
        console.warn("[index] profile 索引构建失败（L3 检索将降级为空）：", String(e));
      }
      try {
        const c = await contextRouter.buildChatIndex();
        console.info(
          `[index] 聊天索引就绪：${c.conversationCount} 会话 / ${c.windowCount} 窗口 / ${c.chunkCount} 行 / ${c.embeddedCount} 向量`,
        );
      } catch (e) {
        console.warn("[index] 聊天索引构建失败（聊天检索将为空）：", String(e));
      }
    })();
  }

  // 10. 落档事件 → 聊天索引增量重建（V3）
  //     启动预热只解决「冷启动时索引为空」；这一步解决「摄入完成后无需重启即可检索」。
  //     只订阅 messages_committed（回滚/合并不改正文，交给下次全量重建兜底）；
  //     内部串行+合并 conversation_ids，避免并发写 retrieval.sqlite。
  //     订阅能力缺失时不阻断启动（装配层容错：索引是派生缓存，缺它只是检索降级）。
  const chatIndexSync =
    typeof personStore.onCommitted === "function"
      ? startChatIndexSync({
          onCommitted: (listener) => personStore.onCommitted(listener),
          rebuild: (conversationIds) => contextRouter.buildChatIndex({ conversationIds }),
        })
      : null;
  if (chatIndexSync) {
    shutdownItems.push({ name: "chat-index-sync", fn: async () => chatIndexSync.stop() });
  }

  // Register shutdown handlers in reverse order
  shutdownItems.push(
    {
      name: "context-router",
      fn: async () => {
        contextRouter.shutdown();
      },
    },
    { name: "provider-adapter", fn: () => providerAdapter.shutdown() },
    { name: "mcp-host", fn: () => mcpHost.shutdown() },
    {
      name: "profile-db",
      fn: async () => {
        profileStore.close();
      },
    },
    {
      name: "conversations-db",
      fn: async () => {
        conversationsDb.close();
      },
    },
    {
      name: "persons-db",
      fn: async () => {
        personStore.close();
      },
    },
  );

  process.on("SIGINT", () => {
    void gracefulShutdown(runtime, "SIGINT");
  });
  process.on("SIGTERM", () => {
    void gracefulShutdown(runtime, "SIGTERM");
  });

  return { runtime, settings };
}
