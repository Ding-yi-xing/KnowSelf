/**
 * 图谱**设置状态**（纯数据类型 + 缺省值 + 夹紧，零依赖，可在 node 里单测）。
 *
 * ## 与 Obsidian Graph View 的对齐
 * 四个分组（过滤 / 颜色分组 / 显示 / 力学）+ 局部图谱深度，全部落到同一个
 * `GraphSettings` 对象上：设置面板（`graph-settings-panel.tsx`）只读写它，
 * 面板主文件（`graph-panel.tsx`）只把它的子集映射到布局 / 绘制参数。
 *
 * ## 为什么要夹紧
 * 滑杆来自 `<input type="range">`，理论上浏览器已夹住；但真机 / 测试里仍可能
 * 出现 NaN / 越界（例如从 URL 恢复、或手动塞值）。这里提供 `clampGraphSettings`
 * 保证任何脏值都不会被喂进布局 / canvas（不产生 NaN 半径、不产生负线宽）。
 */
import type { GraphLayoutOptions } from "./graph-layout.js";

/** 图谱设置（全部必填：调用方要么用 {@link DEFAULT_GRAPH_SETTINGS}，要么整体传）。 */
export interface GraphSettings {
  /** 过滤：搜索人物 / 标签（按 label 子串匹配，空串 = 不过滤）。 */
  searchQuery: string;
  /** 过滤：显示未建档（孤儿）节点（`isolated === true`）。 */
  showOrphans: boolean;
  /** 兼容旧设置字段；节点名称现在始终显示。 */
  showLabels: boolean;
  /** 过滤：只显示已建档（`kind === "person"`）节点。 */
  onlyProfiled: boolean;
  /** 颜色分组：按 `community_key` 上色（未分组灰）。 */
  colorByCommunity: boolean;
  /** 视图：按社区聚合（把当前节点折叠成社区超节点）。**是一种视图，不是筛选维度**，默认关。 */
  aggregateByCommunity: boolean;
  /** 显示：节点大小倍率（1~10，默认 5 = ×1）。 */
  nodeSizeScale: number;
  /** 显示：连线粗细倍率（1~10，默认 3 = ×1）。 */
  edgeWidthScale: number;
  /** 力学：中心力（0~10）。 */
  centerForce: number;
  /** 力学：斥力（0~10）。 */
  repulsionForce: number;
  /** 力学：连力（0~10）。 */
  linkForce: number;
  /** 力学：连距（10~500，理想边长的像素值）。 */
  linkDistance: number;
  /** 局部图谱：深度（1~5，只显示选中节点的 N 层邻居）。 */
  localDepth: number;
}

/** 缺省设置（与设计稿滑杆初值一致；力参数映射见 {@link layoutOptionsFromSettings}）。 */
export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  searchQuery: "",
  // 默认不画孤立节点（degree===0），避免它们被斥力顶到画布边缘成散点噪声
  showOrphans: false,
  showLabels: true,
  onlyProfiled: false,
  colorByCommunity: true,
  aggregateByCommunity: false,
  nodeSizeScale: 5,
  edgeWidthScale: 3,
  centerForce: 3,
  repulsionForce: 5,
  linkForce: 4,
  linkDistance: 120,
  localDepth: 1,
};

/** 滑杆区间（供设置面板与测试共用，避免魔法数字）。 */
export const SETTINGS_RANGES = {
  nodeSizeScale: { min: 1, max: 10 },
  edgeWidthScale: { min: 1, max: 10 },
  centerForce: { min: 0, max: 10 },
  repulsionForce: { min: 0, max: 10 },
  linkForce: { min: 0, max: 10 },
  linkDistance: { min: 10, max: 500 },
  localDepth: { min: 1, max: 5 },
} as const;

/** 把任意数值夹到 `[min, max]`；非有限值回退 `min`。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 夹紧一份设置（防御脏数据；`searchQuery` 只做空串归一，不做长度截断）。
 * @param settings 原始设置
 * @returns 夹紧后的设置（新对象，不修改入参）
 */
export function clampGraphSettings(settings: GraphSettings): GraphSettings {
  return {
    searchQuery: typeof settings.searchQuery === "string" ? settings.searchQuery : "",
    showOrphans: settings.showOrphans === true,
    showLabels: true,
    onlyProfiled: settings.onlyProfiled === true,
    colorByCommunity: settings.colorByCommunity !== false,
    aggregateByCommunity: settings.aggregateByCommunity === true,
    nodeSizeScale: clamp(settings.nodeSizeScale, SETTINGS_RANGES.nodeSizeScale.min, SETTINGS_RANGES.nodeSizeScale.max),
    edgeWidthScale: clamp(settings.edgeWidthScale, SETTINGS_RANGES.edgeWidthScale.min, SETTINGS_RANGES.edgeWidthScale.max),
    centerForce: clamp(settings.centerForce, SETTINGS_RANGES.centerForce.min, SETTINGS_RANGES.centerForce.max),
    repulsionForce: clamp(settings.repulsionForce, SETTINGS_RANGES.repulsionForce.min, SETTINGS_RANGES.repulsionForce.max),
    linkForce: clamp(settings.linkForce, SETTINGS_RANGES.linkForce.min, SETTINGS_RANGES.linkForce.max),
    linkDistance: clamp(settings.linkDistance, SETTINGS_RANGES.linkDistance.min, SETTINGS_RANGES.linkDistance.max),
    localDepth: Math.round(clamp(settings.localDepth, SETTINGS_RANGES.localDepth.min, SETTINGS_RANGES.localDepth.max)),
  };
}

/**
 * 把设置里的四个力学滑杆映射成 `layoutGraph` 的可调参数。
 *
 * 映射约定（与设计稿滑杆语义对齐）：
 *   - 中心力 `centerForce`（0~10）→ `centerStrength = centerForce / 100`；
 *   - 斥力 `repulsionForce`（0~10）→ `repulsion = repulsionForce / 4`（5 = 1.25，比 1.0 基准上调一档，
 *     让外围节点聚成小簇而不是被顶成一圈散点）；
 *   - 连力 `linkForce`（0~10）→ `linkStrength = linkForce / 5`（4 = 0.8，比基准略松）；
 *   - 连距 `linkDistance`（10~500）→ `linkDistance`（理想边长的像素值）。
 *
 * @param settings 已夹紧的设置
 * @returns 布局参数（每次都是新对象，供 `useMemo` 依赖比较）
 */
export function layoutOptionsFromSettings(settings: GraphSettings): GraphLayoutOptions {
  return {
    centerStrength: settings.centerForce / 100,
    repulsion: settings.repulsionForce / 4,
    linkStrength: settings.linkForce / 5,
    linkDistance: settings.linkDistance,
    nodeSizeScale: settings.nodeSizeScale / 5,
  };
}

/**
 * 连线粗细倍率：设置里的 1~10 → 1/3 基准的倍率（默认 3 = ×1）。
 * @param settings 已夹紧的设置
 * @returns 倍率（恒 > 0）
 */
export function edgeWidthScaleFactor(settings: GraphSettings): number {
  return clamp(settings.edgeWidthScale, 1, 10) / 3;
}
