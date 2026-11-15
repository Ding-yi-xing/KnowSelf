/**
 * 能力视图的**独立筛选**（纯函数，T05，0.5.0）。
 *
 * ## 与人物视图的关系
 * 能力视图的筛选维度（强度 / 关键词 / 置信）与人物图谱的
 * `GraphSettings` **完全独立**——各自一份 state，互不影响。本文件只做纯计算，不碰 React。
 *
 * ## 契约（可单测的关键点）
 *   - 节点过滤：关键词（label，大小写不敏感）、高置信（≥0.9）。
 *   - 边过滤：**两端节点都保留** 且 `strength >= minStrength`。→ 不产生悬空边。
 *   - 强度阈值**只筛边、不删节点**：某节点的边全被强度筛掉后，节点本身仍保留（是否因孤立而隐藏由调用方决定）。
 */
import type { AbilityEdge, AbilityNode } from "@knowself/contracts";

/** 高置信阈值（`confidence >= 0.9`）。 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.9;

/** 能力视图筛选状态（各维度独立，空数组/空串/0 = 不过滤）。 */
export interface AbilityFilters {
  /** 最小关联强度 `[0,1]`；边 `strength < minStrength` 被筛掉。0=全留。 */
  minStrength: number;
  /** 关键词（label 子串，大小写不敏感）；空=不过滤。 */
  search: string;
  /** 仅看高置信（`confidence >= 0.9`）。 */
  highConfidenceOnly: boolean;
}

/** 默认筛选：全不过滤。 */
export const DEFAULT_ABILITY_FILTERS: AbilityFilters = {
  minStrength: 0,
  search: "",
  highConfidenceOnly: false,
};

/**
 * 对能力节点 / 边做独立筛选（纯函数）。
 *
 * @param nodes 全量能力节点
 * @param edges 全量能力边
 * @param filters 筛选状态
 * @returns 过滤后的节点 + 边（**边两端必在返回的节点集内**，无悬空边）
 */
export function filterAbilities(
  nodes: readonly AbilityNode[],
  edges: readonly AbilityEdge[],
  filters: AbilityFilters,
): { nodes: AbilityNode[]; edges: AbilityEdge[] } {
  const q = filters.search.trim().toLowerCase();
  const keptNodes = nodes.filter((node) => {
    // 关键词：大小写不敏感的子串
    if (q !== "" && !node.label.toLowerCase().includes(q)) return false;
    // 高置信
    if (filters.highConfidenceOnly && node.confidence < HIGH_CONFIDENCE_THRESHOLD) return false;
    return true;
  });

  const keptIds = new Set(keptNodes.map((node) => node.id));
  const keptEdges = edges.filter(
    (edge) =>
      keptIds.has(edge.source) &&
      keptIds.has(edge.target) &&
      edge.strength >= filters.minStrength,
  );

  return { nodes: keptNodes, edges: keptEdges };
}
