import { describe, it, expect } from "vitest";
import {
  GraphNodeKindSchema,
  GraphEdgeKindSchema,
  GraphNodeAttrsSchema,
  GraphNodeSchema,
  GraphEdgeAttrsSchema,
  GraphEdgeSchema,
  GraphCommunitySchema,
  GraphSnapshotParamsSchema,
  GraphSnapshotStatsSchema,
  GraphSnapshotSchema,
} from "../src/mining";

const node = {
  id: "p_0001",
  kind: "person",
  label: "张三",
  ref_id: "p_0001",
  size_raw: 128,
  size: 0.82,
  community_key: "c:abcd",
  degree: 7,
  relation_type: "friend",
  isolated: false,
  attrs: { msg_count_other: 64, last_msg_at: "2026-09-09T20:00:00+08:00", evidence_ref: ["m1"] },
};

const edge = {
  id: "co_presence:p_0001|p_0002",
  source: "p_0001",
  target: "p_0002",
  kind: "co_presence",
  weight_raw: 12,
  strength: 0.4,
  directed: false,
  attrs: { co_norm: 0.3, evidence_ref: ["m1", "m2"] },
};

const community = {
  community_key: "c:abcd",
  label: "张三 等 5 人",
  size: 5,
  member_ids: ["p_0001", "p_0002"],
  group_ids: ["wechat:g1"],
  cohesion: 0.55,
};

const snapshot = {
  graph_version: "mining-graph-v1",
  produced_by: "mining:graph-v1",
  generated_at: "2026-09-09T20:00:00+08:00",
  params: {
    algo: "louvain",
    resolution: 1.0,
    gap_ms: 1_800_000,
    min_edge_strength: 0.05,
    max_pairwise_members: 200,
    time_from: "2026-06-11",
    time_to: "2026-09-09",
  },
  stats: {
    node_count: 1,
    edge_count: 1,
    community_count: 1,
    modularity: 0.42,
    degraded_sessions: 0,
  },
  nodes: [node],
  edges: [edge],
  communities: [community],
};

describe("mining 图谱契约", () => {
  it("GraphNodeKindSchema 取 3 值且拒绝自创值", () => {
    expect(GraphNodeKindSchema.options).toEqual(["person", "group", "topic", "direct"]);
    expect(GraphNodeKindSchema.safeParse("robot").success).toBe(false);
  });

  it("GraphEdgeKindSchema 取 6 值且拒绝自创值", () => {
    expect(GraphEdgeKindSchema.options).toHaveLength(6);
    expect(GraphEdgeKindSchema.safeParse("co_presence").success).toBe(true);
    expect(GraphEdgeKindSchema.safeParse("unknown_edge").success).toBe(false);
  });

  it("GraphNodeAttrsSchema 是 strict 且 evidence_ref 默认 []", () => {
    const parsed = GraphNodeAttrsSchema.parse({});
    expect(parsed.evidence_ref).toEqual([]);
    expect(GraphNodeAttrsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("GraphNodeSchema 接受完整节点并拒绝越界 size", () => {
    expect(GraphNodeSchema.parse(node).size).toBe(0.82);
    expect(GraphNodeSchema.safeParse({ ...node, size: 1.5 }).success).toBe(false);
    expect(GraphNodeSchema.safeParse({ ...node, isolated: undefined }).success).toBe(true);
  });

  it("GraphEdgeAttrsSchema 是 strict 且 co_norm 可选", () => {
    expect(GraphEdgeAttrsSchema.parse({}).evidence_ref).toEqual([]);
    expect(GraphEdgeAttrsSchema.safeParse({ nope: true }).success).toBe(false);
  });

  it("GraphEdgeSchema 接受完整边（directed 默认 false）", () => {
    const { directed: _directed, ...noDirected } = edge;
    expect(GraphEdgeSchema.parse(noDirected).directed).toBe(false);
    expect(GraphEdgeSchema.safeParse({ ...edge, kind: "bogus" }).success).toBe(false);
  });

  it("GraphCommunitySchema 接受社区并拒绝空成员标签", () => {
    expect(GraphCommunitySchema.parse(community).cohesion).toBe(0.55);
    expect(GraphCommunitySchema.safeParse({ ...community, label: "" }).success).toBe(false);
  });

  it("GraphSnapshotParamsSchema 接受 §4.5 的 params", () => {
    expect(GraphSnapshotParamsSchema.parse(snapshot.params).algo).toBe("louvain");
  });

  it("GraphSnapshotStatsSchema 接受 §4.5 的 stats", () => {
    expect(GraphSnapshotStatsSchema.parse(snapshot.stats).node_count).toBe(1);
  });

  it("GraphSnapshotSchema 接受完整快照并套用规模闸门", () => {
    const parsed = GraphSnapshotSchema.parse(snapshot);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.graph_version).toBe("mining-graph-v1");
    expect(
      GraphSnapshotSchema.safeParse({ ...snapshot, nodes: new Array(3001).fill(node) }).success,
    ).toBe(false);
  });
});
