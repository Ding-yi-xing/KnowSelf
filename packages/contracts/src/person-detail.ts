/**
 * person-detail.ts — 人物详情页 DTO 契约（DESIGN-19 §3.4）
 *
 * 定位：与 person.ts 同规则的 Zod schema 单一真相源（两侧必须同步）。
 * 拆文件理由：DESIGN-19 §3.4 的 DTO 并入 person.ts 会突破「单文件 ≤200 行」硬约束。
 *
 * 时间戳口径（DESIGN-19 §3.2）：DTO 一律 `*_ts_ms`（epoch 毫秒）；
 * 时间字段遵循当前契约；宿主 UI 不得重复解析或改写其语义。
 *
 * 本文件**只收录字段可逐字回溯**到设计文档的 DTO：
 *   PersonDetailSchema          DESIGN-19 §3.4 代码块（逐字照抄）
 *   SentimentTrendPointSchema   DESIGN-14 §4.1 聚合结构字段表
 *   PersonPatchSchema           DESIGN-19 §3.3-N13 + §4.1 白名单
 *   RelationshipPatchSchema     DESIGN-19 §4.1 白名单
 *   EventWriteRequestSchema     DESIGN-19 §6.3 表单字段表（N6 用 .partial()）
 *   TraceRowSchema              DESIGN-13 §8.2 接口定义（逐字照抄）
 * 其余 DTO（PersonRecord / PersonLite / PersonMetric / PersonMetricsResponse /
 * EventTimelineResponse / EventRecord / MergeCandidateList / MergeResult / TraceResponse /
 * RelationshipRecord / AliasRecord）设计文档**只给名称、无字段定义** → 不臆造，见工单回报。
 */

import { z } from "zod";
import {
  AliasSchema,
  MAX_EVIDENCE_REFS,
  RelationshipSchema,
  RelationTypeSchema,
  SENTIMENT_TREND_MAX_PERIODS,
  TRACE_EXCERPT_CHARS,
} from "./person";
import { EventKindSchema, SentimentLabelSchema } from "./semantic";

/** 日期列格式（DESIGN-10 §2.3：`YYYY-MM-DD`）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 情感趋势点（DESIGN-14 §4.1 聚合结构；写 `persons.profile_json.sentiment_trend`）。
 * `label` 由 `score` 确定性推导（≥0.2 / (-0.2,0.2) / ≤-0.2），**不由 LLM 自由填**。
 */
export const SentimentTrendPointSchema = z.object({
  /** `YYYY-Www` / `YYYY-MM`（与 `person_metrics.period_key` 同格式）。 */
  period: z.string().regex(/^\d{4}-(W\d{2}|\d{2})$/),
  score: z.number().min(-1).max(1),
  label: SentimentLabelSchema,
  /** 该期参与聚合的片段数。 */
  samples: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  /** `message_id[]` ≤20（D13 §8.1 上限），`ts_ms` 降序。 */
  evidence_ref: z.array(z.string().min(1).max(256)).max(MAX_EVIDENCE_REFS).default([]),
});

/** 人工编辑人物档案入参（DESIGN-19 §3.3-N13；白名单**不得扩展**）。 */
export const PersonPatchSchema = z
  .object({
    display_name: z.string().min(1).max(128).optional(),
    remark: z.string().max(128).optional(),
    sort_key: z.string().max(64).optional(),
  })
  .strict();

/** 人工编辑关系入参（DESIGN-19 §3.3-N16；白名单**不得扩展**）。 */
export const RelationshipPatchSchema = z
  .object({
    relation_type: RelationTypeSchema.optional(),
    closeness: z.number().min(0).max(1).optional(),
    sentiment: z.number().min(-1).max(1).optional(),
    tags: z.array(z.string().min(1).max(32)).max(16).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

/**
 * 人工新增 / 修正事件入参（DESIGN-19 §6.3 表单字段表）。
 * N5（新增）用完整形态；N6（修正）用 `EventWriteRequestSchema.partial()`（§3.3-N6「部分字段」）。
 */
export const EventWriteRequestSchema = z
  .object({
    title: z.string().min(1).max(30),
    summary: z.string().max(200).default(""),
    event_date: z.string().regex(DATE_RE),
    /** 8 值封闭枚举（D14 §5.2），表单默认 `other`。 */
    event_kind: EventKindSchema.default("other"),
    importance: z.number().int().min(1).max(5).default(3),
    tags: z.array(z.string().min(1).max(32)).max(5).default([]),
  })
  .strict();

/** 回溯行（DESIGN-13 §8.2 逐字；只读、幂等、不写任何表）。 */
export const TraceRowSchema = z.object({
  message_id: z.string().min(1).max(256),
  conversation_id: z.string().min(1).max(256),
  /** epoch 毫秒（与 DTO 口径一致）。 */
  ts_ms: z.number().int(),
  msg_date: z.string().regex(DATE_RE),
  /** 采集时快照，不随归并变化（D13 §5.5）。 */
  sender_name: z.string().max(128),
  /** DESIGN-10 §2.4 的 CHECK 8 值。 */
  content_type: z.enum(["text", "image", "file", "link", "voice", "video", "system", "other"]),
  /** 查询期截断 ≤200 字符，**不落库**（D13 §8.2）。 */
  content_excerpt: z.string().max(TRACE_EXCERPT_CHARS),
});

/**
 * 人物详情聚合（DESIGN-19 §3.4 逐字照抄；N1 出参）。
 * 注：话题分布**不进** `person` 对象（走 `person_facts`，§3.4 注）；位置坐标类字段不进契约。
 */
export const PersonDetailSchema = z
  .object({
    person: z
      .object({
        person_id: z.string().min(1).max(256),
        subject_kind: z.enum(["self", "contact"]),
        display_name: z.string().min(1).max(128),
        remark: z.string().max(128),
        sort_key: z.string().max(64),
        avatar_ref: z.string().max(512).nullable(),
        status: z.enum(["active", "archived", "merged"]),
        merged_into: z.string().max(256).nullable(),
        first_ts_ms: z.number().int().nullable(),
        last_ts_ms: z.number().int().nullable(),
        msg_count: z.number().int().min(0),
        conv_count: z.number().int().min(0),
        manual_locked: z.boolean(),
        sentiment_trend: z.array(SentimentTrendPointSchema).max(SENTIMENT_TREND_MAX_PERIODS),
      })
      .strict(),
    aliases: z.array(AliasSchema).max(200),
    relationships: z.array(RelationshipSchema).max(200),
    /** 如 `INSUFFICIENT_SAMPLES` / 无指标。 */
    warnings: z.array(z.string()).default([]),
  })
  .strict();

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type SentimentTrendPoint = z.infer<typeof SentimentTrendPointSchema>;
export type PersonPatch = z.infer<typeof PersonPatchSchema>;
export type RelationshipPatch = z.infer<typeof RelationshipPatchSchema>;
export type EventWriteRequest = z.infer<typeof EventWriteRequestSchema>;
export type TraceRow = z.infer<typeof TraceRowSchema>;
export type PersonDetail = z.infer<typeof PersonDetailSchema>;
