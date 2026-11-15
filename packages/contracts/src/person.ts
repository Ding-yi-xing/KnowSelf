/**
 * person.ts — 人物 / 别名 / 关系 / 事件 / 归并契约（DESIGN-13 §14-C10）
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 真相源规则：`docs/shared/contracts/person.ts` 与 `packages/contracts/src/person.ts` 两侧必须同步。
 *
 * 消费方：chat-engine（挂路由）/ web-ui。person-store **不注册路由**。
 *
 * 时间戳口径：本文件是**行形态**（逐字抄 DESIGN-10 §2.1~§2.3 的列语义）→ ISO8601 TEXT。
 * API DTO 若需 epoch 毫秒（`*_ts_ms`），由 chat-engine 路由层转换（DESIGN-19 §3.2），
 * UI 宿主不得自行重复日期解析；使用领域契约提供的值。
 *
 * 弱模型实施提示：
 *   1. `manual_locked` 一律 `z.boolean()`（DB 的 0/1 在 repository 层转换）。
 *   2. `tags` / `evidence_ref` / `source_ref` 在 DB 是 JSON TEXT，契约层表达为数组。
 *   3. 位置坐标类字段不进契约（DESIGN-19 §3.3 注）；话题分布走 `person_facts`。
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";
import { EventKindSchema } from "./semantic";

// ──────────────────────────────────────────────────────────────────────────
//  公共原子（逐字抄 DESIGN-10 §2.1~§2.3 的 CHECK 约束）
// ──────────────────────────────────────────────────────────────────────────

/** person_id：'me' | UUID v4（'me' 为保留值）。 */
export const PersonIdSchema = z.string().min(1).max(256);
export const ScopeKindSchema = z.enum(["global", "direct", "group"]);
export const SubjectKindSchema = z.enum(["self", "contact"]);
export const PersonStatusSchema = z.enum(["active", "archived", "merged"]);
export const AliasPlatformSchema = z.enum(["wechat", "qq", "telegram", "discord", "other"]);
export const AliasKindSchema = z.enum([
  "platform_uid",
  "nickname",
  "remark",
  "group_card",
  "phone",
  "email",
  "other",
]);
export const AliasSourceSchema = z.enum(["extractor", "auto_merge", "manual"]);
export const RelationTypeSchema = z.enum([
  "family",
  "friend",
  "colleague",
  "classmate",
  "client",
  "vendor",
  "group_member",
  "acquaintance",
  "unknown",
]);
export const RelationshipDirectionSchema = z.enum(["bidirectional", "outgoing", "incoming"]);
export const RelationshipSourceSchema = z.enum(["auto", "manual", "import"]);
export const EventScopeKindSchema = z.enum(["me", "direct", "group"]);
export const EventSourceKindSchema = z.enum(["message", "proposal", "manual"]);

// ──────────────────────────────────────────────────────────────────────────
//  行形态（对应 persons.sqlite 各表）
// ──────────────────────────────────────────────────────────────────────────

/** persons 表一行（DESIGN-10 §2.1）。 */
export const PersonProfileSchema = z.object({
  person_id: PersonIdSchema,
  subject_kind: SubjectKindSchema,
  display_name: z.string().min(1).max(128),
  /** 平台备注名。 */
  remark: z.string().max(128).default(""),
  /** 拼音首字母，UI 排序用。 */
  sort_key: z.string().max(64).default(""),
  avatar_ref: z.string().max(512).nullable(),
  status: PersonStatusSchema,
  /** 非空 = 本行已被并入某主行（不物理删）。 */
  merged_into: PersonIdSchema.nullable(),
  first_msg_at: IsoTimestampSchema.nullable(),
  last_msg_at: IsoTimestampSchema.nullable(),
  msg_count: z.number().int().min(0),
  conv_count: z.number().int().min(0),
  /** 派生画像快照（话题分布 / 活跃时段 / 情感趋势）；可整层重建。 */
  profile_json: z.record(z.string(), z.unknown()).default({}),
  manual_locked: z.boolean(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/** aliases 表一行（DESIGN-10 §2.1；**无** `manual_locked` 列）。 */
export const AliasSchema = z.object({
  alias_id: z.string().min(1).max(256),
  person_id: PersonIdSchema,
  platform: AliasPlatformSchema,
  alias_kind: AliasKindSchema,
  /** 原文（平台原始 ID / 昵称 / 备注）。 */
  alias: z.string().min(1).max(256),
  /** 归一化文本（去空白、去 emoji、小写）。 */
  normalized: z.string().max(256),
  is_primary: z.boolean(),
  confidence: z.number().min(0).max(1),
  source: AliasSourceSchema,
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/** relationships 表一行（DESIGN-10 §2.2 + DESIGN-12 §9.1 #6 加列 `produced_by`）。 */
export const RelationshipSchema = z.object({
  relation_id: z.string().min(1).max(256),
  /** 关系的一方（单用户恒为 'me'）。 */
  subject_id: PersonIdSchema,
  /** 关系另一方 person_id。 */
  counterpart_id: PersonIdSchema,
  scope_kind: ScopeKindSchema,
  /** direct/group → conversation_id；global → ''。 */
  scope_id: z.string().max(256).default(""),
  relation_type: RelationTypeSchema,
  direction: RelationshipDirectionSchema,
  closeness: z.number().min(0).max(1),
  sentiment: z.number().min(-1).max(1),
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  note: z.string().max(2000).default(""),
  /** JSON: message_id / event_id（D4，≤20 条）。 */
  evidence_ref: z.array(z.string().min(1).max(256)).max(20).default([]),
  source: RelationshipSourceSchema,
  manual_locked: z.boolean(),
  /** 版本位（mining 写的行）。 */
  produced_by: z.string().max(128).default(""),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/** events 表一行（DESIGN-10 §2.3 + D13 §14-C2 `produced_by` + D14 §2.6 #1 `event_kind`）。 */
export const EventSchema = z.object({
  event_id: z.string().min(1).max(256),
  subject_id: PersonIdSchema,
  /** 相关他人；纯「我」的事件为 null。 */
  person_id: PersonIdSchema.nullable(),
  conversation_id: z.string().max(256).nullable(),
  scope_kind: EventScopeKindSchema,
  event_kind: EventKindSchema,
  title: z.string().min(1).max(200),
  summary: z.string().max(2000).default(""),
  /** 'YYYY-MM-DD'。 */
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** ISO8601（精确时间，可空）。 */
  occurred_at: IsoTimestampSchema.nullable(),
  importance: z.number().int().min(1).max(5),
  tags: z.array(z.string().min(1).max(32)).max(8).default([]),
  source_kind: EventSourceKindSchema,
  /** JSON: message_id 数组（D4，≤20 条）。 */
  source_ref: z.array(z.string().min(1).max(256)).max(20).default([]),
  confidence: z.number().min(0).max(1),
  manual_locked: z.boolean(),
  produced_by: z.string().max(128).default(""),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/** 归并候选（DESIGN-13 §5.2；**只读不落库**）。 */
export const MergeCandidateSchema = z.object({
  from_person_id: PersonIdSchema,
  into_person_id: PersonIdSchema,
  /** `min(0.95, 1 − Π(1 − c_i))`。 */
  confidence: z.number().min(0).max(1),
  /** 参与计算的 alias_id 列表。 */
  evidence_alias_ids: z.array(z.string().min(1).max(256)).max(64).default([]),
  /** 命中 §5.3 硬拒绝的规则码（UI 展示为「不可自动归并」）。 */
  blocked_reasons: z.array(z.string().min(1).max(64)).max(16).default([]),
});

// ──────────────────────────────────────────────────────────────────────────
//  常量（DESIGN-19 附录 A：位置 person.ts，不得散落硬编码）
// ──────────────────────────────────────────────────────────────────────────

/** 情感趋势最多保留期数（DESIGN-14 §4.2 同值）。 */
export const SENTIMENT_TREND_MAX_PERIODS = 12;
/** 证据引用上限（DESIGN-13 附录 A / §8.1）。 */
export const MAX_EVIDENCE_REFS = 20;
/** `trace()` 摘要截断字符数（DESIGN-13 附录 A / §8.2）。 */
export const TRACE_EXCERPT_CHARS = 200;

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type ScopeKind = z.infer<typeof ScopeKindSchema>;
export type SubjectKind = z.infer<typeof SubjectKindSchema>;
export type PersonStatus = z.infer<typeof PersonStatusSchema>;
export type PersonProfile = z.infer<typeof PersonProfileSchema>;
export type Alias = z.infer<typeof AliasSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type Event = z.infer<typeof EventSchema>;
export type MergeCandidate = z.infer<typeof MergeCandidateSchema>;
