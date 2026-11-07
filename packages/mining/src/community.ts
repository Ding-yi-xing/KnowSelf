/**
 * `CommunityDetector`（DESIGN-12 §4.4）：Louvain 社区发现 + `community_key` 稳定标识。
 * 子图：人物 + 群节点与它们之间的边（**话题节点不参与**——度数极高会把社区搅成一片）。
 * 输入权重：`co_norm`（§4.2.1 ① 结构等价性）；同对多类边取最大权重（确定性择大）。
 * 确定性（§13-Q2 已实测）：库支持注入 `rng` → 固定种子 + 固定节点输入序 → 同输入同输出。
 * 不变量：孤立节点 `community_key=null`（§8.2）；`community_key = 'c:' + sha1(成员 person_id 升序)`。
 */
import { createHash } from "node:crypto";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { GraphCommunity, GraphEdge, GraphNode } from "@knowself/contracts";

/** 参与社区发现的边类型（§4.4：人物+群之间的边；话题边不入）。 */
const LOUVAIN_INPUT_KINDS: ReadonlySet<GraphEdge["kind"]> = new Set([
  "co_presence",
  "membership",
  "my_group",
]);

/** §4.4：分辨率默认 1.0（可调，存快照 `params_json`）。 */
const DEFAULT_RESOLUTION = 1;
/** §13-Q2 实测结论：注入固定种子随机源，保证可重建（附录 B #6）。 */
const DEFAULT_SEED = 0x5eed;

export interface CommunityDetectionInput {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly resolution?: number;
  readonly seed?: number;
}

export interface CommunityDetectionResult {
  /** 回填 `community_key` 的节点（孤立 / 话题节点为 null）。 */
  readonly nodes: GraphNode[];
  readonly communities: GraphCommunity[];
  /** Louvain 模块度（∈ [-0.5, 1]）；无社区时为 0。 */
  readonly modularity: number;
}

function byKeyAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** 确定性伪随机源（mulberry32）：同种子 → 同序列。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 稳定社区标识：即使算法重跑后编号变化，同一批人仍是同一 key（§4.4）。 */
function communityKey(personIds: readonly string[]): string {
  return `c:${createHash("sha1").update([...personIds].sort(byKeyAsc).join(",")).digest("hex")}`;
}

export function detectCommunities(input: CommunityDetectionInput): CommunityDetectionResult {
  const resolution = input.resolution ?? DEFAULT_RESOLUTION;
  const seed = input.seed ?? DEFAULT_SEED;

  const subgraphNodes = input.nodes
    .filter((n) => n.kind === "person" || n.kind === "group")
    .slice()
    .sort((a, b) => byKeyAsc(a.id, b.id));
  const subgraphIds = new Set(subgraphNodes.map((n) => n.id));

  const bestByPair = new Map<string, { a: string; b: string; w: number }>();
  for (const edge of input.edges) {
    if (!LOUVAIN_INPUT_KINDS.has(edge.kind)) continue;
    if (!subgraphIds.has(edge.source) || !subgraphIds.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    const w = edge.attrs.co_norm ?? edge.strength;
    if (!(w > 0)) continue;
    const [a, b] = sortedPair(edge.source, edge.target);
    const key = `${a}|${b}`;
    const existing = bestByPair.get(key);
    if (existing === undefined || w > existing.w) bestByPair.set(key, { a, b, w });
  }
  const louvainEdges = [...bestByPair.entries()]
    .sort(([x], [y]) => byKeyAsc(x, y))
    .map(([, value]) => value);

  if (subgraphNodes.length === 0 || louvainEdges.length === 0) {
    return {
      nodes: input.nodes.map((n) => ({ ...n, community_key: null })),
      communities: [],
      modularity: 0,
    };
  }

  const graph = new Graph({ type: "undirected", allowSelfLoops: false });
  for (const node of subgraphNodes) graph.addNode(node.id);
  for (const edge of louvainEdges) graph.addEdge(edge.a, edge.b, { weight: edge.w });

  const detailed = louvain.detailed(graph, {
    resolution,
    rng: mulberry32(seed),
    getEdgeWeight: "weight",
  });
  const mapping = detailed.communities;

  const membersByCommunity = new Map<number, { persons: GraphNode[]; groups: GraphNode[] }>();
  for (const node of subgraphNodes) {
    if (node.isolated) continue; // 孤立节点不成社区（§8.2：community_key = null）
    const communityNo = mapping[node.id];
    if (communityNo === undefined) continue;
    const bucket = membersByCommunity.get(communityNo) ?? { persons: [], groups: [] };
    if (node.kind === "person") bucket.persons.push(node);
    else bucket.groups.push(node);
    membersByCommunity.set(communityNo, bucket);
  }

  const assignment = new Map<string, string>();
  const communities: GraphCommunity[] = [];
  for (const [, bucket] of [...membersByCommunity.entries()].sort((a, b) => a[0] - b[0])) {
    const personIds = bucket.persons.map((p) => p.id).sort(byKeyAsc);
    if (personIds.length === 0) continue; // 纯群社区无人物成员 → 不产出（schema `size ≥ 1`）
    const groupIds = bucket.groups.map((g) => g.id).sort(byKeyAsc);
    const key = communityKey(personIds);
    const nodeIds = new Set<string>([...personIds, ...groupIds]);
    let weightSum = 0;
    for (const edge of louvainEdges) {
      if (nodeIds.has(edge.a) && nodeIds.has(edge.b)) weightSum += edge.w;
    }
    const size = nodeIds.size;
    const possible = size > 1 ? (size * (size - 1)) / 2 : 0;
    const top = [...bucket.persons].sort(
      (a, b) => b.size_raw - a.size_raw || byKeyAsc(a.id, b.id),
    )[0];
    const label =
      top === undefined
        ? key
        : personIds.length > 1
          ? `${top.label} 等 ${personIds.length} 人`
          : top.label;
    communities.push({
      community_key: key,
      label,
      size: personIds.length,
      member_ids: personIds,
      group_ids: groupIds,
      cohesion: possible === 0 ? 0 : Math.min(1, weightSum / possible),
    });
    for (const id of nodeIds) assignment.set(id, key);
  }
  communities.sort((a, b) => byKeyAsc(a.community_key, b.community_key));

  const nodes = input.nodes.map((node) => {
    if (node.kind === "topic" || node.isolated) return { ...node, community_key: null };
    return { ...node, community_key: assignment.get(node.id) ?? null };
  });

  return { nodes, communities, modularity: detailed.modularity };
}

/** `CommunityDetector` 别名（DESIGN-12 §12 P1-5 命名）。 */
export const CommunityDetector = { detect: detectCommunities };
