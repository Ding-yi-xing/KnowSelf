/**
 * mining 只读 API 层测试（DESIGN-12 §8.5 读函数 + §8.1 过滤口径）。
 *
 * 覆盖：
 * - `getGraphSnapshot`：快照选择（最新 / snapshot_id / scope）、§8.1 第 723 行的四个过滤维度、
 *   诱导子图、过滤后 `degree` / `isolated` / `stats` 计数重算、幂等
 * - `getPersonMetrics`：person / period / period_key / keys 过滤
 * - `getRanking`：top 默认与上限、排序确定性、display_name join、残缺行跳过、from/to 未支持
 *
 * 全部合成数据（人名只用 我 / 张三 / 李四 / 王五），无真实聊天内容（不变量 #11）。
 */
import { describe, expect, it } from "vitest";
import type { GraphCommunity, GraphEdge, GraphNode } from "@knowself/contracts";
import type { GraphSnapshotRow, MetricRow, PersonRow } from "@knowself/person-store";
import {
  RANKING_TOP_MAX,
  getGraphSnapshot,
  getPersonMetrics,
  getRanking,
  type MiningReadStore,
} from "../src/read";

const NOW = "2026-09-22T10:00:00+08:00";
const OLDER = "2026-09-21T10:00:00+08:00";

// ── fixtures ────────────────────────────────────────────────────────────────

function node(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    kind: "person",
    label: overrides.id,
    ref_id: overrides.id,
    size_raw: 10,
    size: 0.5,
    community_key: null,
    degree: 0,
    relation_type: null,
    isolated: false,
    attrs: {},
    ...overrides,
  } as GraphNode;
}

function edge(overrides: Partial<GraphEdge> & { id: string }): GraphEdge {
  return {
    source: "me",
    target: "zhangsan",
    kind: "direct_reply",
    weight_raw: 1,
    strength: 0.5,
    directed: false,
    attrs: {},
    ...overrides,
  } as GraphEdge;
}

function community(overrides: Partial<GraphCommunity> & { community_key: string }): GraphCommunity {
  return {
    label: "我 等 2 人",
    size: 2,
    member_ids: ["me"],
    group_ids: [],
    cohesion: 0.5,
    ...overrides,
  } as GraphCommunity;
}

/** 合成快照载荷：me / 张三(client) / 李四(vendor) / 王五(孤立) + 群 group-1。 */
function payload(overrides: {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  communities?: GraphCommunity[];
} = {}): string {
  const nodes = overrides.nodes ?? [
    node({ id: "me", label: "我", size_raw: 100, size: 1, community_key: "c:1" }),
    node({ id: "zhangsan", label: "张三", size_raw: 40, size: 0.4, community_key: "c:1", relation_type: "client" }),
    node({ id: "lisi", label: "李四", size_raw: 8, size: 0.08, community_key: "c:2", relation_type: "vendor" }),
    node({ id: "wangwu", label: "王五", size_raw: 3, size: 0.03, community_key: null, isolated: true }),
    node({ id: "group-1", kind: "group", label: "三人小群", ref_id: "group-1", size_raw: 50, size: 0.5, community_key: "c:1" }),
  ];
  const edges = overrides.edges ?? [
    edge({ id: "direct_reply:me|zhangsan", source: "me", target: "zhangsan", weight_raw: 30, strength: 0.9 }),
    edge({ id: "co_presence:lisi|me", source: "lisi", target: "me", kind: "co_presence", weight_raw: 6, strength: 0.2 }),
    edge({ id: "membership:group-1|zhangsan", source: "group-1", target: "zhangsan", kind: "membership", weight_raw: 20, strength: 0.6 }),
    edge({ id: "mention:me|wangwu", source: "me", target: "wangwu", kind: "mention", weight_raw: 1, strength: 0.03, directed: true }),
  ];
  const communities = overrides.communities ?? [
    community({ community_key: "c:1", label: "我 等 3 人", size: 3, member_ids: ["me", "zhangsan"], group_ids: ["group-1"] }),
    community({ community_key: "c:2", label: "李四", size: 1, member_ids: ["lisi"], cohesion: 0.4 }),
  ];
  return JSON.stringify({
    graph_version: "mining-graph-v1",
    produced_by: "mining:graph-v1",
    generated_at: NOW,
    params: {
      algo: "louvain",
      resolution: 1,
      gap_ms: 1_800_000,
      min_edge_strength: 0.05,
      max_pairwise_members: 200,
      time_from: null,
      time_to: null,
    },
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      community_count: communities.length,
      modularity: 0.42,
      degraded_sessions: 0,
    },
    nodes,
    edges,
    communities,
  });
}

function snapshotRow(overrides: Partial<GraphSnapshotRow> = {}): GraphSnapshotRow {
  return {
    snapshot_id: "snap-2",
    graph_kind: "cooccurrence",
    scope_kind: "global",
    scope_id: "",
    time_from: null,
    time_to: null,
    params_json: "{}",
    payload_json: payload(),
    node_count: 5,
    edge_count: 4,
    community_count: 2,
    produced_by: "mining:graph-v1",
    computed_at: NOW,
    ...overrides,
  };
}

function person(overrides: Partial<PersonRow> & { person_id: string }): PersonRow {
  return {
    subject_kind: "contact",
    display_name: overrides.person_id,
    remark: "",
    sort_key: "",
    avatar_ref: null,
    status: "active",
    merged_into: null,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: 0,
    conv_count: 0,
    ...overrides,
  } as PersonRow;
}

function metric(overrides: Partial<MetricRow> & { metric_key: string }): MetricRow {
  return {
    metric_id: `m-${overrides.person_id ?? "me"}-${overrides.metric_key}`,
    person_id: "me",
    scope_kind: "global",
    scope_id: "",
    period: "all",
    period_key: "",
    metric_value: 1,
    metric_value_json: null,
    metric_unit: "count",
    computed_at: NOW,
    produced_by: "mining:metrics-v1",
    source_ref: "[]",
    evidence_count: 0,
    manual_locked: false,
    ...overrides,
  } as MetricRow;
}

interface FakeOptions {
  readonly snapshots?: readonly GraphSnapshotRow[];
  readonly metrics?: readonly MetricRow[];
  readonly persons?: readonly PersonRow[];
}

function fakeStore(options: FakeOptions = {}): MiningReadStore {
  const snapshots = options.snapshots ?? [];
  const metrics = options.metrics ?? [];
  const persons = options.persons ?? [];
  return {
    listPersons: () => [...persons],
    metrics: {
      list: (q) =>
        metrics.filter(
          (row) =>
            (q.person_id === undefined || row.person_id === q.person_id) &&
            (q.period === undefined || row.period === q.period) &&
            (q.period_key === undefined || row.period_key === q.period_key) &&
            (q.metric_keys === undefined || q.metric_keys.includes(row.metric_key)),
        ),
      listGraphSnapshots: (q) =>
        snapshots.filter(
          (row) =>
            (q?.graph_kind === undefined || row.graph_kind === q.graph_kind) &&
            (q?.scope_kind === undefined || row.scope_kind === q.scope_kind) &&
            (q?.scope_id === undefined || row.scope_id === q.scope_id),
        ),
    },
  };
}

// ── getGraphSnapshot ────────────────────────────────────────────────────────

describe("getGraphSnapshot · 截断必须显形（批次 A1）", () => {
  /** 造一个"候选 20 条、实际只落 4 条"的快照 payload。 */
  function truncatedPayload(): string {
    const base = JSON.parse(payload());
    base.stats = { ...base.stats, edge_candidates: 20 };
    return JSON.stringify(base);
  }

  it("快照里有 edge_candidates 且大于实际边数 → warnings 带 candidate/kept", () => {
    const snapshots: GraphSnapshotRow[] = [
      snapshotRow({ payload_json: truncatedPayload(), edge_count: 4 }),
    ];
    const result = getGraphSnapshot(fakeStore({ snapshots }));
    expect(result).not.toBeNull();
    const warnings = result?.warnings ?? [];
    expect(warnings.some((w) => w.startsWith("GRAPH_EDGES_TRUNCATED:"))).toBe(true);
    expect(warnings.find((w) => w.startsWith("GRAPH_EDGES_TRUNCATED:"))).toContain("candidate=20");
    expect(result?.snapshot.stats.edge_candidates).toBe(20);
  });

  it("未截断（无 edge_candidates）→ 不产生多余告警", () => {
    const snapshots: GraphSnapshotRow[] = [snapshotRow()];
    const result = getGraphSnapshot(fakeStore({ snapshots }));
    expect((result?.warnings ?? []).filter((w) => w.startsWith("GRAPH_EDGES_TRUNCATED:"))).toHaveLength(0);
  });
});


describe("getGraphSnapshot（DESIGN-12 §8.5-A1 / §8.1 过滤口径）", () => {
  it("默认取 global+'' 的最新快照（按 computed_at 降序第一条）", () => {
    const store = fakeStore({
      snapshots: [
        snapshotRow({ snapshot_id: "snap-old", computed_at: OLDER }),
        snapshotRow({ snapshot_id: "snap-new", computed_at: NOW }),
      ],
    });

    const result = getGraphSnapshot(store);

    expect(result?.snapshot.nodes).toHaveLength(5);
    expect(result?.snapshot.edges).toHaveLength(4);
  });

  it("无快照时返回 null（路由据此映射 404）", () => {
    expect(getGraphSnapshot(fakeStore())).toBeNull();
  });

  it("snapshot_id 显式选择历史快照（不经最新约定）", () => {
    const store = fakeStore({
      snapshots: [
        snapshotRow({ snapshot_id: "snap-old", computed_at: OLDER }),
        snapshotRow({ snapshot_id: "snap-new", computed_at: NOW }),
      ],
    });

    const result = getGraphSnapshot(store, { snapshot_id: "snap-old" });

    expect(result?.snapshot.generated_at).toBe(NOW); // 载荷自身时间戳不变
    expect(result?.snapshot.stats.modularity).toBe(0.42);
  });

  it("scope_kind / scope_id 定位快照（direct 范围）", () => {
    const store = fakeStore({
      snapshots: [
        snapshotRow({ snapshot_id: "snap-g", scope_kind: "global", scope_id: "" }),
        snapshotRow({ snapshot_id: "snap-d", scope_kind: "direct", scope_id: "wechat:conv-1", computed_at: OLDER }),
      ],
    });

    const result = getGraphSnapshot(store, { scope_kind: "direct", scope_id: "wechat:conv-1" });

    expect(result?.snapshot.nodes).toHaveLength(5);
  });

  it("min_strength 过滤边并重算 degree / isolated / stats 计数", () => {
    const store = fakeStore({ snapshots: [snapshotRow()] });

    const result = getGraphSnapshot(store, { min_strength: 0.5 });
    const snapshot = result!.snapshot;

    // 只剩 strength ≥ 0.5 的两条边（0.9 / 0.6）
    expect(snapshot.edges.map((e) => e.id).sort()).toEqual([
      "direct_reply:me|zhangsan",
      "membership:group-1|zhangsan",
    ]);
    expect(snapshot.stats.edge_count).toBe(2);
    // 王五 原本靠 mention 边（0.03）连边 → 过滤后无可见边 → isolated 由 §8.2 定义重算
    expect(snapshot.nodes.find((n) => n.id === "wangwu")?.isolated).toBe(true);
    expect(snapshot.nodes.find((n) => n.id === "zhangsan")?.degree).toBe(2);
    expect(snapshot.nodes.find((n) => n.id === "me")?.degree).toBe(1);
    // 李四 只剩 0 条边
    expect(snapshot.nodes.find((n) => n.id === "lisi")?.isolated).toBe(true);
    expect(snapshot.nodes.find((n) => n.id === "lisi")?.degree).toBe(0);
    // modularity 是构建期诊断量，不随显示过滤变化
    expect(snapshot.stats.modularity).toBe(0.42);
  });

  it("relation_types 按 person 节点 relation_type 过滤（诱导子图）", () => {
    const store = fakeStore({ snapshots: [snapshotRow()] });

    const result = getGraphSnapshot(store, { relation_types: ["client"] });
    const snapshot = result!.snapshot;

    // 保留集 = {kind:'person' ∧ relation_type∈集合} = {张三}（§8.1 第 723 行 + D15 §4.2 #3）
    expect(snapshot.nodes.map((n) => n.id)).toEqual(["zhangsan"]);
    // 张三 的两条边都指向保留集外的节点 → 诱导子图无存活边
    expect(snapshot.edges).toHaveLength(0);
    expect(snapshot.stats.node_count).toBe(1);
    expect(snapshot.stats.edge_count).toBe(0);
    // 社区同步收敛：c:1 仍有保留成员（张三）→ 保留但其成员表收敛到保留集；c:2 无保留成员 → 剔除
    expect(snapshot.communities.map((c) => c.community_key)).toEqual(["c:1"]);
    expect(snapshot.communities[0]!.member_ids).toEqual(["zhangsan"]);
    expect(snapshot.communities[0]!.group_ids).toEqual([]); // group-1 未进保留集
    expect(snapshot.communities[0]!.size).toBe(1);
  });

  it("min_interaction 按 size_raw 阈值过滤，且与 relation_types 叠加", () => {
    const store = fakeStore({ snapshots: [snapshotRow()] });

    const bySize = getGraphSnapshot(store, { min_interaction: 40 })!.snapshot;
    // 全部 kind 统一按 size_raw：me(100) / 张三(40) / group-1(50)
    expect(bySize.nodes.map((n) => n.id).sort()).toEqual(["group-1", "me", "zhangsan"]);

    const stacked = getGraphSnapshot(store, { min_interaction: 40, relation_types: ["client"] })!.snapshot;
    expect(stacked.nodes.map((n) => n.id)).toEqual(["zhangsan"]);
  });

  it("communities[] 过滤节点并同步收敛 communities 数组", () => {
    const store = fakeStore({ snapshots: [snapshotRow()] });

    const result = getGraphSnapshot(store, { communities: ["c:2"] });
    const snapshot = result!.snapshot;

    expect(snapshot.nodes.map((n) => n.id)).toEqual(["lisi"]);
    expect(snapshot.communities.map((c) => c.community_key)).toEqual(["c:2"]);
  });

  it("edge_kinds[] 按边 kind 过滤（§8.1 第 723 行加法式维度）", () => {
    const store = fakeStore({ snapshots: [snapshotRow()] });

    const result = getGraphSnapshot(store, { edge_kinds: ["co_presence", "mention"] });
    const snapshot = result!.snapshot;

    expect(snapshot.edges.map((e) => e.kind).sort()).toEqual(["co_presence", "mention"]);
    // 节点不因 edge_kinds 被剔除（只过滤边）
    expect(snapshot.nodes).toHaveLength(5);
    // 张三 只剩 0 条边 → isolated 重算
    expect(snapshot.nodes.find((n) => n.id === "zhangsan")?.isolated).toBe(true);
  });

  it("只读且幂等：同参数两次调用结果逐字段一致", () => {
    const store = fakeStore({ snapshots: [snapshotRow()] });

    const first = getGraphSnapshot(store, { min_strength: 0.5, edge_kinds: ["direct_reply"] });
    const second = getGraphSnapshot(store, { min_strength: 0.5, edge_kinds: ["direct_reply"] });

    expect(second).toEqual(first);
  });

  it("无过滤参数时原样返回快照（不重算、不改写字段）", () => {
    const store = fakeStore({ snapshots: [snapshotRow()] });

    const snapshot = getGraphSnapshot(store)!.snapshot;

    expect(snapshot.nodes.find((n) => n.id === "me")?.degree).toBe(0); // 载荷原值，未被重算
    expect(snapshot.stats.node_count).toBe(5);
  });

  it("snapshot_id 未命中时返回 null（不回退到最新快照）", () => {
    const store = fakeStore({ snapshots: [snapshotRow({ snapshot_id: "snap-2" })] });

    expect(getGraphSnapshot(store, { snapshot_id: "snap-does-not-exist" })).toBeNull();
  });

  it("库中载荷非法时抛错（不静默降级，不变量 #6/#7）", () => {
    const store = fakeStore({ snapshots: [snapshotRow({ payload_json: '{"graph_version":"x"}' })] });

    expect(() => getGraphSnapshot(store)).toThrow();
  });
});

// ── getPersonMetrics ────────────────────────────────────────────────────────

describe("getPersonMetrics（DESIGN-12 §8.5-R2）", () => {
  const rows = [
    metric({ person_id: "zhangsan", metric_key: "msg_count_other", metric_value: 42 }),
    metric({ person_id: "zhangsan", metric_key: "reply_latency_median_ms", metric_value: 900 }),
    metric({ person_id: "zhangsan", metric_key: "msg_count_other", metric_value: 7, period: "week", period_key: "2026-W38" }),
    metric({ person_id: "lisi", metric_key: "msg_count_other", metric_value: 5 }),
  ];

  it("返回该 person 的全部指标行（不筛选时）", () => {
    const result = getPersonMetrics(fakeStore({ metrics: rows }), "zhangsan");

    expect(result.person_id).toBe("zhangsan");
    expect(result.rows).toHaveLength(3);
  });

  it("period / period_key 过滤", () => {
    const result = getPersonMetrics(fakeStore({ metrics: rows }), "zhangsan", {
      period: "week",
      period_key: "2026-W38",
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.metric_value).toBe(7);
  });

  it("keys[] 过滤指标键；空数组视为不筛选", () => {
    const store = fakeStore({ metrics: rows });

    const filtered = getPersonMetrics(store, "zhangsan", { keys: ["reply_latency_median_ms"] });
    expect(filtered.rows.map((r) => r.metric_key)).toEqual(["reply_latency_median_ms"]);

    expect(getPersonMetrics(store, "zhangsan", { keys: [] }).rows).toHaveLength(3);
  });

  it("无指标行时返回空数组（不抛错）", () => {
    const result = getPersonMetrics(fakeStore({ metrics: rows }), "wangwu");

    expect(result.person_id).toBe("wangwu");
    expect(result.rows).toEqual([]);
  });
});

// ── getRanking ──────────────────────────────────────────────────────────────

describe("getRanking（DESIGN-12 §8.5-R3）", () => {
  const persons = [
    person({ person_id: "me", subject_kind: "self", display_name: "我" }),
    person({ person_id: "zhangsan", display_name: "张三" }),
    person({ person_id: "lisi", display_name: "李四" }),
  ];
  const valueRows = [
    metric({ person_id: "me", metric_key: "value_score", metric_value: 0.8, metric_unit: "score" }),
    metric({ person_id: "me", metric_key: "value_rank", metric_value: 1, metric_unit: "rank" }),
    metric({ person_id: "zhangsan", metric_key: "value_score", metric_value: 0.5, metric_unit: "score" }),
    metric({ person_id: "zhangsan", metric_key: "value_rank", metric_value: 2, metric_unit: "rank" }),
    metric({ person_id: "lisi", metric_key: "value_score", metric_value: 0.2, metric_unit: "score" }),
    metric({ person_id: "lisi", metric_key: "value_rank", metric_value: 3, metric_unit: "rank" }),
  ];

  it("按 value_rank 升序返回并 join 显示名", () => {
    const result = getRanking(fakeStore({ metrics: valueRows, persons }));

    expect(result.rows.map((r) => r.person_id)).toEqual(["me", "zhangsan", "lisi"]);
    expect(result.rows.map((r) => r.display_name)).toEqual(["我", "张三", "李四"]);
    expect(result.rows[0]!.value_score).toBe(0.8);
    expect(result.rows[0]!.value_rank).toBe(1);
  });

  it("top 截断（默认 50；显式 top 生效）", () => {
    const store = fakeStore({ metrics: valueRows, persons });

    expect(getRanking(store, { top: 2 }).rows).toHaveLength(2);
    expect(getRanking(store).rows).toHaveLength(3);
  });

  it("top 超上限 200 时截断到 200 并给 warning", () => {
    const store = fakeStore({ metrics: valueRows, persons });

    const result = getRanking(store, { top: 999 });

    expect(result.warnings).toContain("RANKING_TOP_TRUNCATED");
    expect(result.top).toBe(RANKING_TOP_MAX);
  });

  it("并列时按 person_id 字典序保证确定性", () => {
    const tied = [
      metric({ person_id: "zhangsan", metric_key: "value_score", metric_value: 0.5, metric_unit: "score" }),
      metric({ person_id: "zhangsan", metric_key: "value_rank", metric_value: 1, metric_unit: "rank" }),
      metric({ person_id: "lisi", metric_key: "value_score", metric_value: 0.5, metric_unit: "score" }),
      metric({ person_id: "lisi", metric_key: "value_rank", metric_value: 1, metric_unit: "rank" }),
    ];
    const store = fakeStore({ metrics: tied, persons });

    const first = getRanking(store).rows.map((r) => r.person_id);
    const second = getRanking(store).rows.map((r) => r.person_id);

    expect(first).toEqual(["lisi", "zhangsan"]);
    expect(second).toEqual(first);
  });

  it("缺 value_score 或 value_rank 的行不进榜并给 warning", () => {
    const incomplete = [
      ...valueRows,
      metric({ person_id: "wangwu", metric_key: "value_score", metric_value: 0.1, metric_unit: "score" }),
    ];
    const store = fakeStore({ metrics: incomplete, persons });

    const result = getRanking(store);

    expect(result.rows.map((r) => r.person_id)).toEqual(["me", "zhangsan", "lisi"]);
    expect(result.warnings).toContain("RANKING_INCOMPLETE_ROWS");
  });

  it("from / to 尚未定义口径 → 给 warning（不猜语义）", () => {
    const store = fakeStore({ metrics: valueRows, persons });

    const result = getRanking(store, { from: "2026-06-01", to: "2026-09-01" });

    expect(result.warnings).toContain("RANKING_TIME_RANGE_UNSUPPORTED");
    expect(result.rows).toHaveLength(3); // 不影响返回集
  });

  it("无价值行时返回空榜", () => {
    const result = getRanking(fakeStore({ persons }));

    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("top=0 返回空榜（生效 top 为 0）", () => {
    const result = getRanking(fakeStore({ metrics: valueRows, persons }), { top: 0 });

    expect(result.rows).toEqual([]);
    expect(result.top).toBe(0);
  });
});
