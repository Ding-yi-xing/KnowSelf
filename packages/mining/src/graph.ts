/**
 * 图谱快照组装与落库（DESIGN-12 §4.5 / §4.6 / §8）。
 * 组装 = CoOccurrenceBuilder → CommunityDetector → §4.5 信封 → contracts `GraphSnapshotSchema.parse`（T7）。
 * 落库 = 经 person-store `MetricsRepo`（**不直连库**，附录 B #2），写后按 `GRAPH_SNAPSHOT_KEEP` 裁剪。
 */
import { GraphSnapshotSchema, type GraphSnapshot, type ScopeKind } from "@knowself/contracts";
import type { GraphKind, GraphSnapshotInsert } from "@knowself/person-store";
import {
  GRAPH_PRODUCED_BY,
  GRAPH_SNAPSHOT_KEEP,
  MAX_PAIRWISE_MEMBERS,
  MIN_EDGE_STRENGTH,
  SESSION_GAP_MS,
} from "./constants";
import { buildCoOccurrence, type CoOccurrenceInput } from "./co-occurrence";
import { detectCommunities } from "./community";

/** §4.5 信封版本位（与 `GRAPH_PRODUCED_BY` 分开：前者是契约版本，后者是生产版本）。 */
const GRAPH_VERSION = "mining-graph-v1";
/** §4.4 分辨率默认 1.0。 */
const DEFAULT_RESOLUTION = 1;

export interface BuildGraphSnapshotInput extends CoOccurrenceInput {
  readonly resolution?: number;
  readonly seed?: number;
  readonly timeFrom?: string | null;
  readonly timeTo?: string | null;
  /** 生成时刻（ISO8601 带偏移）；缺省取当前时刻。 */
  readonly now?: string;
}

export interface BuiltGraphSnapshot {
  readonly snapshot: GraphSnapshot;
  /** 审计告警（降级 / 裁剪）；不进 payload（§4.5 与 §8.2 的冲突按契约取 §8.2）。 */
  readonly warnings: string[];
}

export function buildGraphSnapshot(input: BuildGraphSnapshotInput): BuiltGraphSnapshot {
  const co = buildCoOccurrence(input);
  const detected = detectCommunities({
    nodes: co.nodes,
    edges: co.edges,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  });

  const snapshot: GraphSnapshot = {
    graph_version: GRAPH_VERSION,
    produced_by: GRAPH_PRODUCED_BY,
    generated_at: input.now ?? new Date().toISOString(),
    params: {
      algo: "louvain",
      resolution: input.resolution ?? DEFAULT_RESOLUTION,
      gap_ms: SESSION_GAP_MS,
      min_edge_strength: input.minEdgeStrength ?? MIN_EDGE_STRENGTH,
      max_pairwise_members: input.maxPairwiseMembers ?? MAX_PAIRWISE_MEMBERS,
      time_from: input.timeFrom ?? null,
      time_to: input.timeTo ?? null,
    },
    stats: {
      node_count: detected.nodes.length,
      edge_count: co.edges.length,
      community_count: detected.communities.length,
      modularity: detected.modularity,
      degraded_sessions: co.degradedSessions,
      // 只有真的裁剪过才写（未裁剪时留空，避免"永远等于 edge_count"的噪音）
      ...(co.edgeCandidates > co.edges.length ? { edge_candidates: co.edgeCandidates } : {}),
    },
    nodes: detected.nodes,
    edges: co.edges,
    communities: detected.communities,
  };

  // T7：出参必须通过契约校验（`attrs` 为 strict，禁止临时键）
  return { snapshot: GraphSnapshotSchema.parse(snapshot), warnings: co.warnings };
}

/** 落库所需的最小仓库面（person-store `MetricsRepo` 的结构子集，便于测试注入）。 */
export interface GraphSnapshotPruneQuery {
  readonly graph_kind: GraphKind;
  readonly scope_kind: ScopeKind;
  readonly scope_id: string;
  readonly keep: number;
}

export interface GraphSnapshotRepo {
  insertGraphSnapshot(row: GraphSnapshotInsert): { snapshot_id: string };
  pruneGraphSnapshots(q: GraphSnapshotPruneQuery): { deleted: number };
}

export interface PersistGraphSnapshotOptions {
  readonly graphKind?: GraphKind;
  readonly scopeKind?: ScopeKind;
  readonly scopeId?: string;
}

export function persistGraphSnapshot(
  repo: GraphSnapshotRepo,
  snapshot: GraphSnapshot,
  options: PersistGraphSnapshotOptions = {},
): { snapshot_id: string; pruned: number } {
  const graphKind = options.graphKind ?? "cooccurrence";
  const scopeKind = options.scopeKind ?? "global";
  const scopeId = options.scopeId ?? "";

  const { snapshot_id } = repo.insertGraphSnapshot({
    graph_kind: graphKind,
    scope_kind: scopeKind,
    scope_id: scopeId,
    time_from: snapshot.params.time_from,
    time_to: snapshot.params.time_to,
    params_json: JSON.stringify(snapshot.params),
    payload_json: JSON.stringify(snapshot),
    node_count: snapshot.nodes.length,
    edge_count: snapshot.edges.length,
    community_count: snapshot.communities.length,
    produced_by: GRAPH_PRODUCED_BY,
    computed_at: snapshot.generated_at,
  });

  // §4.6 保留策略：每 (graph_kind, scope_kind, scope_id) 保留最近 GRAPH_SNAPSHOT_KEEP 份
  const { deleted } = repo.pruneGraphSnapshots({
    graph_kind: graphKind,
    scope_kind: scopeKind,
    scope_id: scopeId,
    keep: GRAPH_SNAPSHOT_KEEP,
  });

  return { snapshot_id, pruned: deleted };
}

/** 最小门面别名（§12 P1-5）。 */
export const GraphSnapshotBuilder = { build: buildGraphSnapshot, persist: persistGraphSnapshot };
