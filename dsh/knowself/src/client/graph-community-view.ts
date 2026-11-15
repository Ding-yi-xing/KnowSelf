/**
 * 图谱**社区聚合视图**（P3 方案 B）：把 1,206 个节点折叠成 ~83 个社区超节点。
 *
 * ## 为什么必须做这一层
 * 实测（真实快照 1,206 节点 / 10,000 边）：
 *   - 现状 `MAX_RENDER_NODES=200` → 只画 200 点，**丢 1,006 个节点**，布局 54ms；
 *   - 提上限到 1,206 → 布局 **1,935ms**（O(n²) 斥力迭代），而且画布上是一团糊；
 *   - 社区聚合 → 83 点 / 113 边，**布局 16ms**，而且结构一眼看得出来。
 * 所以默认视图给社区，点进去再看成员。
 *
 * ## 两条纪律
 * 1. **不改快照**：只用节点已有的 `community_key` 字段，不向后端要新东西；
 * 2. **纯函数**：不碰 DOM / 不读全局，便于直接用真实快照离线验证（渲染层只拿结果）。
 */
import type { GraphPanelEdge, GraphPanelNode } from "./graph-port.js";

/** 没有 `community_key` 的节点归到这个桶（不单独成一个点，避免出现"未分组社区"这种伪结构）。 */
export const UNGROUPED_KEY = "__ungrouped";

/** 超节点 id 前缀（与人物/群/话题的 id 区分开）。 */
export const COMMUNITY_NODE_PREFIX = "community:";

/**
 * 取节点的社区键。
 * @param node 画布节点
 * @returns 社区键；缺省归入 {@link UNGROUPED_KEY}
 */
export function communityKeyOf(node: GraphPanelNode): string {
  return node.community_key ?? UNGROUPED_KEY;
}

/**
 * 该不该用社区聚合视图。
 *
 * **降级条件**（任一成立就退回原来的渲染，避免"点进去是空的"）：
 *   - 没有快照 / 没有节点；
 *   - 所有节点都没有 `community_key`（后端没算社区）；
 *   - 有效社区数 ≤ 1（只有一个社区时聚合等于不聚合，反而看不到细节）。
 *
 * @param nodes 全部节点
 * @returns 是否可用
 */
export function canUseCommunityView(nodes: readonly GraphPanelNode[]): boolean {
  if (nodes.length === 0) return false;
  const keys = new Set<string>();
  for (const node of nodes) {
    if (node.community_key === null || node.community_key === undefined) continue;
    keys.add(node.community_key);
  }
  return keys.size > 1;
}

/** 社区视图的产物。 */
export interface CommunityView {
  nodes: GraphPanelNode[];
  edges: GraphPanelEdge[];
  /** 社区键 → 成员数（面包屑与超节点尺寸都用它）。 */
  member_count: ReadonlyMap<string, number>;
}

/** 超节点展示名（`c:fe21ab…` → `社区 fe21ab`）。 */
export function communityLabel(key: string): string {
  if (key === UNGROUPED_KEY) return "未分组";
  return `社区 ${key.replace(/^c:/, "").slice(0, 6)}`;
}

/**
 * 折叠成社区超节点视图。
 *
 * - 超节点尺寸 ∝ 成员数（`[0.15, 1]`，最小值保证最小的社区也看得见）；
 * - 边：**社区之间**的原始边按 `strength` 求和聚合（社区内边不外显，下钻才看）；
 * - 自环（同一社区）不计，否则每个社区都会挂一个自我环。
 *
 * @param payload.nodes 全部节点
 * @param payload.edges 全部边
 * @returns 聚合结果；`canUseCommunityView` 为 false 时应由调用方忽略
 */
export function buildCommunityView(input: {
  nodes: readonly GraphPanelNode[];
  edges: readonly GraphPanelEdge[];
}): CommunityView {
  const counts = new Map<string, number>();
  const nodeKey = new Map<string, string>();
  for (const node of input.nodes) {
    const key = communityKeyOf(node);
    nodeKey.set(node.id, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(1, ...counts.values());

  const nodes: GraphPanelNode[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => ({
      id: `${COMMUNITY_NODE_PREFIX}${key}`,
      label: communityLabel(key),
      kind: "community",
      // 半径 ∝ 成员数：0.15 起步，最大 1
      size: 0.15 + 0.85 * (count / maxCount),
      degree: 0,
      isolated: false,
      // 超节点是"一群关系"，没有单一关系类型
      relation_type: null,
      community_key: key === UNGROUPED_KEY ? null : key,
    }));

  const weights = new Map<string, { source: string; target: string; strength: number }>();
  for (const edge of input.edges) {
    const a = nodeKey.get(edge.source);
    const b = nodeKey.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const [from, to] = a < b ? [a, b] : [b, a];
    const id = `${from}\u0000${to}`;
    const hit = weights.get(id);
    const strength = typeof edge.strength === "number" ? edge.strength : 0;
    if (hit === undefined) weights.set(id, { source: from, target: to, strength });
    else hit.strength += strength;
  }

  const degreeOf = new Map<string, number>();
  const edges: GraphPanelEdge[] = [...weights.entries()].map(([id, w]) => {
    degreeOf.set(w.source, (degreeOf.get(w.source) ?? 0) + 1);
    degreeOf.set(w.target, (degreeOf.get(w.target) ?? 0) + 1);
    return {
      id: `community-edge:${id}`,
      source: `${COMMUNITY_NODE_PREFIX}${w.source}`,
      target: `${COMMUNITY_NODE_PREFIX}${w.target}`,
      kind: "co_presence",
      strength: w.strength,
      directed: false,
    };
  });

  return {
    nodes: nodes.map((node) => ({
      ...node,
      degree: degreeOf.get(node.id.slice(COMMUNITY_NODE_PREFIX.length)) ?? 0,
      isolated: (degreeOf.get(node.id.slice(COMMUNITY_NODE_PREFIX.length)) ?? 0) === 0,
    })),
    edges,
    member_count: counts,
  };
}

/**
 * 下钻：取某个社区的成员与**社区内部边**。
 *
 * @param input 全部节点 / 边
 * @param key 目标社区键
 * @returns 该社区的子图（可能为空，调用方需兜底）
 */
export function buildCommunityDetail(
  input: { nodes: readonly GraphPanelNode[]; edges: readonly GraphPanelEdge[] },
  key: string,
): { nodes: GraphPanelNode[]; edges: GraphPanelEdge[] } {
  const members = input.nodes.filter((node) => communityKeyOf(node) === key);
  const ids = new Set(members.map((node) => node.id));
  return {
    nodes: members,
    edges: input.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}
