/**
 * 能力图谱契约（0.5.0，加法式新增；**不改** `mining.ts` 的 `GraphNodeKind`）。
 *
 * 为什么独立快照而不是给 `GraphNodeKind` 加第 5 个值：`person` 节点的 size 是互动频次、
 * `size_raw` 是消息数、`community_key` 来自 co_presence 社区发现 —— 能力节点这三个量纲
 * 全部不存在。加值会连锁波及 mining 产出校验、graph-layout 归一、graph-canvas 图例与
 * `GraphNodeAttrsSchema.strict()` 的字段裁剪（详见 `docs/DESIGN-0.5.0-*.md` §B）。
 *
 * 数据来源（T03）：`profile.sqlite` 的 `cards` / `card_sections`，纯规则抽取、**不调 LLM**。
 * 抽取口径见 `dsh/knowself/src/ability/extract.ts` 头注。
 */
import { z } from "zod";
import { IsoTimestampSchema } from "./profile";

/**
 * 边类型（0.5.0 T06 起）：
 *   - `co_section`：同一「类别：」分组内共现（强边，同组全连）；
 *   - `co_project`：**跨组**的两个能力项在同一个项目/实习叙事里共同出现（跨簇桥边）；
 *   - `same_card`：同一张卡内（本期只用于 `soft_skills`，避免 skills 卡 24 点全连成毛球）；
 *   - `related`：关系词连接（保留，本期不产出）。
 */
export const AbilityEdgeKindSchema = z.enum([
  "co_section",
  "co_project",
  "same_card",
  "related",
]);

/**
 * 证据串（≤5 条/节点，≤5 条/边）。
 *
 * 形态刻意用**单串**而非嵌套对象：架构案的 `attrs` 是 `.strict()` 且 `evidence_ref`
 * 为 `string[]`，与 `GraphNodeAttrsSchema.evidence_ref` 同语义；单串能同时承载
 * 「哪张卡 / 哪一节 / 原文片段」，UI 侧直接展示即可，不必再解一层结构。
 * 约定格式：`<card_key>#<section_id> 《<section.title>》: <body 前 80 字>`
 */
export const AbilityEvidenceRefSchema = z.string().min(1).max(320);

export const AbilityNodeSchema = z.object({
  /** `ability:<sha1(lowercase(normalized label))>`（稳定 id，前端选中态依赖它）。 */
  id: z.string().min(1).max(256),
  /** 展示名：**首次出现**的原样写法（`Python` 不会被后来的 `python` 覆盖）。 */
  label: z.string().min(1).max(128),
  /** 规则打的分类：`tech` / `soft` / `other`；无从判断为 null。 */
  category: z.string().max(32).nullable(),
  /** 归一化度数到 [0,1]（口径同 `GraphNode.size`）。 */
  size: z.number().min(0).max(1),
  degree: z.number().int().min(0),
  /** 本期不产出社区发现（能力图节点量级 ≤200，社区无意义），恒为 null。 */
  community_key: z.string().max(128).nullable(),
  /** 规则置信度：命中「类别：」结构 = 0.9；纯顿号列表 = 0.7（取该节点所见最大值）。 */
  confidence: z.number().min(0).max(1),
  attrs: z
    .object({
      /** 出现该能力的资料卡 key（去重，升序）。 */
      card_keys: z.array(z.string()).max(32),
      /** 「类别：」分组名（如「后端」「数据库」）；纯列表为 null。 */
      group: z.string().max(32).nullable(),
      evidence_ref: z.array(AbilityEvidenceRefSchema).max(5).default([]),
    })
    .strict(),
});

export const AbilityEdgeSchema = z.object({
  /** `co_section:<较小 id>|<较大 id>`（与 GraphPanelEdge 的 id 约定一致：无序对）。 */
  id: z.string().min(1).max(512),
  source: z.string(),
  target: z.string(),
  kind: AbilityEdgeKindSchema,
  /** 共现的**不同资料份数**（按 body 指纹去重后计数，非出现次数）。 */
  weight_raw: z.number().min(0),
  /** weight_raw 除以全域最大权重，归一到 [0,1]。 */
  strength: z.number().min(0).max(1),
  directed: z.boolean().default(false),
  attrs: z
    .object({ evidence_ref: z.array(AbilityEvidenceRefSchema).max(5).default([]) })
    .strict(),
});

export const AbilityStatsSchema = z.object({
  node_count: z.number().int().min(0),
  edge_count: z.number().int().min(0),
  /** 参与抽取的资料卡数。 */
  card_count: z.number().int().min(0),
  /** 参与抽取的小节数（已按 body 指纹去重）。 */
  source_count: z.number().int().min(0),
});

export const AbilitySnapshotSchema = z.object({
  graph_version: z.string().min(1).max(64),
  produced_by: z.string().min(1).max(64),
  generated_at: IsoTimestampSchema,
  /** sha1(cards.key|updated_at + sections.id|sections.body)，见 `cache.ts`。 */
  fingerprint: z.string().regex(/^[0-9a-f]{40}$/),
  stats: AbilityStatsSchema,
  nodes: z.array(AbilityNodeSchema).max(500),
  edges: z.array(AbilityEdgeSchema).max(2000),
});

export type AbilityEdgeKind = z.infer<typeof AbilityEdgeKindSchema>;
export type AbilityNode = z.infer<typeof AbilityNodeSchema>;
export type AbilityEdge = z.infer<typeof AbilityEdgeSchema>;
export type AbilityStats = z.infer<typeof AbilityStatsSchema>;
export type AbilitySnapshot = z.infer<typeof AbilitySnapshotSchema>;
