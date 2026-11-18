/**
 * @knowself/context-router — 上下文路由公共 API
 *
 * createContextRouter(opts) → ContextRouter
 *
 * 公开方法：
 *   - buildContext(input)  → BuildContextResult   （chat-engine 每轮对话调用）
 *   - buildFullIndex()     → { chunkCount, durationMs }
 *   - applyChange(event)   → void                  （profile-store 写入后调用）
 *   - buildChatIndex()     → ChatIndexResult       （V3：聊天原文索引，K-33/K-36）
 *   - shutdown()           → void
 */

import type {
  BuildContextInput,
  BuildContextResult,
  ProfileChangeEvent,
  RetrieverConfig,
} from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import { openRetrievalDb, type RetrievalDb, EMBEDDING_DIM, openReplyRetrievalDbFromHandle, type ReplyRetrievalDb } from "./db";
import { createReplyRetrievalIndex, type ReplyRetrievalIndex } from "./reply-retrieval";
import { loadEmbeddingPipeline, type EmbedFn } from "./embedding";
import { buildContext } from "./build";
import { buildFullIndex, applyChange } from "./index-builder";
import {
  buildChatIndex,
  type ChatIndexConversation,
  type ChatIndexMessage,
  type ChatIndexResult,
  type ChatIndexSource,
} from "./chat-index";

// ─── 公开接口 ─────────────────────────────────────────────────────────

export interface ContextRouter {
  /** 构建本轮对话上下文（L1 + L2 + L3 + budget）。 */
  buildContext(input: BuildContextInput): Promise<BuildContextResult>;

  /** 全量重建索引。 */
  buildFullIndex(): Promise<{ chunkCount: number; durationMs: number }>;

  /** 增量更新索引。 */
  applyChange(event: ProfileChangeEvent): Promise<void>;

  /** 重建聊天原文索引（需创建时注入 `chatSource`；未注入则抛错）。 */
  buildChatIndex(opts?: { conversationIds?: readonly string[] }): Promise<ChatIndexResult>;

  /** 返回已经由 person-store 解锁的加密回复索引；未注入时返回 undefined。 */
  replyRetrieval?: ReplyRetrievalIndex;

  /** 关闭数据库连接，释放资源。 */
  shutdown(): void;
}

export type {
  ReplyContextMessage,
  ReplyConversationSource,
  ReplyHistorySource,
  ReplyRetrievalIndex,
  ReplySourceMessage,
} from "./reply-retrieval";

/** person-store 的读侧最小结构面（不引入包依赖，DESIGN-10 §7.4 只读约束）。 */
export interface ChatStoreLike {
  conversations: {
    list(q?: {
      kind?: string;
      platform?: string;
      keyword?: string;
      limit?: number;
      offset?: number;
    }): ChatIndexConversation[];
  };
  messages: {
    list(q: {
      conversation_id?: string;
      person_id?: string;
      from_ms?: number;
      to_ms?: number;
      content_types?: readonly string[];
      limit?: number;
      offset?: number;
    }): ChatIndexMessage[];
  };
}

/** 把 person-store 门面适配为索引构建所需的两个分页读函数。 */
export function adaptChatStore(store: ChatStoreLike): ChatIndexSource {
  return {
    listConversations: (limit, offset) => store.conversations.list({ limit, offset }),
    listMessages: (conversationId, limit, offset) =>
      store.messages.list({ conversation_id: conversationId, limit, offset }),
  };
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────

interface CreateRouterOpts {
  profileStore: ProfileStore;
  providerAdapter: ProviderAdapter;
  config: RetrieverConfig;
  dbPath: string;
  embeddingModelId?: string;
  embeddingCacheDir?: string;
  /** Ollama 根地址（默认 `KNOWSELF_OLLAMA_BASE_URL` 或 `http://127.0.0.1:11434`）。 */
  embeddingBaseUrl?: string;
  /** 聊天索引数据源（通常是 person-store 门面）；不传则 buildChatIndex 抛错。 */
  chatStore?: ChatStoreLike;
  replyRetrievalDb?: ReplyRetrievalDb;
}

export function createContextRouter(opts: CreateRouterOpts): ContextRouter {
  const db: RetrievalDb = openRetrievalDb(opts.dbPath);
  const replyRetrieval = opts.replyRetrievalDb === undefined
    ? undefined
    : createReplyRetrievalIndex(openReplyRetrievalDbFromHandle(opts.replyRetrievalDb));
  let embedFn: EmbedFn | null = null;
  let _embedInit = false;
  let _embedError: Error | null = null;

  // 异步初始化 embedding（非阻塞，不抛错）。检索关闭时不加载。
  if (opts.config.enabled) {
    const modelId = opts.embeddingModelId ?? opts.config.embedding_model_id;
    const cacheDir = opts.embeddingCacheDir ?? opts.config.embedding_cache_dir;
    loadEmbeddingPipeline(modelId, cacheDir, {
      ...(opts.embeddingBaseUrl ? { baseUrl: opts.embeddingBaseUrl } : {}),
      dim: EMBEDDING_DIM,
    })
      .then((fn) => {
        embedFn = fn;
      })
      .catch((err) => {
        _embedError = err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => {
        _embedInit = true;
      });
  } else {
    _embedInit = true;
  }

  const deps = {
    profileStore: opts.profileStore,
    providerAdapter: opts.providerAdapter,
    config: opts.config,
    db,
    get embedFn() {
      return embedFn;
    },
  };

  const chatSource = opts.chatStore ? adaptChatStore(opts.chatStore) : null;

  return {
    async buildContext(input: BuildContextInput): Promise<BuildContextResult> {
      return buildContext(deps, input);
    },

    async buildFullIndex(): Promise<{ chunkCount: number; durationMs: number }> {
      return buildFullIndex(deps);
    },

    async applyChange(event: ProfileChangeEvent): Promise<void> {
      return applyChange(deps, event);
    },

    async buildChatIndex(chatOpts?: { conversationIds?: readonly string[] }): Promise<ChatIndexResult> {
      if (!chatSource) {
        throw new Error(
          "context-router: 未注入 chatStore，无法构建聊天索引（createContextRouter({ chatStore })）",
        );
      }
      return buildChatIndex(
        {
          db,
          embedFn,
          modelId: opts.embeddingModelId ?? opts.config.embedding_model_id,
        },
        chatSource,
        chatOpts,
      );
    },

    ...(replyRetrieval === undefined ? {} : { replyRetrieval }),

    shutdown(): void {
      db.raw.close();
      opts.replyRetrievalDb?.close();
    },
  };
}
