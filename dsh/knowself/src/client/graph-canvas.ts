/**
 * 图谱**画布绘制**（canvas 2D，零依赖、不 import 任何图库）。
 *
 * 从 `graph-panel.tsx` 抽出（W-2）：面板原来 483 行超过 350 行上限，且绘制逻辑
 * 与「取数 / 三态 / 交互」混在一起无法单测。抽出后：
 *   - 本模块只做「准备画布 → 画边 → 画点 → 写标签」；
 *   - 坐标变换全部来自 `graph-viewport.ts` 的纯函数，这里只负责把 `scale` 灌进
 *     `setTransform`。
 *
 * ## 高 DPI
 * 画布位图尺寸 = CSS 尺寸 × `devicePixelRatio`，坐标系用 `setTransform` 换回 CSS 像素，
 * 否则 Retina / 缩放 125% 下线条与文字会发虚。
 *
 * ## 视口（W-2 新增）
 * 变换矩阵 = `dpr · viewport`：`setTransform(scale·dpr, 0, 0, scale·dpr, offsetX·dpr, offsetY·dpr)`
 * ——先按视口缩放平移（图坐标 → 屏幕 CSS 像素），再整体乘 dpr 换到设备像素。
 *
 * ## 标签字号补偿（W-2）
 * 标签在**图坐标**里画，所以字号必须取 `11 / scale`：放大 2 倍时图坐标里的 5.5px
 * 渲染到屏幕正好还是 11px。不补偿的话放大后字会巨大、缩小后糊成一团。
 * 同理，线宽与标签下移距离也按 `1/scale` 补偿，保证屏幕观感恒定。
 *
 * ## 悬停邻接高亮（W-2）
 * 传入 `hoveredId` 时：命中节点及其**直接相邻**节点/边保持原样，其余降到
 * `DIM_ALPHA = 0.25`。实现上是**单趟绘制 + alpha 判定**（不是画两遍），
 * 这样既有测试里「一条边一次 moveTo」的断言不受影响。
 *
 * ## 无 Canvas 环境
 * `get2dContext` 在 jsdom（未装 canvas 包）等环境返回 `null` **且不抛错**，
 * 由面板显示「当前环境不支持 Canvas 2D 绘制」——既有测试依赖这条语义。
 */
import type { GraphEdgeKind } from "@knowself/contracts";
import type { GraphPanelNodeKind } from "./graph-port.js";
import type { GraphLayoutEdge, GraphLayoutNode, GraphLayoutResult } from "./graph-layout.js";
import { communityColor } from "./graph-colors.js";
import { fitViewport, IDENTITY_VIEWPORT, type Viewport } from "./graph-viewport.js";

/**
 * 画布用的三个颜色。
 *
 * **刻意不从 `panel-states.tsx` import**：那个文件是 React 组件模块，
 * import 它会把 React 拖进这个「纯绘制、可在 node 里跑」的模块。
 * 值与 `PANEL_COLORS` 的同名字段保持一致（light 主题；有单测对比）。
 */
const SURFACE_COLOR = "#fff";
const TEXT_COLOR = "#111827";
const MUTED_COLOR = "#6b7280";
const HIGHLIGHT_ACCENT = "#2563eb";

/** 标签最多显示的**码点数**（超出截断为 `…`）。放宽到 20 是为了让「群 · 末6位 · N人」
 *  和「11月2日工行校招」这类真实群名完整显示。 */
export const LABEL_MAX_CHARS = 20;

/** 基准字号（CSS 像素；实际绘制时按 `1/scale` 补偿）。 */
const BASE_FONT_SIZE = 11;

/** 非邻接元素的透明度（悬停高亮时）。 */
export const DIM_ALPHA = 0.25;

/** 节点类型 → 画布颜色（全部为深色，light 主题下与白底对比度足够）。 */
export const NODE_COLORS: Readonly<Record<GraphPanelNodeKind, string>> = {
  person: HIGHLIGHT_ACCENT,
  group: "#7c3aed",
  topic: "#0f766e",
  // W29：单聊会话节点（与群/人物区分）
  direct: "#db2777",
  // 社区超节点用中性灰蓝：它代表"一群关系"，不是某一个人
  community: "#334155",
  // 0.5.0：能力节点（能力视图）用青绿，与人/群/单聊明确区分
  ability: "#0d9488",
};

/** 节点类型 → 中文标签（图例用）。 */
export const NODE_KIND_LABELS: Readonly<Record<GraphPanelNodeKind, string>> = {
  person: "人物",
  community: "社区",
  group: "群",
  topic: "话题",
  direct: "单聊",
  ability: "能力",
};

/** 画布 2D 上下文类型别名（避免 `CanvasRenderingContext2D` 名字重复出现）。 */
export type Canvas2D = CanvasRenderingContext2D;

/** 绘制选项（全部可选，缺省即「1:1、无悬停」，与 W-2 之前的行为一致）。 */
export interface DrawGraphOptions {
  /** 视口（缺省 1:1 无平移）。 */
  viewport?: Viewport;
  /** 当前悬停节点 id；非空时启用邻接高亮。 */
  hoveredId?: string | null;
  /** 已经过客户端过滤、**不应绘制**的边类型（防御性：正常路径走服务端过滤）。 */
  hiddenEdgeKinds?: readonly GraphEdgeKind[];
  /** 按 `community_key` 上色（false = 按节点类型上色，缺省行为）。 */
  colorByCommunity?: boolean;
  /** @deprecated Names are always rendered; retained for persisted legacy options. */
  showLabels?: boolean;
  /** 连线粗细倍率（默认 1；设置面板「连线粗细」滑杆映射）。 */
  edgeWidthScale?: number;
}

/**
 * 截断长标签：按**码点**切（不会把 emoji 切一半），保留前 {@link LABEL_MAX_CHARS} 个。
 * @param label 原始标签
 * @param max 最多字数（默认 {@link LABEL_MAX_CHARS}）
 * @returns 截断后的标签
 */
export function truncateLabel(label: string, max = LABEL_MAX_CHARS): string {
  const chars = Array.from(label);
  if (chars.length <= max) return label;
  return `${chars.slice(0, max).join("")}…`;
}

/** 取 `[0,1]` 夹紧值（画布透明度 / 线宽用，防止脏数据产生非法样式）。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 取设备像素比（SSR / 老浏览器退化为 1）。
 * @returns `>= 1` 的缩放系数
 */
export function devicePixelRatio(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * 取 2D 上下文；环境不支持（如 jsdom 未装 canvas 包）时返回 `null`，**不抛错**。
 * @param canvas 画布元素
 * @returns 2D 上下文或 `null`
 */
export function get2dContext(canvas: HTMLCanvasElement): Canvas2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

/**
 * 按视口设置位图尺寸与变换矩阵。
 *
 * 位图尺寸只跟 CSS 尺寸与 dpr 有关（**与视口无关**）：缩放是「在固定画布内重新映射
 * 图坐标」，不是改画布分辨率——否则每次滚轮都会重建位图，性能与清晰度都会掉。
 */
function applyViewport(
  ctx: Canvas2D,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  vp: Viewport,
): void {
  const dpr = devicePixelRatio();
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.width = `${Math.max(1, Math.round(cssWidth))}px`;
  canvas.style.height = `${Math.max(1, Math.round(cssHeight))}px`;

  // 背景先按「设备像素 · CSS 像素」的 1:1 坐标铺满，避免视口把背景也缩掉
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = SURFACE_COLOR;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // 之后所有绘制都在「图坐标」里进行
  ctx.setTransform(
    vp.scale * dpr,
    0,
    0,
    vp.scale * dpr,
    vp.offsetX * dpr,
    vp.offsetY * dpr,
  );
}

/**
 * 计算悬停高亮集合：命中节点 + 其直接相邻节点。
 * @param edges 布局后的边（含 source / target）
 * @param hoveredId 命中的节点 id
 * @returns 需要保持不透明显示的节点 id 集合（含自身）；未悬停返回 `null`
 */
export function buildHighlightSet(
  edges: readonly { source: string; target: string }[],
  hoveredId: string | null | undefined,
): Set<string> | null {
  if (hoveredId === null || hoveredId === undefined || hoveredId === "") return null;
  const set = new Set<string>([hoveredId]);
  for (const edge of edges) {
    if (edge.source === hoveredId) set.add(edge.target);
    else if (edge.target === hoveredId) set.add(edge.source);
  }
  return set;
}

/**
 * 把布局结果画到画布上（先边后点最后标签，保证标签不被圆盖住）。
 *
 * @param canvas 画布元素（位图尺寸由本函数按 `devicePixelRatio` 设置）
 * @param layout 布局结果
 * @param cssWidth 画布 CSS 宽度（逻辑像素）
 * @param cssHeight 画布 CSS 高度（逻辑像素）
 * @param options 视口 / 悬停 / 隐藏边类型（缺省 = 1:1 无高亮）
 * @returns 是否真的画了（`false` = 当前环境没有 Canvas 2D，面板据此显示降级说明）
 */
export function drawGraph(
  canvas: HTMLCanvasElement,
  layout: GraphLayoutResult,
  cssWidth: number,
  cssHeight: number,
  options: DrawGraphOptions = {},
): boolean {
  const ctx = get2dContext(canvas);
  if (ctx === null) return false;

  const vp = options.viewport ?? IDENTITY_VIEWPORT;
  const scale = Number.isFinite(vp.scale) && vp.scale > 0 ? vp.scale : 1;
  const hidden = new Set(options.hiddenEdgeKinds ?? []);
  const hoveredId = options.hoveredId ?? null;
  const highlight = buildHighlightSet(layout.edges, hoveredId);
  const colorByCommunity = options.colorByCommunity === true;
  const edgeWidthScale = Number.isFinite(options.edgeWidthScale) && options.edgeWidthScale !== undefined
    ? Math.max(0.1, options.edgeWidthScale)
    : 1;
  applyViewport(ctx, canvas, cssWidth, cssHeight, { ...vp, scale });

  // ① 边：灰色线，强度越高越不透明、越粗；悬停时**非邻接边**变淡。
  for (const edge of layout.edges) {
    if (hidden.has(edge.kind)) continue;
    const strength = clamp01(edge.strength);
    ctx.globalAlpha = isAdjacentEdge(edge, hoveredId) ? 1 : hoveredId === null ? 1 : DIM_ALPHA;
    ctx.strokeStyle = `rgba(107, 114, 128, ${(0.18 + 0.5 * strength).toFixed(3)})`;
    // 线宽按 1/scale 补偿，放大后线条不会变成粗带
    ctx.lineWidth = ((1 + strength * 1.5) * edgeWidthScale) / scale;
    ctx.beginPath();
    ctx.moveTo(edge.x1, edge.y1);
    ctx.lineTo(edge.x2, edge.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ② 节点：实心圆 + 白色描边（描边让重叠节点仍可分辨）。
  for (const node of layout.nodes) {
    const dimmed = highlight !== null && !highlight.has(node.id);
    ctx.globalAlpha = dimmed ? DIM_ALPHA : node.isolated ? 0.55 : 1;
    ctx.beginPath();
    ctx.fillStyle = colorByCommunity
      ? communityColor(node.communityKey)
      : NODE_COLORS[node.kind] ?? "#6b7280";
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = SURFACE_COLOR;
    ctx.stroke();
  }

  // ③ 标签：每个已绘制节点都有名字。世界坐标允许用户缩放/平移查看密集区域，
  //    不能再用显著性或分组规则静默隐藏节点身份。
  ctx.font = `${(BASE_FONT_SIZE / scale).toFixed(2)}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const node of layout.nodes) {
    const dimmed = highlight !== null && !highlight.has(node.id);
    const text = truncateLabel(node.label);
    const tx = node.x;
    const ty = node.y + node.radius + 3 / scale;
    // 白色描边光晕：压在密集连线上也能看清（尤其「仅与我」中心的「我」）
    ctx.globalAlpha = dimmed ? 0.7 : 1;
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = SURFACE_COLOR;
    // jsdom / 记账用假上下文可能没有 strokeText —— 有才画，不影响真实浏览器
    if (typeof ctx.strokeText === "function") ctx.strokeText(text, tx, ty);
    ctx.globalAlpha = 1;
    ctx.fillStyle = dimmed ? MUTED_COLOR : TEXT_COLOR;
    ctx.fillText(text, tx, ty);
  }
  ctx.globalAlpha = 1;

  return true;
}

/**
 * 这条边是否与悬停节点直接相连。
 *
 * @param edge 布局后的边
 * @param hoveredId 悬停节点 id（`null` = 未悬停）
 * @returns 是否应保持不透明
 */
function isAdjacentEdge(edge: GraphLayoutEdge, hoveredId: string | null): boolean {
  if (hoveredId === null) return true;
  return edge.source === hoveredId || edge.target === hoveredId;
}

/**
 * 把节点集合缩放到「铺满画布」的视口（双击复位）。
 *
 * 纯委托给 {@link fitViewport}，让面板不必再 import 一次 viewport 模块。
 *
 * @param nodes 布局节点
 * @param width 画布 CSS 宽
 * @param height 画布 CSS 高
 * @returns 复位视口
 */
export function fitNodes(
  nodes: readonly GraphLayoutNode[],
  width: number,
  height: number,
): Viewport {
  return fitViewport(nodes, { width, height });
}
