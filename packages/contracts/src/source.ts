/**
 * source.ts — knowSelf 资料 ingestion 契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/source.ts` 抄录。
 *
 * 工作单元：ingestion（新增）
 * 关联模块：
 *   - profile-store    经 profile_sources 关联表关联到具体档案条目
 *   - chat-engine      路由 /api/sources 与 /api/sources/:id/proposals 暴露给 web-ui
 *   - provider-adapter 蒸馏阶段调 requestStructured 跑建议生成
 *   - web-ui          /sources 页面 + IngestProposalDialog 渲染本契约
 *
 * 概念分层（DESIGN.md 在 SQLite 改造后增的核心区分）：
 *   1. Source        — 用户提供的原始资料（PDF/DOCX/MD/TXT/HTML/URL/CSV/XLSX/粘贴文本）
 *                      永远保留 raw 文件 + 提取后的纯文本，不删
 *   2. IngestionProposal — 蒸馏小模型读 Source 后产生的"写入档案的建议"
 *                      用户必须审阅后才落档
 *   3. ProfileSource — Source 与 profile 条目的多对多关联，提供事后追溯
 *
 * MVP 支持的格式（用户已确认，DESIGN-09 §3.1 决议）：
 *   PDF / DOCX / MD / TXT / HTML / URL / CSV / XLSX
 *   图片 OCR 与音视频转录留 V2。
 *
 * 弱模型实施提示：
 *   1. extractor 一种格式一个文件；统一返回 RawText 形状。
 *   2. Source.extracted_text 不超过 1MB（约 25 万汉字）；超出截断并设 truncated=true。
 *   3. IngestionProposal 是"待审阅"状态机：pending → accepted/edited/rejected；不允许跳态。
 *   4. accepted/edited 落档时**必须**在 ProfileSource 关联表写一行；否则丢失追溯。
 *   5. 重新提炼（用户在 UI 点【重新提炼】）= 复用 Source.extracted_text 跑新一轮蒸馏，
 *      老的 proposals 不删（保留 status=rejected/accepted/edited 历史）；只新增 pending。
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";

/** Source ID — UUID v4。 */
export const SourceIdSchema = z.string().uuid("source id 必须是 UUID v4");

/** Proposal ID — UUID v4。 */
export const ProposalIdSchema = z.string().uuid("proposal id 必须是 UUID v4");

/**
 * 资料来源类型（用户行为视角）。
 *   file    本地文件上传
 *   url     给一个 URL，server 用 mcp-host 的 fetch 工具拉
 *   paste   直接粘贴文本（无文件，无 URL）
 */
export const SourceKindSchema = z.enum(["file", "url", "paste"]);

/**
 * 资料处理状态。
 *   raw             已落库但还没生成任何 proposals
 *   distilling      正在运行蒸馏
 *   pending_review  已产生待审核 proposals
 *   completed       没有待审核 proposals，当前资料处理完成
 *   rejected        用户标记"忽略此资料"（不删，避免误操作丢素材）
 */
export const SourceStatusSchema = z.enum([
  "raw",
  "distilling",
  "pending_review",
  "completed",
  "rejected",
  "distill_failed",
]);

/**
 * MIME 类型白名单（MVP）。
 *   - text/markdown / text/plain / text/html
 *   - application/pdf
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document  (DOCX)
 *   - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet        (XLSX)
 *   - image/png / image/jpeg / image/webp / image/gif（metadata-only，可配合备注蒸馏）
 *   - text/csv
 *   - application/json（V2 启用，MVP 占位）
 *
 * 不在白名单内的文件 ingestion 拒绝；URL 拉回的 content-type 也按此判断。
 */
export const SupportedMimeTypeSchema = z.enum([
  "text/markdown",
  "text/plain",
  "text/html",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// ──────────────────────────────────────────────────────────────────────────
//  RawText — extractor 统一输出
// ──────────────────────────────────────────────────────────────────────────

/**
 * extractor（pdf/docx/html/csv 等）统一返回的中间结果。
 * ingestion 入口拿到 RawText 后写入 sources 表的 extracted_text 字段，
 * 并把 metadata 落 sources.metadata（JSON 列）。
 */
export const RawTextSectionSchema = z.object({
  /** 标题（PDF 大纲、HTML h1-h3、DOCX 样式 Heading）。 */
  heading: z.string().min(1).max(200),
  /** 段落正文。 */
  body: z.string().max(50_000),
  /** 在原文档中的层级，1=最高。 */
  level: z.number().int().min(1).max(6),
});

export const RawTextSchema = z.object({
  /** 全文纯文本（可能超长，由调用方决定是否截断）。 */
  text: z.string().min(1).max(2_000_000),
  /** 标题切分（可选；HTML/DOCX/PDF 大纲提取得到，CSV/TXT 通常没有）。 */
  sections: z.array(RawTextSectionSchema).max(256).default([]),
  /** 文档元数据，extractor 自由定义键。 */
  metadata: z
    .object({
      title: z.string().max(200).optional(),
      author: z.string().max(200).optional(),
      created_at: IsoTimestampSchema.optional(),
      page_count: z.number().int().min(0).max(10_000).optional(),
      word_count: z.number().int().min(0).max(2_000_000).optional(),
      language: z.string().max(16).optional(),
      /** 保留扩展空间。 */
      extra: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ extra: {} }),
});

// ──────────────────────────────────────────────────────────────────────────
//  Source — sources 表落库形状
// ──────────────────────────────────────────────────────────────────────────

export const SourceStoredSchema = z.object({
  id: SourceIdSchema,
  kind: SourceKindSchema,
  /** 用户上传时的文件名；kind=url 时是 URL 末段；kind=paste 时为空字符串。 */
  original_name: z.string().max(256),
  /** mime_type；paste 默认 text/plain。 */
  mime_type: SupportedMimeTypeSchema,
  /** 相对 data/sources/ 的字节文件路径；kind=paste 为 null。 */
  file_path: z.string().max(256).nullable(),
  /** kind=url 时的源 URL；其他为 null。 */
  url: z.string().url().max(2048).nullable(),
  /** 提取后的纯文本（最大 1MB；超长截断）。 */
  extracted_text: z.string().min(1).max(1_000_000),
  /** 提取过程中是否截断。 */
  truncated: z.boolean(),
  /** 提取的字符数（提取后、截断后；不是文件大小）。 */
  char_count: z.number().int().min(1).max(1_000_000),
  /** 用户备注（UI 资料库行的备注栏）。 */
  user_note: z.string().max(2000).default(""),
  /** 用户标签。 */
  user_tags: z.array(z.string().min(1).max(32)).max(8).default([]),
  /** 处理状态。 */
  status: SourceStatusSchema,
  /** 文档元数据（extractor 给的）。 */
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: IsoTimestampSchema,
  /** 最近一次成功蒸馏时间（rerun 也算）。 */
  last_ingested_at: IsoTimestampSchema.nullable(),
  /** 蒸馏失败时的错误信息；成功或无失败时为 null。 */
  last_error: z.string().max(2000).nullable(),
});

/**
 * 创建 source 的入参（POST /api/sources）。
 * 三种 kind 对应三种 body 形状（discriminated union）。
 */
export const CreateSourceFromFileSchema = z.object({
  kind: z.literal("file"),
  /** 通过 multipart 上传的文件；schema 仅约束元数据。 */
  original_name: z.string().min(1).max(256),
  mime_type: SupportedMimeTypeSchema,
  user_note: z.string().max(2000).default(""),
  user_tags: z.array(z.string().min(1).max(32)).max(8).default([]),
});

export const CreateSourceFromUrlSchema = z.object({
  kind: z.literal("url"),
  url: z.string().url().max(2048),
  user_note: z.string().max(2000).default(""),
  user_tags: z.array(z.string().min(1).max(32)).max(8).default([]),
});

export const CreateSourceFromPasteSchema = z.object({
  kind: z.literal("paste"),
  /** 用户粘贴的纯文本；mime 固定 text/plain。 */
  text: z.string().min(1).max(500_000),
  /** 用户给这段文本起的"原始名"，用于 UI 展示；空则用前 30 字。 */
  original_name: z.string().max(256).default(""),
  user_note: z.string().max(2000).default(""),
  user_tags: z.array(z.string().min(1).max(32)).max(8).default([]),
});

export const CreateSourceRequestSchema = z.discriminatedUnion("kind", [
  CreateSourceFromFileSchema,
  CreateSourceFromUrlSchema,
  CreateSourceFromPasteSchema,
]);

/** 列表查询（GET /api/sources）。 */
export const ListSourcesQuerySchema = z.object({
  status: SourceStatusSchema.optional(),
  tag: z.string().min(1).max(32).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});

export const ListSourcesResponseSchema = z.object({
  items: z.array(SourceStoredSchema),
  total: z.number().int().min(0).max(1_000_000),
});

/** 单条详情（GET /api/sources/:id）。 */
export const SourceDetailSchema = z.object({
  source: SourceStoredSchema,
  /** 关联的所有 proposals（不分状态）。 */
  proposals: z.array(z.lazy(() => IngestionProposalSchema)),
  /** 已落档的关联条数。 */
  linked_profile_count: z.number().int().min(0).max(9999),
});

// ──────────────────────────────────────────────────────────────────────────
//  IngestionProposal — 蒸馏建议
// ──────────────────────────────────────────────────────────────────────────

/**
 * Proposal 状态机：
 *   pending  ─ accept ─► accepted
 *   pending  ─ edit   ─► edited（用户改了 proposed_body 后接受）
 *   pending  ─ reject ─► rejected
 *   accepted/edited/rejected 是终态，不允许再转
 */
export const ProposalStatusSchema = z.enum(["pending", "accepted", "edited", "rejected"]);

/**
 * 建议落档目标，与 profile.ts WriteRequest 的 target 对齐：
 *   core         覆盖 L1 整体
 *   card_section 追加 L2 卡片某 section
 *   journal      追加 L3 日记一条 record
 *
 * card 整张覆盖不出现在 proposal 里——蒸馏只追加，不覆盖整卡。
 *
 * chat_message（DESIGN-11 §7.2 #1 加法式新增）：
 *   聊天消息批次的落档建议；载荷在 `chat_message_staging`，本 target 只存引用与分层。
 *   只有规则/人工产该 kind——`DistillOutputSchema` **不认识**它（LLM 不应产聊天落档建议）。
 */
export const ProposalTargetKindSchema = z.enum(["core", "card_section", "journal", "chat_message"]);

/** 建议针对的具体目标（按 kind 分支）。 */
export const ProposalTargetCoreSchema = z.object({
  kind: z.literal("core"),
});

export const ProposalTargetCardSectionSchema = z.object({
  kind: z.literal("card_section"),
  card_key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .min(1)
    .max(48),
  section: z.string().min(1).max(80),
});

export const ProposalTargetJournalSchema = z.object({
  kind: z.literal("journal"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * 建议落档目标：聊天消息批次（DESIGN-11 §7.2 #1 新增）。
 * 注意：载荷在 `chat_message_staging`，本 target 只存引用与分层信息。
 * 落档走注入的 `ChatMessageCommitter`（chat-ingest.ts），**不**走 profile 写入链路。
 */
export const ProposalTargetChatMessageSchema = z.object({
  kind: z.literal("chat_message"),
  batch_id: z.string().uuid(),
  conversation_id: z.string().min(1).max(256),
  /** 本 proposal 覆盖的消息（≤2000 条，按 ts_ms 升序）。 */
  message_ids: z.array(z.string().min(1).max(256)).min(1).max(2000),
  /** 置信分层（供 UI 筛选与审计）。 */
  tier: z.enum(["auto", "review"]),
  /** Tier B 命中的规则码；Tier A 为空数组。 */
  reason_codes: z.array(z.string().min(1).max(64)).max(16).default([]),
});

export const ProposalTargetSchema = z.discriminatedUnion("kind", [
  ProposalTargetCoreSchema,
  ProposalTargetCardSectionSchema,
  ProposalTargetJournalSchema,
  ProposalTargetChatMessageSchema,
]);

export const IngestionProposalSchema = z.object({
  id: ProposalIdSchema,
  source_id: SourceIdSchema,
  target: ProposalTargetSchema,
  /** 蒸馏小模型给出的建议正文（用户接受时直接落档）。 */
  proposed_body: z.string().min(1).max(8000),
  /** 蒸馏理由 / 引用片段（调试与用户参考）。 */
  reasoning: z.string().max(2000).default(""),
  /** 引用 Source 中具体段落（行号区间或 section index 数组），可选。 */
  source_excerpts: z
    .array(
      z.object({
        start: z.number().int().min(0).max(2_000_000),
        end: z.number().int().min(0).max(2_000_000),
      }),
    )
    .max(8)
    .default([]),
  /** 蒸馏 provider id（事后审计，便于排查质量问题）。 */
  produced_by_provider: z.string().min(1).max(64),
  status: ProposalStatusSchema,
  /** 用户编辑后的 body；status=edited 时填，其他状态为 null。 */
  user_edited_body: z.string().max(8000).nullable(),
  created_at: IsoTimestampSchema,
  /** 用户决策时间（accept/edit/reject）。 */
  decided_at: IsoTimestampSchema.nullable(),
});

/** 用户决策入参（PATCH /api/sources/:sourceId/proposals/:id）。 */
export const DecideProposalAcceptSchema = z.object({
  decision: z.literal("accept"),
});

export const DecideProposalEditSchema = z.object({
  decision: z.literal("edit"),
  body: z.string().min(1).max(8000),
});

export const DecideProposalRejectSchema = z.object({
  decision: z.literal("reject"),
});

export const DecideProposalRequestSchema = z.discriminatedUnion("decision", [
  DecideProposalAcceptSchema,
  DecideProposalEditSchema,
  DecideProposalRejectSchema,
]);

// ──────────────────────────────────────────────────────────────────────────
//  Ingestion 触发 / 重新提炼
// ──────────────────────────────────────────────────────────────────────────

/**
 * 触发蒸馏（POST /api/sources/:id/ingest）。
 * - first run：source.status=raw 时调；产生 N 条 pending proposals
 * - rerun：source.status=pending_review/completed/distill_failed 时也可调（蒸馏算法 / prompt 升级）；
 *          老的 proposals 状态不动；新生成的全是 pending
 */
export const IngestRequestSchema = z.object({
  /** 蒸馏 provider id；空则用 settings.conversation.writeback_provider_id。 */
  provider_id: z.string().max(64).default(""),
  /** 引导蒸馏关注的角度（"提取人际关系信息"），可选。 */
  focus_hints: z.array(z.string().min(1).max(120)).max(4).default([]),
  /** 单次最多产出几条 proposals。 */
  max_proposals: z.number().int().min(1).max(20).default(8),
});

export const IngestResponseSchema = z.object({
  source_id: SourceIdSchema,
  produced_proposal_ids: z.array(ProposalIdSchema).max(20),
  /** 蒸馏耗时与 token，便于用户感知成本。 */
  duration_ms: z.number().int().min(0).max(600_000),
  token_usage: z.object({
    input_tokens: z.number().int().min(0).max(2_000_000),
    output_tokens: z.number().int().min(0).max(2_000_000),
  }),
});

// ──────────────────────────────────────────────────────────────────────────
//  ProfileSource — 多对多关联（profile 条目 ↔ source）
// ──────────────────────────────────────────────────────────────────────────

/** 关联到的 profile 条目类型。 */
export const ProfileSourceRefKindSchema = z.enum(["core", "card_section", "journal_record"]);

/**
 * 关联表一行。
 *
 * profile_id 形态：
 *   core             → "core_main"
 *   card_section     → "card_section:<numeric id>"
 *   journal_record   → "journal_record:<numeric id>"
 */
export const ProfileSourceLinkSchema = z.object({
  profile_kind: ProfileSourceRefKindSchema,
  profile_id: z.string().min(1).max(128),
  source_id: SourceIdSchema,
  /** 触发本关联的 proposal id（手动落档时为 null）。 */
  proposal_id: ProposalIdSchema.nullable(),
  created_at: IsoTimestampSchema,
});

/** GET /api/profile/.../sources 返回。 */
export const ProfileLinkedSourcesResponseSchema = z.object({
  links: z.array(ProfileSourceLinkSchema),
  /** 关联到的 source 详情（避免前端再 N+1 查询）。 */
  sources: z.array(SourceStoredSchema),
});

// ──────────────────────────────────────────────────────────────────────────
//  错误码
// ──────────────────────────────────────────────────────────────────────────

export const SourceErrorCodeSchema = z.enum([
  "SOURCE_NOT_FOUND", // 404
  "PROPOSAL_NOT_FOUND", // 404
  "UNSUPPORTED_MIME", // 400 — MIME 不在白名单
  "EXTRACTOR_FAILED", // 422 — pdf-parse / mammoth / etc 失败
  "URL_FETCH_FAILED", // 502 — kind=url 拉取失败
  "FILE_TOO_LARGE", // 413 — 上传文件超限
  "PROPOSAL_NOT_PENDING", // 409 — 已 accepted/rejected 不能再决策
  "DISTILL_FAILED", // 502 — 蒸馏 LLM 调用失败
  "INVALID_TARGET_REF", // 400 — proposal target 引用的 cardKey/date 不合法
]);

export const SourceErrorPayloadSchema = z.object({
  code: SourceErrorCodeSchema,
  message: z.string().min(1).max(512),
  source_id: SourceIdSchema.optional(),
  proposal_id: ProposalIdSchema.optional(),
  trace_id: z.string().min(8).max(64).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type SourceId = z.infer<typeof SourceIdSchema>;
export type ProposalId = z.infer<typeof ProposalIdSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export type SupportedMimeType = z.infer<typeof SupportedMimeTypeSchema>;

export type RawText = z.infer<typeof RawTextSchema>;
export type RawTextSection = z.infer<typeof RawTextSectionSchema>;

export type SourceStored = z.infer<typeof SourceStoredSchema>;
export type CreateSourceRequest = z.infer<typeof CreateSourceRequestSchema>;
export type ListSourcesQuery = z.infer<typeof ListSourcesQuerySchema>;
export type ListSourcesResponse = z.infer<typeof ListSourcesResponseSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;

export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
export type ProposalTargetKind = z.infer<typeof ProposalTargetKindSchema>;
export type ProposalTargetChatMessage = z.infer<typeof ProposalTargetChatMessageSchema>;
export type ProposalTarget = z.infer<typeof ProposalTargetSchema>;
export type IngestionProposal = z.infer<typeof IngestionProposalSchema>;
export type DecideProposalRequest = z.infer<typeof DecideProposalRequestSchema>;

export type IngestRequest = z.infer<typeof IngestRequestSchema>;
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

export type ProfileSourceRefKind = z.infer<typeof ProfileSourceRefKindSchema>;
export type ProfileSourceLink = z.infer<typeof ProfileSourceLinkSchema>;
export type ProfileLinkedSourcesResponse = z.infer<typeof ProfileLinkedSourcesResponseSchema>;

export type SourceErrorCode = z.infer<typeof SourceErrorCodeSchema>;
export type SourceErrorPayload = z.infer<typeof SourceErrorPayloadSchema>;
