/**
 * services —— 领域服务装配层（薄桥接）。
 *
 * 本模块把 knowSelf 各领域包装配成插件所需的 `KnowselfServices`，
 * 本身不实现任何业务逻辑；写操作守卫（provenance / Tier）由对应领域库负责，
 * 插件只透传调用（见 HANDOFF 技术红线）。
 *
 * W3/T05：三层分段装配（05 §3 T05 + 复评 V1）：
 *   第 1 层 核心（必须成功）：loadSettings → getDataPaths → ensureDataDirs → createProfileStore
 *   第 2 层 人物（可失败）  ：createPersonStore（persons.sqlite，依赖密钥 + 另一份原生模块）
 *   第 3 层 检索/摄入（可失败）：createMcpHost().init() → createProviderAdapter().init()
 *                              → createContextRouter → createIngestion
 *
 * **personStore 绝不放回「必须成功」层**——它恰是当前故障点（密钥/ABI）所在；
 * 放进第 1 层会连累全部 15 个工具，重演「一个环境项废掉整个插件」。
 * 每层失败都写入 `degraded.missing` / `degraded.reasons`（含原始 error message），
 * 不吞掉异常信息；工具注册按依赖标签过滤（见 tools.ts）。
 *
 * 关键证据（W3 逐行核实）：`packages/ingestion/src/index.ts:46,52` 的
 * `chatCommitter?` / `chatRejecter?` 均为**可选**（缺省只让 chat_message 决议抛
 * INVALID_TARGET_REF，不影响资料摄入/蒸馏）。因此人物层失败时，第 3 层省略这两个
 * 参数仍可独立装配成功——摄入层不因人物层降级而一起失效。
 */
import {
  loadSettings,
  getDataPaths,
  ensureDataDirs,
  type DataPaths,
} from "@knowself/config";
import { createProfileStore, type ProfileStore } from "@knowself/profile-store";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { ensurePersonsKey, type PersonsKeyMode } from "./persons-key.js";
import { createProviderAdapter } from "@knowself/provider-adapter";
import { createMcpHost } from "@knowself/mcp-host";
import {
  createContextRouter,
  type ContextRouter,
} from "@knowself/context-router";
import {
  createIngestion,
  createSourceIntake,
  type Ingestion,
  type SourceIntake,
} from "@knowself/ingestion";
import * as chatIngestModule from "@knowself/chat-ingest";
import type {
  AppSettings,
  RetrieverConfig,
  ProviderConfig,
  WechatAssistSection,
} from "@knowself/contracts";
import {
  createWechatAssistAdapter,
  type WechatAssistAdapter,
} from "./wechat-assist-adapter.js";
import { createWindowsWechatTransport } from "./wechat-desktop-transport.js";

/** 可降级的能力层标识。 */
export type DegradedLayer = "person" | "retrieval" | "ingestion" | "mcp";

/** 降级可观测状态：缺失层 + 每层失败原因（中文，含原始 error message）。 */
export interface DegradedState {
  missing: DegradedLayer[];
  reasons: string[];
}

/** knowSelf 插件运行期所需的全部领域服务（三层分段装配）。 */
export interface KnowselfServices {
  /* 第 1 层：核心（必有） */
  rootDir: string;
  settings: AppSettings;
  paths: DataPaths;
  profileStore: ProfileStore;
  sourceIntake: SourceIntake;
  /* 第 2 层：人物（可缺，缺则相关工具不注册） */
  personStore?: PersonStore;
  /* 第 3 层：检索/摄入（可缺，整层可缺） */
  contextRouter?: ContextRouter;
  ingestion?: Ingestion;
  chatIngest?: typeof chatIngestModule;
  /** Host-side WeChat boundary; sending remains fail-closed without a transport. */
  wechatAssist?: WechatAssistAdapter;
  /* 可观测：可选以兼容 W1/W2 的 130 条测试桩（它们不提供该字段） */
  degraded?: DegradedState;
}

const DEFAULT_WECHAT_ASSIST_POLICY: WechatAssistSection = {
  enabled: false,
  send_enabled: false,
  drafts_only: true,
  allowlist: [],
  max_messages_per_hour: 6,
  cooldown_ms: 300_000,
};

/**
 * 三层装配所需的领域库工厂。声明为 `typeof <真实函数>` 保证类型与安装版本一致；
 * 可注入以便 T05 单测用纯桩验证分层降级，不触网、不开 DB、不依赖 vi.mock 整个模块图。
 */
export interface ServiceFactories {
  loadSettings: typeof loadSettings;
  getDataPaths: typeof getDataPaths;
  ensureDataDirs: typeof ensureDataDirs;
  createProfileStore: typeof createProfileStore;
  createSourceIntake: typeof createSourceIntake;
  /** MD2-4：人物层装配前的密钥确保（可注入，测试桩化以隔离真实 %APPDATA%）。 */
  ensurePersonsKey: typeof ensurePersonsKey;
  createPersonStore: typeof createPersonStore;
  createMcpHost: typeof createMcpHost;
  createProviderAdapter: typeof createProviderAdapter;
  createContextRouter: typeof createContextRouter;
  createIngestion: typeof createIngestion;
  chatIngest: typeof chatIngestModule;
}

/** 生产装配使用的真实工厂集合。 */
const DEFAULT_FACTORIES: ServiceFactories = {
  loadSettings,
  getDataPaths,
  ensureDataDirs,
  createProfileStore,
  createSourceIntake,
  ensurePersonsKey,
  createPersonStore,
  createMcpHost,
  createProviderAdapter,
  createContextRouter,
  createIngestion,
  chatIngest: chatIngestModule,
};

/** 从 unknown 取可读错误消息（不吞异常信息）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 选择蒸馏 provider：优先 purpose 含 'distill'，否则取第一个；都没有则报错。 */
function pickDistillProviderId(settings: AppSettings): string {
  const providers = (settings.providers ?? []) as Array<{
    id: string;
    purposes?: string[];
  }>;
  const distill = providers.find((p) => (p.purposes ?? []).includes("distill"));
  if (distill) return distill.id;
  if (providers[0]) return providers[0].id;
  throw new Error(
    'knowself: 未配置可用于蒸馏的 provider（至少需要一个含 purpose "distill" 的 provider）',
  );
}

/**
 * 派生检索/上下文构建所用的 provider_id（A1-1 降级逻辑）。
 *
 * 优先取 purpose 含 'chat' 或 'rerank' 的 provider（检索/重排最相关），
 * 否则退化为第一个 provider；都没有则回 undefined（交由领域层决定如何报错）。
 * agent 侧不必知道传哪个 provider，工具缺省时自动推导。
 */
export function pickRetrievalProviderId(settings: AppSettings): string | undefined {
  const providers = (settings.providers ?? []) as Array<{
    id: string;
    purposes?: string[];
  }>;
  const hit = providers.find((p) =>
    (p.purposes ?? []).some((pu) => /chat|rerank/i.test(pu)),
  );
  if (hit) return hit.id;
  if (providers[0]) return providers[0].id;
  return undefined;
}

/**
 * 按 rootDir 三层装配领域服务。
 *
 * 第 1 层抛错会**冒泡**（由 `apply` 的 A1-3 try/catch 整体降级）；
 * 第 2/3 层失败被就地捕获并写入 degraded，返回的服务对象仍可用。
 *
 * @param rootDir 数据根目录
 * @param deps 领域库工厂（默认真实实现；供单测注入纯桩）
 * @param personsKeyMode 密钥载体模式（默认 auto：装配期自动生成，见 persons-key.ts）
 */
export async function assembleServices(
  rootDir: string,
  deps: ServiceFactories = DEFAULT_FACTORIES,
  personsKeyMode: PersonsKeyMode = "auto",
): Promise<KnowselfServices> {
  // ── 第 1 层：核心（必须成功） ────────────────────────────────────────────
  const settings = deps.loadSettings(rootDir);
  const paths = deps.getDataPaths(rootDir);
  deps.ensureDataDirs(paths);
  const profileStore = deps.createProfileStore({
    dbPath: paths.profileDbPath,
    sourcesDir: paths.sourcesDir,
    exportsDir: paths.exportsDir,
  });
  const sourceIntake = deps.createSourceIntake({ store: profileStore });
  const wechatAssist = createWechatAssistAdapter(
    settings.automation?.wechat_assist ?? DEFAULT_WECHAT_ASSIST_POLICY,
    {
      transport: { desktop: createWindowsWechatTransport() },
      audit: { append: () => {} },
      persistence: profileStore.wechatAssist,
    },
  );

  const degraded: DegradedState = { missing: [], reasons: [] };

  // ── 第 2 层：人物（可失败） ──────────────────────────────────────────────
  let personStore: PersonStore | undefined;
  try {
    // MD2-4：createPersonStore 之前先确保密钥（auto 模式无密钥时原子生成）。
    // 生成成功只记路径（NFR-10：绝不打印密钥值）；任何失败落入本层 try/catch。
    const keyResult = deps.ensurePersonsKey({ mode: personsKeyMode });
    if (keyResult.created) {
      console.info("[knowself] 已生成本机人物库加密密钥：" + keyResult.path);
    }
    personStore = deps.createPersonStore({ dbPath: paths.personsDbPath });
  } catch (err) {
    degraded.missing.push("person");
    degraded.reasons.push(
      `人物层装配失败（createPersonStore）：${errorMessage(err)}`,
    );
  }

  let replyRetrievalDb: ReturnType<NonNullable<PersonStore>["openReplyRetrievalDb"]> | undefined;
  if (personStore !== undefined) {
    try {
      replyRetrievalDb = personStore.openReplyRetrievalDb(
        paths.replyRetrievalDbPath,
        paths.replyRetrievalSaltPath,
      );
    } catch (err) {
      degraded.reasons.push(`微信回复历史索引不可用：${errorMessage(err)}`);
    }
  }

  // ── 第 3 层：检索/摄入（可失败） ────────────────────────────────────────
  // MCP/Provider 是共同基础；Router 与 Ingestion 在共同基础成功后分别装配，
  // 避免一个能力失败把另一个能力一起标记为不可用。
  let contextRouter: ContextRouter | undefined;
  let ingestion: Ingestion | undefined;
  let chatIngest: typeof chatIngestModule | undefined;
  let toolRegistry: ReturnType<Awaited<ReturnType<typeof deps.createMcpHost>>["getToolRegistry"]>;
  let providerAdapter: Awaited<ReturnType<typeof deps.createProviderAdapter>>;

  try {
    const mcpHost = await deps.createMcpHost({
      servers: (settings.mcp_servers ?? []) as never,
      builtin: [] as never,
      toolDefaults: { confirm_dangerous: true } as never,
    });
    await mcpHost.init();
    toolRegistry = mcpHost.getToolRegistry();
  } catch (err) {
    degraded.reasons.push(`MCP 基础层装配失败：${errorMessage(err)}`);
    degraded.missing.push("mcp", "retrieval", "ingestion");
    return {
      rootDir,
      settings,
      paths,
      profileStore,
      sourceIntake,
      ...(personStore !== undefined ? { personStore } : {}),
      degraded,
    };
  }

  try {
    providerAdapter = deps.createProviderAdapter({
      configs: (settings.providers ?? []) as ProviderConfig[],
      toolRegistry,
    });
    await providerAdapter.init();
  } catch (err) {
    degraded.reasons.push(`Provider 基础层装配失败：${errorMessage(err)}`);
    degraded.missing.push("retrieval", "ingestion");
    return {
      rootDir,
      settings,
      paths,
      profileStore,
      sourceIntake,
      ...(personStore !== undefined ? { personStore } : {}),
      degraded,
    };
  }

  try {
    const retrieval = (settings.retrieval ?? {}) as unknown as RetrieverConfig;
    const retrievalRaw = settings.retrieval as {
      embedding_model_id?: string;
      embedding_cache_dir?: string;
      embedding_base_url?: string;
    } | undefined;
    const routerOpts: Record<string, unknown> = {
      profileStore,
      providerAdapter,
      config: retrieval,
      dbPath: paths.retrievalDbPath,
      ...(replyRetrievalDb === undefined ? {} : { replyRetrievalDb }),
    };
    if (retrievalRaw?.embedding_model_id) routerOpts.embeddingModelId = retrievalRaw.embedding_model_id;
    if (retrievalRaw?.embedding_cache_dir) routerOpts.embeddingCacheDir = retrievalRaw.embedding_cache_dir;
    if (retrievalRaw?.embedding_base_url) routerOpts.embeddingBaseUrl = retrievalRaw.embedding_base_url;
    contextRouter = deps.createContextRouter(
      routerOpts as unknown as Parameters<typeof createContextRouter>[0],
    );
    if (personStore !== undefined && contextRouter.replyRetrieval !== undefined) {
      const replyIndex = contextRouter.replyRetrieval;
      const source = {
        listMessages: (input: { conversation_id: string; after?: { ts_ms: number; message_id: string }; limit?: number }) => {
          const page = personStore!.replyHistory.listMessages(input);
          return {
            rows: page.rows.map((row) => ({
              message_id: row.message_id,
              conversation_id: row.conversation_id,
              sender_id: row.sender_id,
              role: row.role,
              ts_ms: row.ts_ms,
              content: row.content,
              content_type: row.content_type,
            })),
            next_cursor: page.next_cursor,
          };
        },
      };
      queueMicrotask(() => {
        for (const conversation of personStore!.replyHistory.listDirectConversations()) {
          try {
            replyIndex.syncConversation({
              conversation_id: conversation.conversation_id,
              contact_id: conversation.contact_id,
              title: conversation.title,
            }, source, { batchSize: 500 });
          } catch (error) {
            console.warn("[knowself] 回复历史索引同步失败", errorMessage(error));
          }
        }
      });
    }
  } catch (err) {
    degraded.reasons.push(`检索 Router 装配失败：${errorMessage(err)}`);
    degraded.missing.push("retrieval");
  }

  try {
    ingestion = deps.createIngestion({
      store: profileStore,
      providerAdapter,
      toolRegistry,
      sourcesDir: paths.sourcesDir,
      distillProviderId: pickDistillProviderId(settings),
      // 人物层成功才注入 committer/rejecter（依赖 personStore）。
      // 依据 packages/ingestion/src/index.ts:46,52 两者均为可选：
      // 缺省只影响 chat_message 决议，摄入/蒸馏仍可用，故人物层降级不连累本层。
      ...(personStore !== undefined
        ? {
            chatCommitter: deps.chatIngest.createChatMessageCommitter(personStore),
            chatRejecter: deps.chatIngest.createChatMessageRejecter(personStore),
          }
        : {}),
    });
    chatIngest = deps.chatIngest;
  } catch (err) {
    degraded.reasons.push(`摄入层装配失败：${errorMessage(err)}`);
    degraded.missing.push("ingestion");
  }

  // exactOptionalPropertyTypes：可选字段用条件展开，不显式赋 undefined。
  return {
    rootDir,
    settings,
    paths,
    profileStore,
    sourceIntake,
    wechatAssist,
    ...(personStore !== undefined ? { personStore } : {}),
    ...(contextRouter !== undefined ? { contextRouter } : {}),
    ...(ingestion !== undefined ? { ingestion } : {}),
    ...(chatIngest !== undefined ? { chatIngest } : {}),
    degraded,
  };
}

/**
 * 生产入口：按 rootDir 装配全部领域服务（真实工厂）。
 * `apply` 调用本函数；A1-3 的 try/catch 捕获第 1 层失败做整体降级。
 *
 * @param personsKeyMode 密钥载体模式（来自插件 Config，默认 auto）
 */
export async function createRealServices(
  rootDir: string,
  personsKeyMode: PersonsKeyMode = "auto",
): Promise<KnowselfServices> {
  return assembleServices(rootDir, DEFAULT_FACTORIES, personsKeyMode);
}
