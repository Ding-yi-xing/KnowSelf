/**
 * semantic.ts — 语义抽取契约（情感趋势 + 关键事件；DESIGN-14 §2.5(c)）
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 引擎归属 `mining`，数据归属 `person-store`；**本设计不注册路由**。
 *
 * 消费方：
 *   - mining（`src/semantic/*`）用 `SemanticExtractOutputSchema` 校验 LLM 结构化输出
 *   - person-store 用 `SentimentSessionSchema` 的 `fact_value` 载荷写
 *     `person_facts(fact_kind='sentiment', fact_key='session:<session_key>')`
 *
 * 弱模型实施提示：
 *   1. LLM **只产候选**：`label` 不由 LLM 填，由 §4.1 阈值确定性推导
 *      （`≥0.2` / `(-0.2,0.2)` / `≤-0.2`）——见 DESIGN-14 §4.4 #6。
 *   2. `evidence` 中的 message_id 必须原样来自输入，不得编造（≤5 个/事件）。
 *   3. `date_explicit=false` 时 `event_date` 必须为 null（后处理用片段日期填充）。
 *   4. 事件枚举封闭：只能取 8 个 `event_kind`；`other` 是兜底。
 */

import { z } from "zod";

/**
 * 事件类型体系（DESIGN-14 §5.2 定稿 8 值，不得自创）。
 *   meetup      线下见面 / 聚会
 *   transaction 交易 / 金钱往来（high tier）
 *   milestone   人生里程碑（high tier）
 *   health      健康事件（high tier）
 *   work        工作 / 学业变动（high tier）
 *   conflict    冲突 / 矛盾
 *   travel      出行 / 行程
 *   other       其他重要事件（L1 兜底）
 */
export const EventKindSchema = z.enum([
  "meetup",
  "transaction",
  "milestone",
  "health",
  "work",
  "conflict",
  "travel",
  "other",
]);

/** 情感标签（**由 score 确定性推导**，不由 LLM 自由填）。 */
export const SentimentLabelSchema = z.enum(["positive", "neutral", "negative"]);

/**
 * 事件候选（DESIGN-14 §5.3 的 L1 输出项）。
 *   title          ≤30 字，客观陈述（L0 截断口径）
 *   summary        ≤200 字，含关键细节（地点 / 金额 / 结果）
 *   date_explicit  false → `event_date` 必须为 null
 *   importance     1~5
 *   evidence       ≤5 个 message_id，原样来自输入
 */
export const EventCandidateSchema = z.object({
  event_kind: EventKindSchema,
  title: z.string().min(1).max(30),
  summary: z.string().max(200).default(""),
  event_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  date_explicit: z.boolean(),
  occurred_at: z.string().datetime({ offset: true }).nullable(),
  importance: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1).max(256)).max(5).default([]),
});

/** 片段级情感（L1 只给 score + confidence；label 由阈值推导）。 */
export const SemanticSentimentSchema = z.object({
  score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
});

/**
 * 一次 LLM 调用的结构化出参（DESIGN-14 §5.3 prompt 骨架的输出形状）。
 * 一次调用同时产出情感与事件（同一份上下文，避免重复读取）。
 */
export const SemanticExtractOutputSchema = z.object({
  events: z.array(EventCandidateSchema).max(5),
  sentiment: SemanticSentimentSchema,
});

/**
 * 片段级情感结果（DESIGN-14 §4.1；L0 与 L1 共用形状）。
 * 落点：`person_facts.fact_value` 的 JSON 字符串。
 *   method   rule = L0 词典基线；llm = L1 增强
 *   samples  参与聚合的片段消息数（L0 口径为命中词数相关样本）
 */
export const SentimentSessionSchema = z.object({
  session_key: z.string().min(1).max(128),
  person_id: z.string().min(1).max(256),
  score: z.number().min(-1).max(1),
  label: SentimentLabelSchema,
  confidence: z.number().min(0).max(1),
  method: z.enum(["rule", "llm"]),
  samples: z.number().int().min(0),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type EventKind = z.infer<typeof EventKindSchema>;
export type SentimentLabel = z.infer<typeof SentimentLabelSchema>;
export type EventCandidate = z.infer<typeof EventCandidateSchema>;
export type SemanticSentiment = z.infer<typeof SemanticSentimentSchema>;
export type SemanticExtractOutput = z.infer<typeof SemanticExtractOutputSchema>;
export type SentimentSession = z.infer<typeof SentimentSessionSchema>;
