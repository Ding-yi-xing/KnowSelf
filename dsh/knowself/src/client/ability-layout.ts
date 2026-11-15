/**
 * 能力图谱布局。
 *
 * 能力名称、强度和证据是这个视图的产品信息；分类和分组只是抽取来源的元数据，
 * 不能再决定空间位置、颜色或可见性。因此能力图与人物图共用世界坐标力导向布局，
 * 并强制投影为无社区节点。
 */
import type { GraphPanelEdge, GraphPanelNode } from "./graph-port.js";
import { layoutGraph, type GraphLayoutResult } from "./graph-layout.js";

/** 能力布局选项。保留旧字段以兼容调用端，但不再用分组圆周布局。 */
export interface AbilityLayoutOptions {
  /** 节点半径缩放（来自设置，缺省 1）。 */
  nodeSizeScale?: number;
  /** 最小绘制半径（px），保证小节点可见可点。缺省 6。 */
  minRadius?: number;
  /** @deprecated 分组布局已移除。 */
  paddingFraction?: number;
  /** @deprecated 分组布局已移除。 */
  groupCircleFraction?: number;
}

/**
 * 计算能力图谱的世界坐标布局。
 *
 * @param input 节点 / 边 / 当前画布尺寸
 * @param options 见 {@link AbilityLayoutOptions}
 * @returns 世界坐标布局；由视口负责适配当前画布并支持平移
 */
export function layoutAbilityGraph(
  input: {
    nodes: readonly GraphPanelNode[];
    edges: readonly GraphPanelEdge[];
    width: number;
    height: number;
  },
  options: AbilityLayoutOptions = {},
): GraphLayoutResult {
  const projectedNodes: GraphPanelNode[] = input.nodes.map((node) => ({ ...node, community_key: null }));
  const layout = layoutGraph(
    { ...input, nodes: projectedNodes },
    {
      nodeSizeScale: options.nodeSizeScale ?? 1,
      // 能力图通常比人物图小，但标签全部可见时需要更大的安全距离。
      repulsion: 1.5,
      linkStrength: 0.7,
      linkDistance: 150,
      centerStrength: 0.018,
    },
  );
  const minRadius = Math.max(0, options.minRadius ?? 6);
  return {
    ...layout,
    nodes: layout.nodes.map((node) => ({ ...node, radius: Math.max(minRadius, node.radius), communityKey: null })),
  };
}
