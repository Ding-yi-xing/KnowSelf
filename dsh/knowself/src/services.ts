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
import { createPersonStore, EncryptionKeyInvalidError, type PersonStore } from "@knowself/person-store";
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
  ChatChunk,
  ChatOptions,
  RetrieverConfig,
  ProviderConfig,
  WechatAssistSection,
} from "@knowself/contracts";
import {
  createWechatAssistAdapter,
  type WechatAssistAdapter,
  type WechatDesktopTransport,
} from "./wechat-assist-adapter.js";
import { createWindowsWechatTransport } from "./wechat-desktop-transport.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createWechatReplyContextService } from "./wechat-reply-context.js";
import { isRealEmoji, normalizeForRepeat } from "./reply-quality.js";
import { parseFacts, serializeFacts } from "./reply-facts.js";
import { loadPersonaFromDisk, savePersonaToDisk } from "./persona-store.js";
import { pickIdentityLine } from "./reply-identity.js";
import { buildIdentityExtractionPrompt, formatIdentityStatesForPrompt, parseIdentityStates } from "./identity-timeline.js";
import { REPLY_WORKER_LIMITS, runWechatReplyWorker } from "./wechat-reply-worker.js";
import { buildReplyPersona, deserializeReplyPersona, REPLY_PERSONA_VERSION, type ReplyPersona } from "./wechat-persona.js";
import { ModelFailure, withModelRetry, type GenerateFn } from "./model-retry.js";
import { quarantineReplyIndex, quarantineStamp } from "./reply-index-recovery.js";
import { resolveHistoryContactId } from "./reply-context-identity.js";

/** 可降级的能力层标识。 */
export type DegradedLayer = "person" | "retrieval" | "ingestion" | "mcp";

/** 降级可观测状态：缺失层 + 每层失败原因（中文，含原始 error message）。 */
export interface DegradedState {
  missing: DegradedLayer[];
  reasons: string[];
}

/** dsh 宿主提供的模型选择（`ctx.agentDefaultModel.currentSelection()`）。 */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** dsh 宿主的 LLM 运行时（`ctx.llm`），只用到最小流式与目录子集。 */
export interface DshLlmStreamLike {
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
  listProviders?(): Array<{ id: string; name: string }>;
  listModels?(provider: string): Promise<Array<{ id: string; name?: string; description?: string }>>;
}

/** 宿主注入的可选能力；缺失时回退到 knowSelf 自己的 provider 配置。 */
export interface KnowselfHostDeps {
  llm?: DshLlmStreamLike;
  agentDefaultModel?: { currentSelection(): DshModelSelection };
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
  /** Read-only capability probe for the host-side desktop bridge. */
  wechatTransport?: WechatDesktopTransport;
  /** dsh 当前模型选择；自动回复优先使用它，而不是 knowself settings.providers。 */
  resolveDshModel?: () => { provider: string; model: string } | undefined;
  /** dsh 已配置的模型目录（provider + model），供微信协助选择器使用。 */
  listDshModels?: () => Promise<Array<{ provider: string; model: string; label: string }>>;
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
  proactive_interval_ms: 900_000,
  quiet_send: true,
  quiet_min_idle_ms: 60_000,
  quiet_max_wait_ms: 120_000,
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

/**
 * 微信 bridge 的 Python 解释器：优先环境变量，其次项目内 venv（含
 * uiautomation/pywin32/numpy/cryptography 等 UIA 依赖），最后**探测本机哪个
 * Python 真的装了 uiautomation**。
 *
 * 为什么必须探测：transport 默认走 `py -3`，而 `py` 的默认版本可能正是**没装**
 * uiautomation 的那个（本机实测 `py -3` → 3.14 无依赖 → bridge 直接
 * ModuleNotFoundError → transport 恒 503「微信 transport 能力未通过安全校验」）。
 * 这里按 3.11/3.12/3.13/默认 顺序试导入，用第一个能 import 的解释器。
 */
function wechatPythonExecutable(rootDir: string): string | undefined {
  const configured = process.env.KNOWSELF_WECHAT_PYTHON?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const venv = join(rootDir, "data", "wechat-runtime", "venv", "Scripts", "python.exe");
  if (existsSync(venv)) return venv;
  return detectUiaPython();
}

/** 探测能 `import uiautomation, win32gui` 的解释器路径（结果缓存，失败返回 undefined）。 */
let cachedUiaPython: string | null | undefined;
function detectUiaPython(): string | undefined {
  if (cachedUiaPython !== undefined) return cachedUiaPython ?? undefined;
  const probe = "import uiautomation, win32gui, sys; print(sys.executable)";
  const candidates: Array<[string, string[]]> = [
    ["py", ["-3.11", "-c", probe]],
    ["py", ["-3.12", "-c", probe]],
    ["py", ["-3.13", "-c", probe]],
    ["py", ["-3", "-c", probe]],
    ["python", ["-c", probe]],
  ];
  for (const [exe, args] of candidates) {
    try {
      const result = spawnSync(exe, args, { encoding: "utf8", timeout: 8_000, windowsHide: true });
      const path = (result.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
      if (result.status === 0 && path !== "" && existsSync(path)) {
        cachedUiaPython = path;
        return path;
      }
    } catch {
      /* 继续试下一个解释器 */
    }
  }
  cachedUiaPython = null;
  return undefined;
}

/** 把 knowSelf 的 ChatOptions 压成 dsh `llm.stream` 的一次性请求。 */
function flattenChatMessages(options: ChatOptions): { system: string; user: string } {
  let system = "";
  const lines: string[] = [];
  for (const message of options.messages) {
    const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
    const text = content
      .map((part) => (typeof part["text"] === "string" ? (part["text"] as string) : ""))
      .join("");
    if (message.role === "system") {
      system = system === "" ? text : `${system}\n${text}`;
      continue;
    }
    if (text.trim() === "") continue;
    lines.push(`${String(message.role)}: ${text}`);
  }
  return { system, user: lines.join("\n") };
}

/** 用 dsh 当前模型生成回复；每次调用都重新读取选择，支持在 dsh 里手动切换模型。 */
export function createDshGenerate(
  host: KnowselfHostDeps,
  resolveModel: () => { provider: string; model: string } | undefined,
  fallback: { provider: string; model: string },
  /** 单次尝试的超时（超过就交给重试层再抢一次），默认 60s；测试可注入短值。 */
  limits: { attemptTimeoutMs?: number } = {},
) {
  const attemptTimeoutMs = limits.attemptTimeoutMs ?? 60_000;
  return (options: ChatOptions, signal: AbortSignal): AsyncIterable<ChatChunk> => {
    const llm = host.llm;
    if (llm === undefined) throw new Error("dsh LLM 运行时不可用");
    const selection = resolveModel() ?? fallback;
    const { system, user } = flattenChatMessages(options);
    let deltas = 0;
    let sawDelta = false;
    let finishKind = "none";
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]);
    // 单次尝试超时**不是**用户停止：要在重试层被认成 TIMEOUT 继续抢，而不是判失败。
    const timedOutAlone = (): boolean => !signal.aborted && callSignal.aborted;
    return (async function* () {
      const stream = llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...(system === "" ? {} : { system }),
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        maxTokens: options.max_tokens,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.stop_sequences.length === 0 ? {} : { stop: options.stop_sequences }),
        signal: callSignal,
      });
      try {
        for await (const chunk of stream) {
          if (chunk["type"] === "text-delta" && typeof chunk["text"] === "string") {
            deltas += 1;
            sawDelta = true;
            yield { type: "text", delta: chunk["text"] as string } as ChatChunk;
          } else if (chunk["type"] === "block-end") {
            const block = chunk["block"] as { type?: string; text?: string } | undefined;
            if (!sawDelta && block?.type === "text" && typeof block.text === "string" && block.text !== "") {
              deltas += 1;
              yield { type: "text", delta: block.text } as ChatChunk;
            }
          } else if (chunk["type"] === "finish") {
            const reason = chunk["reason"] as { kind?: string; failure?: { code?: string; status?: number; message?: string; providerRetryAfterMs?: number } } | undefined;
            finishKind = reason?.kind ?? "unknown";
            if (reason?.kind === "error" || reason?.kind === "aborted") {
              // 带上结构化失败信息：429/5xx 要能被 model-retry 认成「可重试」。
              throw new ModelFailure(
                reason.failure?.message ?? (timedOutAlone() ? "dsh 模型调用超时（60s）" : "dsh 模型调用失败"),
                {
                  code: timedOutAlone() ? "TIMEOUT" : reason.failure?.code,
                  status: reason.failure?.status,
                  retryAfterMs: reason.failure?.providerRetryAfterMs,
                },
              );
            }
          }
        }
      } catch (error) {
        if (timedOutAlone()) {
          // 自己的 60s 单次超时：交给 model-retry 退避重试。
          throw new ModelFailure("dsh 模型调用超时（60s）", { code: "TIMEOUT" });
        }
        console.warn("[knowself] dsh 模型调用异常", errorMessage(error));
        throw error;
      }
      if (deltas === 0) {
        console.warn("[knowself] dsh 模型没有返回文本", { provider: selection.provider, model: selection.model, finishKind });
      }
    })();
  };
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
  host: KnowselfHostDeps = {},
): Promise<KnowselfServices> {
  const listDshModels = async (): Promise<Array<{ provider: string; model: string; label: string }>> => {
    const llm = host.llm;
    if (llm?.listProviders === undefined || llm.listModels === undefined) return [];
    const result: Array<{ provider: string; model: string; label: string }> = [];
    for (const provider of llm.listProviders()) {
      let models: Array<{ id: string; name?: string }> = [];
      try {
        models = await llm.listModels(provider.id);
      } catch {
        models = [];
      }
      for (const model of models) {
        result.push({ provider: provider.id, model: model.id, label: `${provider.name} · ${model.name ?? model.id}` });
      }
    }
    return result;
  };

  const dshResolveModel = (): { provider: string; model: string } | undefined => {
    try {
      const selection = host.agentDefaultModel?.currentSelection();
      return selection !== undefined && selection.provider !== "" && selection.model !== ""
        ? { provider: selection.provider, model: selection.model }
        : undefined;
    } catch {
      return undefined;
    }
  };
  // ── 第 1 层：核心（必须成功） ────────────────────────────────────────────
  const settings = deps.loadSettings(rootDir);
  const paths = deps.getDataPaths(rootDir);
  deps.ensureDataDirs(paths);
  const profileStore = deps.createProfileStore({
    dbPath: paths.profileDbPath,
    sourcesDir: paths.sourcesDir,
    exportsDir: paths.exportsDir,
  });
  profileStore.wechatAssist.recoverInterruptedWork(new Date().toISOString());
  const sourceIntake = deps.createSourceIntake({ store: profileStore });
  const wechatTransport = createWindowsWechatTransport({
    ...(wechatPythonExecutable(rootDir) === undefined
      ? {}
      : { pythonExecutable: wechatPythonExecutable(rootDir)! }),
    // 静默发送：不抢前台、不动鼠标、不覆盖剪贴板；等你空闲才动手（见 transport 注释）。
    quietSend: settings.automation?.wechat_assist?.quiet_send ?? true,
    quietMinIdleMs: settings.automation?.wechat_assist?.quiet_min_idle_ms ?? 60_000,
    quietMaxWaitMs: settings.automation?.wechat_assist?.quiet_max_wait_ms ?? 120_000,
  });
  const wechatAssist = createWechatAssistAdapter(
    settings.automation?.wechat_assist ?? DEFAULT_WECHAT_ASSIST_POLICY,
    {
      transport: { desktop: wechatTransport },
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
    // 修正历史导出的会话类型（wxid 直聊曾被写成 group）；UPSERT 不改 kind，必须启动时自愈。
    try {
      const conversations = personStore.conversations as typeof personStore.conversations | undefined;
      const reclassify = conversations?.reclassifyBySuffix;
      if (typeof reclassify === "function") {
        const fixed = reclassify.call(conversations, new Date().toISOString());
        if (fixed.updated > 0) {
          console.info(`[knowself] 已修正 ${fixed.updated} 个会话的直聊/群聊分类`);
        }
      }
    } catch (err) {
      console.warn(`[knowself] 会话分类自愈失败：${errorMessage(err)}`);
    }
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
      if (err instanceof EncryptionKeyInvalidError) {
        // salt 被重建 / 根密钥轮换 / 索引文件损坏 → 旧派生索引解不开。
        // 派生索引可由 persons.sqlite 重建，所以隔离旧文件后用当前密钥重开一次，
        // 而不是让「加密聊天历史上下文」永久不可用（否则每个勾选历史授权的任务都会暂停）。
        const { moved, failed } = quarantineReplyIndex(
          paths.replyRetrievalDbPath,
          quarantineStamp(new Date()),
        );
        if (failed.length > 0) {
          degraded.reasons.push(
            `微信回复历史索引密钥失效，旧索引无法隔离（宿主仍占用 ${failed.length} 个文件）：` +
              `关闭桌面 App 后重新打开会自动重建`,
          );
        } else {
          try {
            replyRetrievalDb = personStore.openReplyRetrievalDb(
              paths.replyRetrievalDbPath,
              paths.replyRetrievalSaltPath,
            );
            degraded.reasons.push(
              `微信回复历史索引已重建（旧索引密钥失效，已隔离 ${moved.length} 个文件；历史回填在后台进行）`,
            );
            console.warn("[knowself] 回复历史索引已重建", { moved });
          } catch (retryErr) {
            degraded.reasons.push(`微信回复历史索引重建失败：${errorMessage(retryErr)}`);
          }
        }
      } else {
        degraded.reasons.push(`微信回复历史索引不可用：${errorMessage(err)}`);
      }
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
  let replyContextService: ReturnType<typeof createWechatReplyContextService> | undefined;

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
      replyContextService = createWechatReplyContextService({
        history: personStore.replyHistory,
        index: replyIndex,
        source,
        audit: (entry) => profileStore.wechatAssist.appendAudit({
          at: new Date().toISOString(),
          action: "reply_context_shared",
          draft_id: entry.task_id,
          contact_id: entry.contact_id_hash,
          reason: `history_context:${entry.source_count}:${entry.estimated_chars}:${entry.authorization_version}:${entry.source_message_ids_hash}`,
        }),
      });
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

  const providerConfigs = (settings.providers ?? []) as ProviderConfig[];
  /**
   * 生成函数统一出口。套一层「供应商繁忙无限重试」：
   * dsh 的 `llm-retry` 挂在 agent loop 的 `agent/request-error` 上，而自动回复是
   * 直调 `host.llm.stream`，那条策略根本不触发——429 会一路冒到 worker，
   * 连续 3 次就把任务暂停。这里补上同等语义的无限重试（详细规则见 model-retry.ts）。
   */
  const generateForTask = (task: { provider_id: string; model_id: string }): GenerateFn => {
    const fixed = task.provider_id !== "" && task.model_id !== ""
      ? { provider: task.provider_id, model: task.model_id }
      : undefined;
    const raw: GenerateFn = host.llm === undefined
      ? (options: ChatOptions, signal: AbortSignal) => providerAdapter.chat(options, signal)
      : createDshGenerate(host, () => fixed ?? dshResolveModel(), fixed ?? { provider: "", model: "" });
    return withModelRetry(raw, {
      onRetry: ({ attempt, delayMs, error }) => {
        console.warn("[knowself] 模型繁忙，等待后重试", { attempt, delayMs, error: errorMessage(error) });
      },
    });
  };
  /**
   * 身份锚：从画像卡片抽一句「我是谁」，注入回复 prompt。
   *
   * 没有它时，模型会因为聊天里出现「下班」「毕业」就把自己说成已工作/已毕业
   * （真实事故：对方说「我当时已经毕业了啊」，代理回「我早不读了」）。
   * 卡片 10 分钟缓存一次，避免每轮读库。
   */
  let identityCache: { at: number; line: string | null } | null = null;
  const replyIdentity = (): string | null => {
    const at = Date.now();
    if (identityCache !== null && at - identityCache.at < 10 * 60_000) return identityCache.line;
    let line: string | null = null;
    try {
      // 唯一真相源是画像卡片（用户可在画像面板里改）。
      // 不再旁挂 identity.md：多一个真相源迟早和画像互相矛盾。
      const cards: Array<{ key: string; sections: Array<{ title: string; body: string }> }> = [];
      for (const key of ["identity", "education"] as const) {
        try {
          const card = profileStore.cards.get(key);
          cards.push({
            key,
            sections: card.sections.map((section) => ({ title: section.title, body: section.body })),
          });
        } catch {
          /* 单张卡片缺失不影响另一张 */
        }
      }
      line = pickIdentityLine(cards);
      // 叠加「当前身份状态」：卡片是静态口径，盖不住「最近入职/辞职/在找工作」。
      try {
        const active = profileStore.identityStates.listActive(["enrollment", "work"]);
        const stateLine = formatIdentityStatesForPrompt(active);
        if (stateLine !== "") line = line === null ? stateLine : `${line}；${stateLine}`;
      } catch {
        /* 状态表异常不影响卡片口径 */
      }
    } catch (error) {
      console.warn("[knowself] 身份锚读取失败，本轮不注入", errorMessage(error));
      line = null;
    }
    identityCache = { at, line };
    return line;
  };
  wechatAssist.configureReplyWorker(
    async (task, owner, signal) => {
      const persistence = profileStore.wechatAssist;
      const generate = generateForTask(task);
      /**
       * 从「我说过的话」里挖身份状态变化并落库（在读/入职/辞职/待业/求职中）。
       *
       * 失败一律忽略：身份状态只是增强，绝不影响回复本身。
       */
      const refreshIdentityStates = async (personaSignal: AbortSignal): Promise<void> => {
        if (personStore === undefined) return;
        try {
          const rows = personStore.replyHistory.listRecentMessages({
            conversation_id: task.conversation_id,
            limit: 200,
          });
          const messages = rows
            .filter((row) => row.role !== "system" && !row.content.trimStart().startsWith("<"))
            .map((row) => ({
              role: row.role === "me" ? ("me" as const) : ("them" as const),
              text: row.content,
            }));
          if (messages.length < 10) return;
          const prompt = buildIdentityExtractionPrompt(messages);
          const options: ChatOptions = {
            provider_id: task.provider_id,
            stream: true,
            max_tokens: 400,
            temperature: 0.1,
            stop_sequences: [],
            tools: [],
            metadata: {},
            messages: [
              { role: "system", content: [{ type: "text", text: prompt.system }] },
              { role: "user", content: [{ type: "text", text: prompt.user }] },
            ],
          };
          let raw = "";
          for await (const chunk of generate(options, personaSignal)) {
            if (personaSignal.aborted) return;
            if (chunk.type === "text") raw += chunk.delta;
            if (chunk.type === "error") return;
          }
          const candidates = parseIdentityStates(raw);
          if (candidates.length === 0) return;
          const nowIso = new Date().toISOString();
          for (const candidate of candidates) {
            profileStore.identityStates.append(
              {
                category: candidate.category,
                text: candidate.text,
                source_quote: candidate.source_quote,
                source_conversation_id: task.conversation_id,
              },
              nowIso,
            );
          }
          // 状态变了，身份锚缓存立刻失效。
          identityCache = null;
          console.info("[knowself] 身份状态已更新", {
            count: candidates.length,
            states: candidates.map((item) => `${item.category}:${item.text}`),
          });
        } catch (error) {
          console.warn("[knowself] 身份状态挖掘失败（忽略）", errorMessage(error));
        }
      };

      await refreshIdentityStates(signal);
      await runWechatReplyWorker({
        task,
        owner,
        signal,
        transport: wechatTransport,
        store: {
          createTurn: (currentOwner, record) => persistence.createOwnedReplyTurn(currentOwner, record),
          finishTurn: (currentOwner, _taskId, id, input) => persistence.finishOwnedReplyTurn(currentOwner, id, input),
          canContinue: (currentTask, currentOwner) => persistence.canContinueReplyTask({
            id: currentTask.id,
            owner: currentOwner,
            authorization_version: currentTask.authorization_version,
          }),
          progress: (input) => persistence.progressReplyTask({
            id: input.task.id,
            owner: input.owner,
            now: new Date().toISOString(),
            lease_until: new Date(Date.now() + REPLY_WORKER_LIMITS.leaseMs).toISOString(),
            turn_count: input.turns,
            send_count: input.sends,
            status: input.status,
            reason: input.reason,
          }),
          loadProgress: (taskId) => {
            const record = persistence.getReplyTaskProgress(taskId);
            if (record === undefined) return null;
            try {
              const facts = parseFacts(record.facts_json);
              const askedSlots = JSON.parse(record.asked_slots_json) as unknown;
              return {
                facts,
                askedSlots: Array.isArray(askedSlots) ? askedSlots.filter((item): item is string => typeof item === "string") : [],
                stageGoal: typeof record.stage_goal === "string" ? record.stage_goal : "",
              };
            } catch {
              return null;
            }
          },
          saveProgress: (input) => {
            try {
              persistence.saveReplyTaskProgress({
                task_id: input.taskId,
                facts_json: serializeFacts(input.facts),
                asked_slots_json: JSON.stringify(input.askedSlots),
                stage_goal: input.stageGoal,
                updated_at: new Date().toISOString(),
                turn_count: 0,
              });
            } catch (error) {
              console.warn("[knowself] 跨轮记忆持久化失败", errorMessage(error));
            }
          },
        },
        buildContext: async (query, contextSignal) => {
          if (contextSignal.aborted) throw new DOMException("Aborted", "AbortError");
          if (!persistence.canContinueReplyTask({ id: task.id, owner, authorization_version: task.authorization_version })) {
            throw new Error("历史授权已撤销或任务已暂停");
          }
          const emptyContext = (reason: string) => ({
            conversation_id: task.conversation_id,
            recent: [],
            relevant: [],
            estimated_tokens: 0,
            degraded: [reason],
          });
          if (replyContextService === undefined) {
            // 历史上下文服务没装配（派生索引不可用）→ 本轮降级为无历史回复，不制造失败轮次。
            console.warn("[knowself] 历史上下文服务不可用，本轮不带历史", { conversation_id: task.conversation_id });
            return emptyContext("history_context_unavailable");
          }
          // 任务上的 contact_id 是微信 username（transport 用），历史库里的 contact_id 是 person_id；
          // 用会话 ID 反查 person_id，避免每轮都 CONTACT_CONVERSATION_MISMATCH 后被判 3 次失败。
          const historyContactId = resolveHistoryContactId(
            personStore?.replyHistory.listDirectConversations() ?? [],
            task.conversation_id,
          );
          if (historyContactId === undefined) {
            console.warn("[knowself] 该会话没有直聊历史，本轮不带历史", { conversation_id: task.conversation_id });
            return emptyContext("no_direct_conversation_for_history");
          }
          try {
            return await replyContextService.build({
              task_id: task.id,
              contact_id: historyContactId,
              conversation_id: task.conversation_id,
              query,
              history_authorized: task.history_authorized,
              authorization_version: task.authorization_version,
            });
          } catch (error) {
            // 历史上下文只是增强：取不到就用空上下文继续回复，并把降级原因留在结果里。
            console.warn("[knowself] 历史上下文构建失败，本轮降级为无历史", errorMessage(error));
            return emptyContext("history_context_unavailable");
          }
        },
        generate,
        limits: {
          ...(settings.automation?.wechat_assist?.proactive_interval_ms === undefined
            ? {}
            : { proactiveIntervalMs: settings.automation.wechat_assist.proactive_interval_ms }),
          // 「回消息马上回」之后，每小时上限成为唯一的刷屏防线：把它接到配置上（0 = 不限）。
          ...(typeof settings.automation?.wechat_assist?.max_messages_per_hour === "number"
            ? { hourlyCap: settings.automation.wechat_assist.max_messages_per_hour }
            : {}),
          // 防抖：对方连发几条同一件事时，等静默 3s 再回一条；一直不停发最多等 10s。
          debounceMs: 3_000,
          debounceMaxMs: 10_000,
        },
        // 拟人抖动：每条消息发送前随机等 1–2 秒，避免「秒回秒回」的机器人节奏。
        sendJitterMs: () => 1_000 + Math.floor(Math.random() * 1_000),
        buildPersona: async (personaSignal) => {
          if (personStore === undefined) return null;
          // 用户纠正过的口吻：优先于模型总结出来的风格，缓存命中也要带上。
          const withCorrections = (value: ReplyPersona): ReplyPersona => {
            try {
              const corrections = persistence.listReplyCorrections(task.contact_id);
              return corrections.length === 0 ? value : { ...value, corrections };
            } catch {
              return value;
            }
          };
          // 人格优先读盘：用户可手改 data/personas/<contact>.json，改完下次任务生效。
          const fromDisk = loadPersonaFromDisk(paths.dataDir, task.contact_id);
          if (fromDisk !== null && fromDisk.version === REPLY_PERSONA_VERSION) {
            console.info("[knowself] 复用磁盘人格文件", { contact: task.contact_id });
            return withCorrections(fromDisk);
          }
          // 复用：同一任务 6 小时内的画像直接读缓存，避免每次重启都再烧一次模型调用。
          const PERSONA_REUSE_TTL_MS = 6 * 3_600_000;
          const cached = persistence.getReplyPersona(task.id);
          if (cached !== undefined) {
            const generatedAt = Date.parse(cached.generated_at);
            if (!Number.isNaN(generatedAt) && Date.now() - generatedAt < PERSONA_REUSE_TTL_MS) {
              const reused = deserializeReplyPersona(cached.payload_json);
              // 老 payload 没有表情统计、或提取口径版本落后 → 当作过期重新生成，
              // 否则表情功能要等 6 小时才生效；v1 还会把「招聘信息」写成「我报考」。
              // 库里混进占位符（[类型50]/[图片]）同样当过期——否则会把占位当表情发出去。
              const emojiClean = reused?.voice.emoji === undefined
                || (reused.voice.emoji.repertoire ?? []).every((token) => isRealEmoji(token));
              const versionOk = reused?.version === REPLY_PERSONA_VERSION;
              if (reused !== null && reused.voice.emoji !== undefined && emojiClean && versionOk) {
                console.info("[knowself] 复用已生成回复画像", { ageMs: Date.now() - generatedAt, source_messages: reused.source_messages });
                return withCorrections(reused);
              }
            }
          }
          // 取「最近」消息：listMessages 是升序前 N 条，会话大时拿到的是最老一批；画像必须用最近。
          const recentRows = personStore.replyHistory.listRecentMessages({
            conversation_id: task.conversation_id,
            limit: 300,
          });
          const recent = recentRows
            .filter((row) => row.role !== "system" && !row.content.trimStart().startsWith("<"))
            .filter((row) => !/^\((?:空文本|图片|语音|视频|表情)\)$/.test(row.content.trim()));
          // 并上实时消息：画像输入和上下文一样，不能只吃落后几分钟的库。
          let messages: Array<{ role: "me" | "them"; text: string; ts_ms?: number }> = recent.map((row) => ({
            role: row.role === "me" ? ("me" as const) : ("them" as const),
            text: row.content,
            ...(typeof row.ts_ms === "number" ? { ts_ms: row.ts_ms } : {}),
          }));
          try {
            const live = (await wechatTransport.listRecentMessages?.(task.conversation_id, 40)) ?? [];
            if (live.length > 0) {
              const seen = new Set(messages.map((message) => `${message.role}:${message.text}`));
              for (const item of live) {
                const role = item.role === "me" ? ("me" as const) : ("them" as const);
                const text = item.body.trim();
                if (text === "" || text.startsWith("<") || seen.has(`${role}:${text}`)) continue;
                seen.add(`${role}:${text}`);
                messages = [...messages, { role, text, ...(typeof item.ts_ms === "number" ? { ts_ms: item.ts_ms } : {}) }];
              }
            }
          } catch {
            /* 实时消息读取失败只影响画像新鲜度，不影响回复 */
          }
          // 机器人自己发过的话不是「用户口吻」样本：不剔掉的话，画像会把机器人的腔调学成用户的习惯。
          try {
            const ownKeys = new Set(
              persistence.listSentBodies(task.contact_id, 800).map((body) => normalizeForRepeat(body)),
            );
            if (ownKeys.size > 0) {
              messages = messages.filter(
                (message) => message.role !== "me" || !ownKeys.has(normalizeForRepeat(message.text)),
              );
            }
          } catch {
            /* 读不到就不排除，保持原行为 */
          }
          if (messages.length < 4) return null;
          console.info("[knowself] 画像输入消息数", messages.length);
          const startedAt = Date.now();
          try {
            const persona = await buildReplyPersona({
              contact_label: task.contact_id,
              messages,
              provider_id: task.provider_id,
              model_id: task.model_id,
              generate,
              signal: personaSignal,
            });
            if (persona === null) {
              console.info("[knowself] 回复画像未生成（模型返回空或不可用）", Date.now() - startedAt);
            } else {
              console.info("[knowself] 回复画像已生成", { ms: Date.now() - startedAt, degraded: persona.degraded });
              // 落盘：之后以文件为准，用户手改即生效，不再每次重新生成。
              const saved = savePersonaToDisk(paths.dataDir, task.contact_id, persona);
              if (!saved) console.warn("[knowself] 人格文件写入失败（不影响本轮回复）", { contact: task.contact_id });
            }
            return persona === null ? null : withCorrections(persona);
          } catch (error) {
            console.warn("[knowself] 回复画像生成失败", errorMessage(error), Date.now() - startedAt);
            return null;
          }
        },
        // 机器人自己发过的话不能再当「我的口吻」样本，否则模型会把上一轮的机器腔学回来。
        identity: replyIdentity,
        listOwnSentBodies: () => {
          try {
            return persistence.listSentBodies(task.contact_id, 800);
          } catch {
            return [];
          }
        },
        onPersona: (persona) => {
          try {
            profileStore.wechatAssist.saveReplyPersona({
              task_id: task.id,
              payload_json: JSON.stringify(persona),
              generated_at: persona.generated_at,
              updated_at: new Date().toISOString(),
            });
          } catch (error) {
            console.warn("[knowself] 回复画像持久化失败", errorMessage(error));
          }
        },
        send: async ({ contact_id, body, inbound_message_id }) => {
          const draft = await wechatAssist.createDraft({ contact_id, body });
          // inbound_message_id 非空 = 回复对方刚发来的消息 → 跳过冷却立即发；
          // 为空 = 主动搭话 → 仍走冷却/间隔。
          await wechatAssist.sendDraft(draft.id, {
            explicit: true,
            ...(inbound_message_id === null ? {} : { reply: true }),
          });
        },
      });
    },
    (task) => {
      if (host.agentDefaultModel === undefined) {
        const provider = providerConfigs.find((item) => item.id === task.provider_id);
        if (provider === undefined) return "自动回复 provider 不存在";
        if (provider.model !== task.model_id) return "dsh 当前聊天模型配置已变更，请停止后重新启动任务";
      } else {
        const selection = dshResolveModel();
        if (selection === undefined) return "dsh 当前模型未配置，请先在 dsh 里选择模型";
      }
      // 历史上下文只是「增强」：不可用时降级为无历史回复（buildContext 会返回空上下文），
      // 不再因此暂停任务——否则「我选了人点了开始」还是跑不起来。
      if (task.history_authorized) {
        const historyContactId = resolveHistoryContactId(
          personStore?.replyHistory.listDirectConversations() ?? [],
          task.conversation_id,
        );
        const indexReady = contextRouter?.replyRetrieval?.state(task.conversation_id)?.state === "ready";
        if (historyContactId === undefined || replyContextService === undefined || !indexReady) {
          console.warn("[knowself] 历史上下文当前不可用，任务按无历史回复继续", {
            conversation_id: task.conversation_id,
            has_direct_conversation: historyContactId !== undefined,
            index_ready: indexReady,
            service_ready: replyContextService !== undefined,
          });
        }
      }
      return null;
    },
  );

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
    wechatTransport,
    resolveDshModel: dshResolveModel,
    listDshModels,
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
  host: KnowselfHostDeps = {},
): Promise<KnowselfServices> {
  return assembleServices(rootDir, DEFAULT_FACTORIES, personsKeyMode, host);
}
