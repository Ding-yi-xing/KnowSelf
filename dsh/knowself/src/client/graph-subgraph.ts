/**
 * 图谱**子图抽取**（纯函数，零依赖，可在 node 里直接单测）。
 *
 * 两块能力都围绕「把全量快照裁剪成一个更小的可画子集」：
 *   1. {@link applyGraphFilters}：设置面板「过滤」组（搜索 / 孤儿 / 已建档）；
 *   2. {@link buildLocalGraph}：局部图谱（Obsidian Local Graph）——选中某节点后
 *      只显示其 N 层邻居。
 *
 * ## 为什么纯函数
 * 过滤与 N 层邻居都是「节点 / 边集合 → 节点 / 边集合」的确定性计算，不碰 DOM / React，
 * 用真实快照离线就能验证（尤其是 1,206 节点的深度 5 会不会爆炸）。
 */
import type { GraphEdgeKind } from "@knowself/contracts";
import type { GraphPanelEdge, GraphPanelNode } from "./graph-port.js";
import type { GraphSettings } from "./graph-settings.js";
import { buildCommunityDetail, buildCommunityView } from "./graph-community-view.js";

/** 子图结果。 */
export interface GraphSubset {
  nodes: GraphPanelNode[];
  edges: GraphPanelEdge[];
}

/**
 * 图谱主视图模式（四选一，替换旧的边类型复选框 + 「仅看我的直接关系」）。
 *   - `group`：社区聚合视图（「群」= 关系簇；无社区数据时降级为全量成员）；
 *   - `person`：人物 / 单聊节点（人与人之间的 co_presence / direct_reply）；
 *   - `neighbors`：在 `person` 基础上，只保留以「我」为中心 N 层邻居（深度取设置）。
 *   - `ability`：独立能力快照，不参与人物图谱的社区聚合。
 */
export type GraphMode = "group" | "person" | "neighbors" | "ability";

/**
 * 去掉**诱导度数为 0** 的节点（在给定边集里没有任何连边）。
 *
 * 为什么按「诱导度数」而不是后端 `degree`：模式过滤后，某节点可能原本有边、但边都连到
 * 被过滤掉的节点上，在当前画布里它就是孤点。用诱导度数能准确清掉「边缘散点噪声」。
 *
 * @param nodes 节点
 * @param edges 边（已过滤）
 * @returns 只保留有连边节点的子图
 */
export function dropIsolated(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
): GraphSubset {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const keep = nodes.filter((node) => (degree.get(node.id) ?? 0) > 0);
  const ids = new Set(keep.map((node) => node.id));
  return {
    nodes: keep,
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}

/**
 * 只保留**最大连通分量**（去掉游离的小簇）。用户要求「主图之外不应存在游离簇」。
 *
 * @param nodes 节点
 * @param edges 边
 * @returns 最大连通分量子图
 */
export function keepLargestComponent(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
): GraphSubset {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const seen = new Set<string>();
  let best: string[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const stack = [node.id];
    const component: string[] = [];
    seen.add(node.id);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      component.push(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  const keep = new Set(best);
  return {
    nodes: nodes.filter((node) => keep.has(node.id)),
    edges: edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}

/**
 * 按模式做**成员级**过滤。
 *
 *   - `group`（群）：只留 `kind==='group'` 节点；**群之间没有直接边**（数据里 0 条），
 *     因此用「共同成员」派生群-群边（两个群有同一个成员 → 连一条，权重=共同成员数），
 *     让「我加入的那些群 / 群圈子」连成一张真实的群网络；
 *   - `person`（人）：`kind==='person'` 或 `kind==='direct'`；
 *   - `neighbors`（仅与我）：在人基础上，以 `meId` 为中心做 N 层 BFS。
 *
 * @param nodes 成员节点
 * @param edges 成员边
 * @param mode 模式
 * @param depth `neighbors` 模式的层数（1~5）
 * @param meId 「我」的节点 id（默认 `"me"`）
 * @returns 子图
 */
export function filterByMode(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
  mode: GraphMode,
  depth: number,
  meId = "me",
): GraphSubset {
  if (mode === "group") {
    const groups = nodes.filter((node) => node.kind === "group");
    const groupIds = new Set(groups.map((node) => node.id));
    // 成员 → 所在群集合（membership / my_group 边的「人」端点归属该群）
    const personGroups = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (edge.kind !== "membership" && edge.kind !== "my_group") continue;
      const sourceIsGroup = groupIds.has(edge.source);
      const targetIsGroup = groupIds.has(edge.target);
      let group: string | null = null;
      let other: string | null = null;
      if (sourceIsGroup && !targetIsGroup) {
        group = edge.source;
        other = edge.target;
      } else if (targetIsGroup && !sourceIsGroup) {
        group = edge.target;
        other = edge.source;
      }
      if (group === null || other === null) continue;
      const set = personGroups.get(other) ?? new Set<string>();
      set.add(group);
      personGroups.set(other, set);
    }
    // 共同成员 → 群-群边（权重 = 共同成员数，便于布局把「同圈子」的群拉近）
    const pairWeight = new Map<string, { a: string; b: string; w: number }>();
    for (const groupSet of personGroups.values()) {
      const arr = [...groupSet];
      for (let i = 0; i < arr.length; i += 1) {
        for (let j = i + 1; j < arr.length; j += 1) {
          const a = arr[i]! < arr[j]! ? arr[i]! : arr[j]!;
          const b = arr[i]! < arr[j]! ? arr[j]! : arr[i]!;
          const id = `${a}\u0000${b}`;
          const hit = pairWeight.get(id);
          if (hit) hit.w += 1;
          else pairWeight.set(id, { a, b, w: 1 });
        }
      }
    }
    const derived: GraphPanelEdge[] = [...pairWeight.values()].map((entry) => ({
      id: `comember:${entry.a}|${entry.b}`,
      source: entry.a,
      target: entry.b,
      kind: "co_presence" as GraphEdgeKind,
      strength: Math.min(1, entry.w / 5),
      directed: false,
    }));
    // 群成员数（membership / my_group 边的「人」端点数）
    const groupMembers = new Map<string, number>();
    for (const groupSet of personGroups.values()) {
      for (const g of groupSet) groupMembers.set(g, (groupMembers.get(g) ?? 0) + 1);
    }
    // 纯数字 / xxx@chatroom 的群：数据里没有名字，**不伪造**，显示成可读占位「群 · 末6位 · N人」
    const displayGroups = groups.map((group) => {
      const raw = group.label.trim();
      const numeric = /^\d+(@chatroom)?$/.test(raw);
      if (!numeric) return group;
      const members = groupMembers.get(group.id) ?? 0;
      const tail = raw.replace(/@chatroom$/, "").slice(-6);
      const label = members > 0 ? `群 · ${tail} · ${members}人` : `群 · ${tail}`;
      return { ...group, label, title: raw };
    });
    return { nodes: displayGroups, edges: derived };
  }
  const kept = nodes.filter((node) => node.kind === "person" || node.kind === "direct");
  const ids = new Set(kept.map((node) => node.id));
  const keptEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  if (mode === "neighbors") {
    const local = buildLocalGraph(kept, keptEdges, meId, depth);
    // 「仅与我直接关系」**只画与「我」直接相连的边**：邻居之间的边一律不画（那是「人」模式的信息）。
    return {
      nodes: local.nodes,
      edges: local.edges.filter((edge) => edge.source === meId || edge.target === meId),
    };
  }
  return { nodes: kept, edges: keptEdges };
}


/**
 * 按搜索词过滤：保留 label 命中的节点 + 其**直接邻居**（避免命中节点孤零零悬着），
 * 边只保留两端都在保留集内的。
 *
 * @param nodes 节点
 * @param edges 边
 * @param query 搜索词（空串 / 纯空白 = 不过滤）
 * @returns 子图；无命中返回空子图（如实反映「没搜到」，不假装全画）
 */
export function applySearchFilter(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
  query: string,
): GraphSubset {
  const q = query.trim().toLowerCase();
  if (q === "") return { nodes: [...nodes], edges: [...edges] };

  const matched = new Set<string>();
  for (const node of nodes) {
    if (node.label.toLowerCase().includes(q)) matched.add(node.id);
  }
  if (matched.size === 0) return { nodes: [], edges: [] };

  const keep = new Set<string>(matched);
  for (const edge of edges) {
    if (matched.has(edge.source)) keep.add(edge.target);
    if (matched.has(edge.target)) keep.add(edge.source);
  }
  return {
    nodes: nodes.filter((node) => keep.has(node.id)),
    edges: edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}

/**
 * 过滤「未建档（孤儿）」：`showOrphans === false` 时去掉 `isolated === true` 的节点。
 * @param nodes 节点
 * @param edges 边
 * @param showOrphans 是否显示孤儿（false = 去掉）
 * @returns 子图
 */
export function applyOrphanFilter(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
  showOrphans: boolean,
): GraphSubset {
  if (showOrphans) return { nodes: [...nodes], edges: [...edges] };
  const keep = nodes.filter((node) => !node.isolated);
  const ids = new Set(keep.map((node) => node.id));
  return {
    nodes: keep,
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}

/**
 * 过滤「只显示已建档」：`onlyProfiled === true` 时只保留 `kind === "person"` 节点。
 * @param nodes 节点
 * @param edges 边
 * @param onlyProfiled 是否只显示已建档
 * @returns 子图
 */
export function applyProfiledFilter(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
  onlyProfiled: boolean,
): GraphSubset {
  if (!onlyProfiled) return { nodes: [...nodes], edges: [...edges] };
  const keep = nodes.filter((node) => node.kind === "person");
  const ids = new Set(keep.map((node) => node.id));
  return {
    nodes: keep,
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}

/**
 * 组合「过滤」组的三个开关（顺序固定：搜索 → 已建档 → 孤儿）。
 *
 * @param nodes 全量节点
 * @param edges 全量边
 * @param settings 设置（已夹紧）
 * @returns 过滤后的子图
 */
export function applyGraphFilters(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
  settings: GraphSettings,
): GraphSubset {
  let current: GraphSubset = { nodes: [...nodes], edges: [...edges] };
  current = applySearchFilter(current.nodes, current.edges, settings.searchQuery);
  current = applyProfiledFilter(current.nodes, current.edges, settings.onlyProfiled);
  current = applyOrphanFilter(current.nodes, current.edges, settings.showOrphans);
  return current;
}

/**
 * 局部图谱（Obsidian Local Graph）：从 `centerId` 出发做 BFS，取 N 层邻居。
 *
 * @param nodes 全量节点（应已过边类型 / 过滤）
 * @param edges 全量边
 * @param centerId 中心节点 id；不存在时返回空子图（调用方据此兜底）
 * @param depth 层数（1~5；越界按 1 夹紧）
 * @returns 子图（含中心 + N 层邻居，以及两端都在保留集内的边）
 */
export function buildLocalGraph(
  nodes: readonly GraphPanelNode[],
  edges: readonly GraphPanelEdge[],
  centerId: string,
  depth: number,
): GraphSubset {
  const maxDepth = Math.max(1, Math.round(Number.isFinite(depth) ? depth : 1));

  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }

  const keep = new Set<string>();
  let frontier = new Set<string>([centerId]);
  if (adjacency.has(centerId)) keep.add(centerId);

  for (let level = 0; level < maxDepth; level += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      const neighbors = adjacency.get(id) ?? [];
      for (const neighbor of neighbors) {
        if (!keep.has(neighbor)) {
          keep.add(neighbor);
          next.add(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  return {
    nodes: nodes.filter((node) => keep.has(node.id)),
    edges: edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}

/** `resolveVisibleSubset` 的入参：把面板 `visible` memo 的全部输入摊平成纯函数入参。 */
export interface ResolveVisibleInput {
  /** 全量快照节点（下钻应当基于它，而不是当前模式子集）。 */
  payloadNodes: readonly GraphPanelNode[];
  /** 全量快照边。 */
  payloadEdges: readonly GraphPanelEdge[];
  /** 当前模式的成员级子图（群 / 人 / 仅与我）。 */
  modeSubset: GraphSubset;
  /** 是否开启「按社区聚合」。 */
  aggregateByCommunity: boolean;
  /** 快照是否可用于社区聚合（≥2 个社区键）。 */
  useCommunity: boolean;
  /** 是否显示孤立节点（false → 去孤立 + 只留最大连通分量）。 */
  showOrphans: boolean;
  /** 当前下钻的社区键；`null` = 顶层聚合视图。 */
  drillCommunity: string | null;
}

/**
 * 计算画布最终可见子图（聚合 / 下钻 / 去孤立）。
 *
 * ## 下钻必须基于**全量快照**（W-36 修复）
 * 社区是按人物共现算出来的，成员绝大多数是 `person`；而默认 `mode="group"` 的成员级子图
 * 只含群节点。若在 `modeSubset` 里找社区成员 → 找到 0 → 画面"状态变了内容没变"。
 * 因此下钻用 `payloadNodes/payloadEdges`（全量）取社区成员，**不再**在模式子集里找。
 *
 * ## 空结果**不许静默退回**（W-36 产品要求）
 * 下钻到无成员社区时返回空子图（由面板显示 `graph-community-empty`），**不再**退回去重建聚合视图——
 * 静默退回正是这个 bug 藏了很久没人发现的原因。
 */
export function resolveVisibleSubset(input: ResolveVisibleInput): GraphSubset {
  let subset: GraphSubset = input.modeSubset;
  if (input.aggregateByCommunity && input.useCommunity) {
    if (input.drillCommunity !== null) {
      // 在**全量快照**里取该社区的成员（不受当前模式过滤）→ 修 W-36「下钻点进去看不到人」
      subset = buildCommunityDetail(
        { nodes: input.payloadNodes, edges: input.payloadEdges },
        input.drillCommunity,
      );
    } else {
      const cv = buildCommunityView(input.modeSubset);
      subset = { nodes: cv.nodes, edges: cv.edges };
    }
  }
  if (!input.showOrphans) {
    subset = dropIsolated(subset.nodes, subset.edges);
    subset = keepLargestComponent(subset.nodes, subset.edges);
  }
  return subset;
}
