/**
 * retrieval.ts — knowSelf 上下文检索契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/retrieval.ts` 抄录。
 *
 * 工作单元：context-router
 * 关联模块：
 *   - profile-store    经 ProfileChangeEvent 通知 retriever 增量重建
 *   - provider-adapter context-router 用便宜小 provider 跑 L2 分类与 L3 Reranker
 *   - chat-engine      调 buildContext 取 messages
 *
 * 流水线（决策已固化在 ARCHITECTURE.md §3）：
 *   query → QueryProcessor → 并行召回（FTS5 top30 + Vector top30）
 *         → RRF 融合去重 → LLM Reranker → ContextExpander（父子 chunk）
 *         → TokenBudgetTrimmer → 返回 messages 给 chat-engine
 *
 * 父子 chunk（DESIGN.md §4.6 + manifest）：
 *   索引粒度 = 子（段落级）；返回粒度 = 父（卡片整张 / 日记整条）
 *   命中后扩展并去重；同一父在同一查询里只出现一次
 *
 * 弱模型实施提示：
 *   1. 所有 Zod schema 仅描述形状；retriever 内部 SQL 写法见 DESIGN-05 的 DDL。
 *   2. RetrievedDoc.score 是经 RRF 融合后的归一化分数，不是原始 BM25 / cosine。
 *   3. ContextBuildResult.messages 形状由 chat.ts ProviderMessage 决定，本文件用宽松 record 占位。
 *   4. 降级路径硬编码在 RetrieverConfig.fallback_*；不要在调用方临时判断。
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";

// ──────────────────────────────────────────────────────────────────────────
//  公共原子
// ──────────────────────────────────────────────────────────────────────────

/**
 * 文档源类型 — 索引时打的标签，决定父级粒度与展示样式。
 *   core         L1 整体（其实不索引，但保留枚举值便于 RetrievedDoc 复用）
 *   card         L2 卡片正文 / 单 section
 *   journal      L3 日记单条 record
 *   message      聊天消息（DESIGN-10 §7.4 加法式新增；走独立 chat_chunks 表）
 */
export const DocSourceTypeSchema = z.enum(["core", "card", "journal", "message"]);

/** 引用 profile.ts ID 形态，避免循环引用，重复声明。 */
export const ProfileIdSchema = z
  .string()
  .regex(/^(core|card|journal)_[a-z0-9._-]{1,64}$/, "profile id 形式错误");

// ──────────────────────────────────────────────────────────────────────────
//  Chunk / Embedding — SQLite 内部记录
//  对应 retrieval.sqlite 中 chunks 表与 embeddings 表
// ──────────────────────────────────────────────────────────────────────────

/**
 * Chunk 切片记录 — chunks 表一行。
 *
 * 字段说明：
 *   id              chunk 唯一 ID（自增 INTEGER；契约层用 string 表达兼容 sqlite-vec V2）
 *   doc_id          所属 ProfileId（card_xxx / journal_2026-05-27）
 *   doc_source      DocSourceType（card / journal / core）
 *   doc_path        相对 profile/ 的文件路径（"cards/work.md" / "journal/2026-05-27.md"）
 *   parent_index    在父级中的位置（card 是 sectionIndex；journal 是 record.ordinal）
 *   child_index     子级序号（同一 parent 内顺序，从 0 起）
 *   parent_text     父级整段文本（卡片整张 / 日记整条），返回粒度
 *   child_text      子级段落文本，索引粒度
 *   tokens          child_text 的 token 估算（用 provider-adapter 的 tokenCounter）
 *   tags            合并 frontmatter.section_tags 与 record.tags
 *   updated_at      原文件 frontmatter.updated_at（用于按新鲜度 boost）
 *   indexed_at      建索引时间
 */
export const ChunkRecordSchema = z.object({
  id: z.string().min(1).max(64),
  doc_id: ProfileIdSchema,
  doc_source: DocSourceTypeSchema,
  doc_path: z.string().min(1).max(256),
  parent_index: z.number().int().min(0).max(9999),
  child_index: z.number().int().min(0).max(9999),
  parent_text: z.string().max(8000),
  child_text: z.string().max(2000),
  tokens: z.number().int().min(1).max(8000),
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  updated_at: IsoTimestampSchema,
  indexed_at: IsoTimestampSchema,
});

/**
 * Embedding 记录 — embeddings 表一行。
 *
 * vector 字段在 SQLite 里以 BLOB 存储（Float32Array 字节序列）。
 * Zod 层面用宽松 z.unknown() 表达；实施时用 Buffer / Uint8Array。
 */
export const EmbeddingRecordSchema = z.object({
  chunk_id: z.string().min(1).max(64),
  /** 模型 ID，决定向量维度（变更模型时需重建）。 */
  model_id: z.string().min(1).max(128),
  /** 向量维度（qwen3-embedding:0.6b = 1024；SRS §2.4 A4 决议，384 → 1024）。 */
  dim: z.number().int().min(64).max(4096),
  /** 向量字节序列；schema 仅做存在校验。 */
  vector: z.unknown(),
  indexed_at: IsoTimestampSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  RetrieveQuery / RetrievedDoc — 检索接口的入参与出参
// ──────────────────────────────────────────────────────────────────────────

/**
 * 单次检索请求。
 *
 * 字段说明：
 *   text            用户原始 query（不含 history）
 *   top_k           最终返回上限（默认 8；rerank 之后取这么多）
 *   recall_per_lane 每路召回的候选数（FTS5 与 Vector 各自取 top30）
 *   filter_sources  限定来源类型；空数组表示全要
 *   date_range      仅对 journal 生效；inclusive
 *   exclude_doc_ids 排除某些 doc_id（避免回顾刚刚写过的内容）
 *   include_score   返回是否带 score（false 时返回去除分数的最小负载）
 */
export const RetrieveQuerySchema = z.object({
  text: z.string().min(1).max(4000),
  top_k: z.number().int().min(1).max(32).default(8),
  recall_per_lane: z.number().int().min(5).max(100).default(30),
  filter_sources: z.array(DocSourceTypeSchema).max(4).default([]),
  date_range: z
    .object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .nullable()
    .default(null),
  exclude_doc_ids: z.array(ProfileIdSchema).max(64).default([]),
  include_score: z.boolean().default(true),
});

/**
 * 召回路 — RRF 融合时知道每条候选来自哪一路。
 *   fts5      关键词倒排（BM25）
 *   vector    句向量余弦
 *   tag       标签直接命中（boost 路；非主召回路）
 */
export const RecallLaneSchema = z.enum(["fts5", "vector", "tag"]);

/**
 * 检索结果项。
 *
 * 字段说明：
 *   chunk_id        命中的子级 chunk ID
 *   doc_id          父级 ProfileId
 *   doc_source      DocSourceType
 *   doc_path        相对路径
 *   parent_text     扩展后的父级整段文本（注入到 prompt 用这段，不是 child_text）
 *   tokens          parent_text 的 token 估算
 *   score           RRF 融合 + Reranker 加权后的归一化分数（0-1）
 *   lanes           本条命中走过的召回路集合（fts5 / vector / tag）
 *   rerank_rank     Reranker 排序后的位次（0-based）；rerank 跳过时为 null
 *   tags            合并 chunk.tags 与父级 section_tags
 *   updated_at      父文件 updated_at
 */
/**
 * 检索结果文档 ID — profile 文档或聊天窗口（DESIGN-10 §7.4 加法式新增）。
 *
 * 聊天窗口必须**窗口级唯一**（`chat_<conversation_id>_<parent_index>`）：
 * `expandToParents` 按 doc_id 去重，若用会话级会把同会话不同时间窗口合并。
 */
export const RetrievalDocIdSchema = z.union([
  ProfileIdSchema,
  z
    .string()
    .regex(/^chat_[A-Za-z0-9._@-]{1,58}$/, "chat doc id 形式错误")
    .max(64),
]);

export const RetrievedDocSchema = z.object({
  chunk_id: z.string().min(1).max(64),
  doc_id: RetrievalDocIdSchema,
  doc_source: DocSourceTypeSchema,
  doc_path: z.string().min(1).max(256),
  parent_text: z.string().max(8000),
  tokens: z.number().int().min(1).max(8000),
  score: z.number().min(0).max(1),
  lanes: z.array(RecallLaneSchema).min(1).max(3),
  rerank_rank: z.number().int().min(0).max(63).nullable(),
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  updated_at: IsoTimestampSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  RetrieverConfig — context-router 内部配置
//  从 settings.retrieval 读取（settings.ts 会把本 schema 嵌入）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 检索流水线开关 + 阈值。
 *
 * 字段说明：
 *   enabled                 全局开关（关掉就跳过 L3，仅用 L1/L2）
 *   embedding_model_id      embedding 模型；变更触发全量重建
 *                           （默认 qwen3-embedding:0.6b / 1024 维；SRS §2.4 A4）
 *   embedding_cache_dir     模型本地缓存路径（默认 data/models/）
 *   chunk_target_tokens     子级 chunk 目标 token 数（默认 256）
 *   chunk_overlap_tokens    chunk 间重叠 token（默认 32）
 *   parent_max_tokens       父级 chunk 最大 token（超出按句号切）
 *   rrf_k                   RRF 融合常数（默认 60，官方推荐）
 *   rerank_provider_id      LLM Reranker 用哪个 provider；空字符串走 fallback
 *   rerank_model            Reranker 模型名（空则用 provider 默认）
 *   rerank_top_k            送入 Reranker 的候选数（默认 30）
 *   rerank_timeout_ms       Reranker 超时；超时降级为规则版 / RRF 排序
 *                           （默认 500；DESIGN-18 §6.3-D4：15,000 → 500）
 *   classifier_provider_id  L2 分类器 provider；空走默认
 *   classifier_max_cards    分类器最多挑几张卡（默认 3）
 *   token_budget            buildContext 总 token 预算
 *   token_budget_l1         L1 预算（默认 1500）
 *   token_budget_l2         L2 预算（默认 2500）
 *   token_budget_l3         L3 预算（默认 4000）
 *   token_budget_history    历史消息预算（默认 6000）
 *   freshness_boost         越新文档加分（0-1，默认 0.1）
 *   memory_load_threshold   chunk 总数低于该值时 vector 走全量内存余弦；高于切 SQL
 *   fallback_when_no_embed  embedding 模型加载失败时是否仅用 FTS5（默认 true）
 *   fallback_when_no_rerank Reranker 失败时是否按 RRF 分数返回（默认 true）
 *   fallback_when_no_classify L2 分类失败时的降级策略
 */
export const ClassifierFallbackStrategySchema = z.enum([
  "all_cards", // 把全部 L2 卡片都塞进去（只在 L2 数量少时安全）
  "last_used", // 用上次会话挑过的卡片
  "none", // 完全跳过 L2
]);

export const RetrieverConfigSchema = z.object({
  enabled: z.boolean().default(true),
  embedding_model_id: z.string().min(1).max(128).default("qwen3-embedding:0.6b"),
  embedding_cache_dir: z.string().min(1).max(512).default("data/models"),
  embed_model_id: z.string().min(1).max(128).optional(),
  chunk_target_tokens: z.number().int().min(64).max(2000).default(256),
  chunk_overlap_tokens: z.number().int().min(0).max(256).default(32),
  parent_max_tokens: z.number().int().min(256).max(8000).default(2000),
  rrf_k: z.number().int().min(1).max(1000).default(60),
  rerank_provider_id: z.string().max(64).default(""),
  rerank_model: z.string().max(128).default(""),
  rerank_top_k: z.number().int().min(5).max(100).default(30),
  /**
   * 下界 100 而非 1000：DESIGN-18 §6.3-D4 把默认值定为 500，域下界必须 ≤ 默认值，
   * 否则 `.default(500)` 会被自身校验拒绝（parse({}) 直接失败）；
   * 100 ms 已低于任何可用 reranker 的往返耗时，再低只会立刻触发超时降级。
   */
  rerank_timeout_ms: z.number().int().min(100).max(60_000).default(500),
  classifier_provider_id: z.string().max(64).default(""),
  classifier_max_cards: z.number().int().min(0).max(10).default(3),
  token_budget: z.number().int().min(2000).max(200_000).default(20_000),
  token_budget_l1: z.number().int().min(0).max(50_000).default(1500),
  token_budget_l2: z.number().int().min(0).max(50_000).default(2500),
  token_budget_l3: z.number().int().min(0).max(50_000).default(4000),
  token_budget_history: z.number().int().min(0).max(50_000).default(6000),
  freshness_boost: z.number().min(0).max(1).default(0.1),
  memory_load_threshold: z.number().int().min(100).max(100_000).default(5000),
  fallback_when_no_embed: z.boolean().default(true),
  fallback_when_no_rerank: z.boolean().default(true),
  fallback_when_no_classify: ClassifierFallbackStrategySchema.default("last_used"),
});

// ──────────────────────────────────────────────────────────────────────────
//  L2 分类器 / Reranker — 调小 provider 时的输入输出形状
// ──────────────────────────────────────────────────────────────────────────

/** L2 分类器入参。 */
export const L2ClassifyInputSchema = z.object({
  query: z.string().min(1).max(4000),
  /** 候选卡片摘要列表（来自 profile-store.listCards）。 */
  cards: z
    .array(
      z.object({
        key: z.string().min(1).max(48),
        title: z.string().min(1).max(64),
        summary: z.string().min(1).max(280),
      }),
    )
    .min(0)
    .max(64),
  max_cards: z.number().int().min(0).max(10).default(3),
});

/** L2 分类器出参（用 provider-adapter 的 structured output 校验）。 */
export const L2ClassifyOutputSchema = z.object({
  /** 选中的 cardKey 列表（按相关度降序）。 */
  selected_keys: z.array(z.string().min(1).max(48)).max(10),
  /** 一句话理由，调试用。 */
  reasoning: z.string().max(512).default(""),
});

/** Reranker 入参。 */
export const RerankInputSchema = z.object({
  query: z.string().min(1).max(4000),
  candidates: z
    .array(
      z.object({
        index: z.number().int().min(0).max(99),
        text: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(100),
  top_k: z.number().int().min(1).max(50).default(8),
});

/** Reranker 出参。 */
export const RerankOutputSchema = z.object({
  /** 选中候选的 index，按相关度降序。 */
  ranked_indices: z.array(z.number().int().min(0).max(99)).max(50),
});

// ──────────────────────────────────────────────────────────────────────────
//  buildContext — context-router 暴露给 chat-engine 的核心入口
// ──────────────────────────────────────────────────────────────────────────

/**
 * BuildContext 入参。
 *
 * 字段说明：
 *   query                 用户本轮提问
 *   provider_id           主对话 provider（决定 cache_control 是否注入）
 *   history               历史消息（chat.ts ChatHistoryMessage[]，宽松 record 占位）
 *   override_top_k        临时覆盖 RetrieverConfig.top_k
 *   skip_l3_retrieval     跳过 L3（仅用 L1/L2，UI 提供"快问"模式）
 *   force_card_keys       强制注入指定卡片（UI 用户手动选）
 */
export const BuildContextInputSchema = z.object({
  query: z.string().min(1).max(16_000),
  provider_id: z.string().min(1).max(64),
  history: z.array(z.record(z.string(), z.unknown())).max(256).default([]),
  override_top_k: z.number().int().min(1).max(32).optional(),
  skip_l3_retrieval: z.boolean().default(false),
  force_card_keys: z.array(z.string().min(1).max(48)).max(10).default([]),
});

/**
 * BuildContext 出参。
 *
 * 字段说明：
 *   messages              ProviderMessage[]（chat.ts），含 system/user/assistant/tool
 *   metadata              观测字段，给 chat-engine 落库 + UI 调试面板
 */
export const BuildContextMetadataSchema = z.object({
  l1_tokens: z.number().int().min(0).max(50_000),
  l2_card_keys: z.array(z.string().min(1).max(48)).max(10),
  l2_tokens: z.number().int().min(0).max(50_000),
  l3_doc_ids: z.array(ProfileIdSchema).max(32),
  l3_tokens: z.number().int().min(0).max(50_000),
  history_tokens: z.number().int().min(0).max(100_000),
  total_tokens: z.number().int().min(0).max(200_000),
  /** 命中 prompt cache 的 token 数（仅 anthropic 兼容时有效）。 */
  expected_cache_hits: z.number().int().min(0).max(200_000),
  /** 各路降级实际触发情况，便于排错。 */
  degradations: z.array(
    z.enum(["no_embed_model", "rerank_failed", "classifier_failed", "budget_trim_aggressive"]),
  ),
  /** Retriever 各阶段耗时（毫秒）。 */
  timings_ms: z.object({
    classify: z.number().int().min(0).max(60_000),
    fts5: z.number().int().min(0).max(60_000),
    vector: z.number().int().min(0).max(60_000),
    rerank: z.number().int().min(0).max(60_000),
    expand: z.number().int().min(0).max(60_000),
    budget: z.number().int().min(0).max(60_000),
    total: z.number().int().min(0).max(120_000),
  }),
});

export const BuildContextResultSchema = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).min(1).max(256),
  metadata: BuildContextMetadataSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  错误码
// ──────────────────────────────────────────────────────────────────────────

export const RetrievalErrorCodeSchema = z.enum([
  "EMBED_MODEL_LOAD_FAILED", // 模型加载失败（已可降级）
  "DB_CORRUPT", // retrieval.sqlite 损坏
  "INDEX_BUSY", // 增量重建中，临时拒绝写
  "BUDGET_OVERFLOW", // 预算裁剪后仍超模型上下文上限
  "ABORTED",
]);

export const RetrievalErrorPayloadSchema = z.object({
  code: RetrievalErrorCodeSchema,
  message: z.string().min(1).max(512),
  trace_id: z.string().min(8).max(64).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type DocSourceType = z.infer<typeof DocSourceTypeSchema>;
export type RecallLane = z.infer<typeof RecallLaneSchema>;

export type ChunkRecord = z.infer<typeof ChunkRecordSchema>;
export type EmbeddingRecord = z.infer<typeof EmbeddingRecordSchema>;

export type RetrieveQuery = z.infer<typeof RetrieveQuerySchema>;
export type RetrievedDoc = z.infer<typeof RetrievedDocSchema>;

export type ClassifierFallbackStrategy = z.infer<typeof ClassifierFallbackStrategySchema>;
export type RetrieverConfig = z.infer<typeof RetrieverConfigSchema>;

export type L2ClassifyInput = z.infer<typeof L2ClassifyInputSchema>;
export type L2ClassifyOutput = z.infer<typeof L2ClassifyOutputSchema>;
export type RerankInput = z.infer<typeof RerankInputSchema>;
export type RerankOutput = z.infer<typeof RerankOutputSchema>;

export type BuildContextInput = z.infer<typeof BuildContextInputSchema>;
export type BuildContextMetadata = z.infer<typeof BuildContextMetadataSchema>;
export type BuildContextResult = z.infer<typeof BuildContextResultSchema>;

export type RetrievalErrorCode = z.infer<typeof RetrievalErrorCodeSchema>;
export type RetrievalErrorPayload = z.infer<typeof RetrievalErrorPayloadSchema>;
