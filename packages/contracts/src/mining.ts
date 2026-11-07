/**
 * mining.ts — 图谱视图契约（DESIGN-12 §8.2~§8.4 + §4.5；DESIGN-15 §4.3 #1）
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 真相源规则：`docs/shared/contracts/mining.ts` 与 `packages/contracts/src/mining.ts` 两侧必须同步。
 *
 * 消费方：
 *   - mining     产出快照（`getGraphSnapshot`，经 chat-engine 挂  `GET /api/mining/graph`）
 *   - web-ui     只做视觉映射；`co_norm` / `size` / `strength` / `community_key`
 *                **全部由 mining 输出**，前端不得重算（DESIGN-12 §8.6）
 *
 * 弱模型实施提示：
 *   1. 三个数值口径不要混淆：`size_raw` / `weight_raw` 是原始计数（审计用），
 *      `size` / `strength` 是 `[0,1]` 归一化后的视觉值。
 *   2. `attrs` 为 `.strict()`：新增字段必须走加法式扩本节 schema，不得塞临时键。
 *   3. R1 必须启用 gzip（3000 节点 / 10000 边 ≈ 3~5 MB JSON）。
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";

/** 节点类型：人物 / 群会话 / 话题。 */
export const GraphNodeKindSchema = z.enum(["person", "group", "topic"]);

/** 边类型（DESIGN-12 §8.3 定稿 6 值，不得自创）。 */
export const GraphEdgeKindSchema = z.enum([
  "co_presence",
  "direct_reply",
  "mention",
  "membership",
  "my_group",
  "topic_affinity",
]);

/**
 * 节点附加属性。
 *   msg_count_other  对方发言数（群聊归因用）
 *   last_msg_at      最近消息时间（ISO8601 带时区）
 *   evidence_ref     D4：≤5 条代表性 message_id
 */
export const GraphNodeAttrsSchema = z
  .object({
    msg_count_other: z.number().min(0).optional(),
    last_msg_at: z.string().datetime({ offset: true }).optional(),
    evidence_ref: z.array(z.string()).max(5).default([]),
  })
  .strict();

/**
 * 图谱节点（DESIGN-12 §8.2）。
 *
 * 字段说明：
 *   id              person_id | conversation_id | 'topic:<sha1>'
 *   ref_id          点击跳转锚点：person → person_id
 *   size_raw        原始互动频次（审计用）
 *   size            归一化半径（FR-11.2）
 *   community_key   'c:<sha1>'；孤立节点为 null
 *   relation_type   person 节点：与 'me' 的关系类型
 *   isolated        无可见边（低于 min_edge_strength 的边被裁掉）
 */
export const GraphNodeSchema = z.object({
  id: z.string().min(1).max(256),
  kind: GraphNodeKindSchema,
  label: z.string().min(1).max(128),
  ref_id: z.string().min(1).max(256),
  size_raw: z.number().min(0),
  size: z.number().min(0).max(1),
  community_key: z.string().max(128).nullable(),
  degree: z.number().int().min(0),
  relation_type: z.string().max(32).nullable(),
  isolated: z.boolean().default(false),
  attrs: GraphNodeAttrsSchema,
});

/**
 * 边附加属性。
 *   co_norm       结构归一化值（社区发现用）
 *   evidence_ref  D4：≤5 条代表性 message_id
 */
export const GraphEdgeAttrsSchema = z
  .object({
    co_norm: z.number().min(0).optional(),
    evidence_ref: z.array(z.string()).max(5).default([]),
  })
  .strict();

/**
 * 图谱边（DESIGN-12 §8.3）。
 *
 * 字段说明：
 *   id          '<kind>:<source>|<target>'（两端按字典序）
 *   weight_raw  原始计数（审计用）
 *   strength    视觉强度（FR-11.3）
 *   directed    mention / my_group 为 true
 */
export const GraphEdgeSchema = z.object({
  id: z.string().min(1).max(512),
  source: z.string().min(1).max(256),
  target: z.string().min(1).max(256),
  kind: GraphEdgeKindSchema,
  weight_raw: z.number().min(0),
  strength: z.number().min(0).max(1),
  directed: z.boolean().default(false),
  attrs: GraphEdgeAttrsSchema,
});

/** 社区（DESIGN-12 §8.4）；`community_key = 'c:<sha1(成员 person_id 升序)>'`。 */
export const GraphCommunitySchema = z.object({
  community_key: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  size: z.number().int().min(1),
  member_ids: z.array(z.string()).max(3000),
  group_ids: z.array(z.string()).max(500),
  /** 社区内边权密度。 */
  cohesion: z.number().min(0).max(1),
});

/** 快照参数（DESIGN-12 §4.5 的 `params`）。 */
export const GraphSnapshotParamsSchema = z.object({
  algo: z.string().min(1).max(32),
  resolution: z.number().min(0).max(10),
  gap_ms: z.number().int().min(0),
  min_edge_strength: z.number().min(0).max(1),
  max_pairwise_members: z.number().int().min(0),
  time_from: z.string().nullable(),
  time_to: z.string().nullable(),
});

/** 快照统计（DESIGN-12 §4.5 的 `stats`）。 */
export const GraphSnapshotStatsSchema = z.object({
  node_count: z.number().int().min(0),
  edge_count: z.number().int().min(0),
  community_count: z.number().int().min(0),
  modularity: z.number(),
  degraded_sessions: z.number().int().min(0),
});

/**
 * 图谱快照（DESIGN-12 §4.5 + §4.6）— `GET /api/mining/graph` 出参（D17 R1）。
 * 规模闸门：`max_nodes = 3000` / `max_edges = 10000`（超出按 size_raw 降序保留）。
 */
export const GraphSnapshotSchema = z.object({
  graph_version: z.string().min(1).max(64),
  produced_by: z.string().max(128),
  generated_at: IsoTimestampSchema,
  params: GraphSnapshotParamsSchema,
  stats: GraphSnapshotStatsSchema,
  nodes: z.array(GraphNodeSchema).max(3000),
  edges: z.array(GraphEdgeSchema).max(10_000),
  communities: z.array(GraphCommunitySchema).max(500),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>;
export type GraphNodeAttrs = z.infer<typeof GraphNodeAttrsSchema>;
export type GraphEdgeAttrs = z.infer<typeof GraphEdgeAttrsSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphCommunity = z.infer<typeof GraphCommunitySchema>;
export type GraphSnapshotParams = z.infer<typeof GraphSnapshotParamsSchema>;
export type GraphSnapshotStats = z.infer<typeof GraphSnapshotStatsSchema>;
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;
