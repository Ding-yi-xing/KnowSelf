/**
 * read.ts — mining 只读 API 层（DESIGN-12 §8.5 的四个函数之三）
 *
 * 职责：把 `person_metrics` / `mining_graph_snapshots` 的存量行翻译成 M11（图谱视图）
 * 与人物详情页可直接消费的 DTO。
 *
 * **只读 + 幂等**（§8.5 逐字要求）：本模块不写库、不写文件、不自行构造数据库句柄
 * （不变量 #2 —— store 一律由调用方注入）。
 *
 * ── 过滤口径（§8.1 第 723 行「口径定稿（2026-09-09 B-3 + C7 裁定）」）──
 * - `relation_types[]`：按 **person 节点**的 `relation_type` 过滤（诱导子图）
 * - `edge_kinds[]`：按**边的 `kind`** 过滤（该维度在 §8.5 参数表**未列**，文中标注为加法式；
 *   两表不一致已登记 `docs/units/mining/status.md`）
 * - `min_interaction`：按节点 `size_raw` 阈值（person / group / topic 统一）
 * - `min_strength`：按边 `strength` 阈值；`communities[]`：按节点 `community_key`
 * - 各维度可叠加（全部满足才保留）
 *
 * ── 诱导子图的重算范围（本模块裁定，已登记 status.md 待架构复核）──
 * - **重算**：`degree` / `isolated`（§8.2 把 `isolated` 定义为「无可见边」，原样透传会自相矛盾）、
 *   `stats.node_count` / `edge_count` / `community_count`、
 *   社区 `member_ids` / `group_ids` / `size`（否则 M11 会渲染出「社区 3 人、图上 1 人」）
 * - **保留**：`size` / `strength`（全局归一化值，重算会破坏跨视图可比性）、
 *   `stats.modularity` / `degraded_sessions`、社区 `label` / `cohesion`（构建期诊断量）
 * - **无任何过滤参数时原样返回**（不做重算，保证与落库快照逐字节一致）
 *
 * 边界：`payload_json` 用 `GraphSnapshotSchema.parse` 解析（与 `pipeline.ts` 同做法），
 * 库中载荷非法时直接抛错——不静默降级（不变量 #6 确定性 / #7 不猜）。
 */
import { GraphSnapshotSchema, type GraphEdgeKind, type GraphSnapshot, type ScopeKind } from "@knowself/contracts";
import type { GraphSnapshotRow, MetricRow, PersonRow } from "@knowself/person-store";

// ── 常量 ────────────────────────────────────────────────────────────────────

/** §4.6 的两种 `graph_kind` 中，只有 `cooccurrence` 产出 §8.2~§8.4 的节点 / 边 / 社区。 */
export const DEFAULT_GRAPH_KIND = "cooccurrence" as const;
/** §8.5 R3：`top` 上限。 */
export const RANKING_TOP_MAX = 200;
/** §8.5 R3：`top` 默认值（未传时）。 */
export const RANKING_TOP_DEFAULT = 50;
/** §6.4 的价值三键；R3 只消费前两键（`value_score_breakdown` 是解释行，不进榜）。 */
export const VALUE_SCORE_KEY = "value_score";
export const VALUE_RANK_KEY = "value_rank";
/** R3 的榜单范围：§10.1 的 `idx_metrics_scope` + `metric_key='value_rank'` 即 global 榜。 */
export const RANKING_SCOPE_KIND: ScopeKind = "global";
export const RANKING_SCOPE_ID = "";

export const WARN_RANKING_TOP_TRUNCATED = "RANKING_TOP_TRUNCATED";
export const WARN_RANKING_INCOMPLETE_ROWS = "RANKING_INCOMPLETE_ROWS";
export const WARN_RANKING_TIME_RANGE_UNSUPPORTED = "RANKING_TIME_RANGE_UNSUPPORTED";

// ── store 注入面（只读） ─────────────────────────────────────────────────────

/**
 * 读层需要的 person-store 能力面（DESIGN-13 §3.8 `MetricsRepo` 的只读子集）。
 * 真实门面 `PersonStoreMiningApi` 结构兼容；测试用内存 fake 实现。
 */
export interface MiningReadStore {
  listPersons(q?: { status?: PersonRow["status"] }): PersonRow[];
  metrics: {
    list(q: {
      person_id?: string;
      scope_kind?: ScopeKind;
      scope_id?: string;
      period?: MetricRow["period"];
      period_key?: string;
      metric_keys?: readonly string[];
    }): MetricRow[];
    listGraphSnapshots(q?: {
      graph_kind?: GraphSnapshotRow["graph_kind"];
      scope_kind?: ScopeKind;
      scope_id?: string;
      limit?: number;
    }): GraphSnapshotRow[];
  };
}

// ── getGraphSnapshot（§8.5-A1 / §8.1） ──────────────────────────────────────

export interface GetGraphSnapshotQuery {
  readonly scope_kind?: ScopeKind;
  readonly scope_id?: string;
  /** 显式选择历史快照（快照 id 是主键，命中优先于 scope 与「最新」约定）。 */
  readonly snapshot_id?: string;
  readonly min_strength?: number;
  readonly communities?: readonly string[];
  readonly relation_types?: readonly string[];
  readonly edge_kinds?: readonly GraphEdgeKind[];
  readonly min_interaction?: number;
}

export interface GraphSnapshotResult {
  readonly snapshot: GraphSnapshot;
  readonly warnings: readonly string[];
}

/**
 * 取图谱快照（§8.5-A1）。返回 `null` 表示「该 scope 下无快照」——路由据此映射 404。
 */
export function getGraphSnapshot(
  store: MiningReadStore,
  q: GetGraphSnapshotQuery = {},
): GraphSnapshotResult | null {
  const row = selectSnapshotRow(store, q);
  if (row === null) {
    return null;
  }
  const snapshot = GraphSnapshotSchema.parse(JSON.parse(row.payload_json));
  return { snapshot: applyGraphFilters(snapshot, q), warnings: [] };
}

/** §4.6「最新快照」约定：`ORDER BY computed_at DESC LIMIT 1`（TEXT 排序，与 DDL 同语义）。 */
function selectSnapshotRow(store: MiningReadStore, q: GetGraphSnapshotQuery): GraphSnapshotRow | null {
  if (q.snapshot_id !== undefined) {
    const all = store.metrics.listGraphSnapshots({ graph_kind: DEFAULT_GRAPH_KIND });
    return all.find((row) => row.snapshot_id === q.snapshot_id) ?? null;
  }
  const candidates = store.metrics.listGraphSnapshots({
    graph_kind: DEFAULT_GRAPH_KIND,
    scope_kind: q.scope_kind ?? "global",
    scope_id: q.scope_id ?? "",
  });
  let latest: GraphSnapshotRow | null = null;
  for (const row of candidates) {
    if (latest === null || row.computed_at > latest.computed_at) {
      latest = row;
    }
  }
  return latest;
}

function applyGraphFilters(snapshot: GraphSnapshot, q: GetGraphSnapshotQuery): GraphSnapshot {
  const hasNodeFilter =
    q.relation_types !== undefined || q.communities !== undefined || q.min_interaction !== undefined;
  const hasEdgeFilter = q.min_strength !== undefined || q.edge_kinds !== undefined;
  if (!hasNodeFilter && !hasEdgeFilter) {
    return snapshot;
  }

  const relationTypes = q.relation_types === undefined ? null : new Set(q.relation_types);
  const communityKeys = q.communities === undefined ? null : new Set(q.communities);
  const edgeKinds = q.edge_kinds === undefined ? null : new Set<string>(q.edge_kinds);
  const minInteraction = q.min_interaction ?? null;
  const minStrength = q.min_strength ?? null;

  const keptNodes = snapshot.nodes.filter((node) => {
    if (relationTypes !== null) {
      // §8.1 第 723 行：按 person 节点的 relation_type；非 person 节点不满足该谓词 → 剔除
      if (node.kind !== "person" || node.relation_type === null || !relationTypes.has(node.relation_type)) {
        return false;
      }
    }
    if (minInteraction !== null && node.size_raw < minInteraction) {
      return false;
    }
    if (communityKeys !== null) {
      if (node.community_key === null || !communityKeys.has(node.community_key)) {
        return false;
      }
    }
    return true;
  });
  const keptIds = new Set(keptNodes.map((node) => node.id));

  const keptEdges = snapshot.edges.filter((edge) => {
    if (minStrength !== null && edge.strength < minStrength) {
      return false;
    }
    if (edgeKinds !== null && !edgeKinds.has(edge.kind)) {
      return false;
    }
    return keptIds.has(edge.source) && keptIds.has(edge.target);
  });

  const degrees = new Map<string, number>();
  for (const edge of keptEdges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  const nodes = keptNodes.map((node) => {
    const degree = degrees.get(node.id) ?? 0;
    return { ...node, degree, isolated: degree === 0 };
  });

  const communities = snapshot.communities
    .map((item) => ({
      ...item,
      member_ids: item.member_ids.filter((id) => keptIds.has(id)),
      group_ids: item.group_ids.filter((id) => keptIds.has(id)),
    }))
    .filter((item) => item.member_ids.length + item.group_ids.length > 0)
    // size = 保留集内的 person + group 节点数（topic 节点不在 §8.4 的成员数组里，
    // 故含 topic 的社区其 size 为近似值——话题抽取是 P2，见 §13-Q4）
    .map((item) => ({ ...item, size: item.member_ids.length + item.group_ids.length }));

  return {
    ...snapshot,
    nodes,
    edges: keptEdges,
    communities,
    stats: {
      ...snapshot.stats,
      node_count: nodes.length,
      edge_count: keptEdges.length,
      community_count: communities.length,
    },
  };
}

// ── getPersonMetrics（§8.5-R2） ─────────────────────────────────────────────

export interface GetPersonMetricsQuery {
  readonly period?: MetricRow["period"];
  readonly period_key?: string;
  /** 指标键白名单；不传或空数组 = 不筛选。 */
  readonly keys?: readonly string[];
}

export interface PersonMetricsResult {
  readonly person_id: string;
  readonly rows: readonly MetricRow[];
}

/**
 * 取某人的指标行（§8.5-R2）。
 * 不传 `period` 时**不按周期筛选**（返回该人全部周期行）；无行时返回空数组而非抛错。
 */
export function getPersonMetrics(
  store: MiningReadStore,
  personId: string,
  q: GetPersonMetricsQuery = {},
): PersonMetricsResult {
  const rows = store.metrics.list({
    person_id: personId,
    ...(q.period === undefined ? {} : { period: q.period }),
    ...(q.period_key === undefined ? {} : { period_key: q.period_key }),
    ...(q.keys === undefined || q.keys.length === 0 ? {} : { metric_keys: q.keys }),
  });
  return { person_id: personId, rows };
}

// ── getRanking（§8.5-R3） ───────────────────────────────────────────────────

export interface GetRankingQuery {
  /** 榜单长度；默认 {@link RANKING_TOP_DEFAULT}，上限 {@link RANKING_TOP_MAX}。 */
  readonly top?: number;
  /** §8.5 登记了参数名但**未定义口径** → 仅告警，不参与筛选（不猜，见 status.md）。 */
  readonly from?: string;
  readonly to?: string;
}

export interface RankingEntry {
  readonly person_id: string;
  readonly display_name: string;
  readonly value_score: number | null;
  readonly value_rank: number | null;
  readonly scope_kind: ScopeKind;
  readonly scope_id: string;
  readonly period: MetricRow["period"];
  readonly period_key: string;
}

export interface RankingResult {
  readonly rows: readonly RankingEntry[];
  /** 生效的 top（截断后的值）。 */
  readonly top: number;
  readonly warnings: readonly string[];
}

/**
 * 价值榜单（§8.5-R3）：按 `value_rank` 升序，并列按 `person_id` 字典序（确定性）。
 * 只有同时具备 `value_score` 与 `value_rank` 行的人才进榜；残缺者跳过并告警。
 */
export function getRanking(store: MiningReadStore, q: GetRankingQuery = {}): RankingResult {
  const warnings: string[] = [];
  if (q.from !== undefined || q.to !== undefined) {
    warnings.push(WARN_RANKING_TIME_RANGE_UNSUPPORTED);
  }
  const requested = q.top ?? RANKING_TOP_DEFAULT;
  if (requested > RANKING_TOP_MAX) {
    warnings.push(WARN_RANKING_TOP_TRUNCATED);
  }
  const top = Math.max(0, Math.min(requested, RANKING_TOP_MAX));

  const rows = store.metrics.list({
    scope_kind: RANKING_SCOPE_KIND,
    scope_id: RANKING_SCOPE_ID,
    metric_keys: [VALUE_SCORE_KEY, VALUE_RANK_KEY],
  });

  const byPerson = new Map<string, { score?: MetricRow; rank?: MetricRow }>();
  for (const row of rows) {
    const entry = byPerson.get(row.person_id) ?? {};
    if (row.metric_key === VALUE_SCORE_KEY) {
      entry.score = row;
    } else if (row.metric_key === VALUE_RANK_KEY) {
      entry.rank = row;
    }
    byPerson.set(row.person_id, entry);
  }

  const displayNames = new Map(store.listPersons().map((person) => [person.person_id, person.display_name]));
  const entries: RankingEntry[] = [];
  let incomplete = 0;
  for (const [personId, entry] of byPerson) {
    if (entry.score === undefined || entry.rank === undefined) {
      incomplete += 1;
      continue;
    }
    entries.push({
      person_id: personId,
      display_name: displayNames.get(personId) ?? personId,
      value_score: entry.score.metric_value,
      value_rank: entry.rank.metric_value,
      scope_kind: entry.rank.scope_kind,
      scope_id: entry.rank.scope_id,
      period: entry.rank.period,
      period_key: entry.rank.period_key,
    });
  }
  if (incomplete > 0) {
    warnings.push(WARN_RANKING_INCOMPLETE_ROWS);
  }

  entries.sort(
    (a, b) =>
      (a.value_rank ?? Number.MAX_SAFE_INTEGER) - (b.value_rank ?? Number.MAX_SAFE_INTEGER) ||
      (a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0),
  );

  return { rows: entries.slice(0, top), top, warnings };
}
