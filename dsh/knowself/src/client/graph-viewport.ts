/**
 * 图谱**视口变换**（纯函数，零依赖、零 React、可在 node 里直接单测）。
 *
 * ## 为什么单独成模块
 * 缩放 / 平移 / 命中测试全是坐标数学，放进组件里既无法单测（需要 jsdom + canvas），
 * 又容易和「取数 / 三态渲染」搅在一起。抽出来后：
 *   - 往返一致性（`toScreen(toGraph(p))`）可以用一个断言钉住；
 *   - `zoomAt` 的「锚点在世界坐标中不位移」是同一条不等式，可被精确验证；
 *   - `graph-canvas.ts` 只负责把算好的数字喂给 canvas 2D。
 *
 * ## 坐标约定（全模块统一）
 *   - **图坐标（graph）**：布局产出的坐标，原点在画布左上，未缩放未平移；
 *   - **屏幕坐标（screen）**：CSS 像素，等于 `graph · scale + offset`；
 *   - 变换关系永远是 `screen = graph * scale + offset`，因此
 *     `graph = (screen - offset) / scale`。两者互为逆运算。
 *
 * ## 缩放范围
 * `MIN_SCALE = 0.15` / `MAX_SCALE = 8`：图谱是可平移的世界坐标，用户需要在总览与密集
 * 区域之间自由切换；两头仍由 `clampScale` 夹住，避免非法变换。
 */

/** 视口（缩放 + 平移）。 */
export interface Viewport {
  /** 缩放系数，恒在 `[MIN_SCALE, MAX_SCALE]` 内。 */
  scale: number;
  /** 屏幕坐标下的平移量（CSS 像素）。 */
  offsetX: number;
  offsetY: number;
}

/** 二维点（图坐标或屏幕坐标，由调用位置决定）。 */
export interface ViewPoint {
  x: number;
  y: number;
}

/** 画布尺寸（CSS 像素）。 */
export interface ViewSize {
  width: number;
  height: number;
}

/** 命中测试只要求「有坐标和半径」，不绑定具体节点类型。 */
export interface HittableNode extends ViewPoint {
  radius: number;
}

/** 最小缩放（再小就看不清了）。 */
export const MIN_SCALE = 0.15;
/** 最大缩放（用于查看密集区域和标签）。 */
export const MAX_SCALE = 8;
/** 复位视口（1:1，无平移）。 */
export const IDENTITY_VIEWPORT: Readonly<Viewport> = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * 把缩放系数夹到 `[MIN_SCALE, MAX_SCALE]`。
 *
 * 非有限值（NaN / Infinity，常见于 `deltaY` 异常）退化为 1，**绝不把 NaN 传进 canvas**。
 *
 * @param scale 原始缩放系数
 * @returns 夹紧后的系数
 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 图坐标 → 屏幕坐标。
 * @param point 图坐标
 * @param vp 视口
 * @returns 屏幕坐标（CSS 像素）
 */
export function toScreen(point: ViewPoint, vp: Viewport): ViewPoint {
  return { x: point.x * vp.scale + vp.offsetX, y: point.y * vp.scale + vp.offsetY };
}

/**
 * 屏幕坐标 → 图坐标（`toScreen` 的逆运算）。
 * @param point 屏幕坐标（CSS 像素）
 * @param vp 视口
 * @returns 图坐标
 */
export function toGraph(point: ViewPoint, vp: Viewport): ViewPoint {
  const scale = vp.scale === 0 ? 1 : vp.scale;
  return { x: (point.x - vp.offsetX) / scale, y: (point.y - vp.offsetY) / scale };
}

/**
 * 以屏幕上的 `anchor` 为**不动点**缩放。
 *
 * 推导：设 `k = newScale / oldScale`，锚点的图坐标 `w = (anchor - offset) / oldScale`。
 * 要求缩放后 `w · newScale + offset' = anchor`，解得
 * `offset' = anchor - k · (anchor - offset)`。这样「鼠标指着哪个点，放大后那个点还在鼠标下」。
 *
 * @param vp 当前视口
 * @param anchorScreen 屏幕坐标下的锚点（通常是鼠标位置）
 * @param factor 缩放因子（>1 放大，<1 缩小）；非有限值直接返回原视口
 * @returns 新视口（`scale` 已夹紧；夹紧后锚点仍然不动）
 */
export function zoomAt(vp: Viewport, anchorScreen: ViewPoint, factor: number): Viewport {
  if (!Number.isFinite(factor) || factor <= 0) return vp;
  const nextScale = clampScale(vp.scale * factor);
  // 已经顶到上下界时不动，避免「继续滚但图不动」时 offset 累积漂移
  if (nextScale === vp.scale) return vp;
  const k = nextScale / vp.scale;
  return {
    scale: nextScale,
    offsetX: anchorScreen.x - k * (anchorScreen.x - vp.offsetX),
    offsetY: anchorScreen.y - k * (anchorScreen.y - vp.offsetY),
  };
}

/**
 * 计算「把给定节点铺满画布」的视口（双击复位用）。
 *
 * 规则：取所有节点的外接盒（含半径），留 `padding` 边距，
 * 取横纵两个方向的较小缩放并夹到 `[MIN_SCALE, MAX_SCALE]`，再平移使外接盒居中。
 *
 * 边界：无节点 / 尺寸非法 / 外接盒退化为点时返回 1:1 居中（而不是除零产生 NaN）。
 *
 * @param nodes 已布局的节点
 * @param size 画布尺寸（CSS 像素）
 * @param padding 四周留白（默认 24px）
 * @returns 复位后的视口
 */
export function fitViewport(
  nodes: readonly HittableNode[],
  size: ViewSize,
  padding = 24,
): Viewport {
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 0;
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : 0;
  if (nodes.length === 0 || width <= 0 || height <= 0) {
    return { ...IDENTITY_VIEWPORT };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const r = Number.isFinite(node.radius) ? Math.max(0, node.radius) : 0;
    minX = Math.min(minX, node.x - r);
    maxX = Math.max(maxX, node.x + r);
    minY = Math.min(minY, node.y - r);
    maxY = Math.max(maxY, node.y + r);
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // 边距不得超过短边的一半，否则极小窗口下会得到负的可用空间
  const pad = Math.max(0, Math.min(padding, Math.min(width, height) / 4));
  const usableWidth = Math.max(1, width - 2 * pad);
  const usableHeight = Math.max(1, height - 2 * pad);

  const scale = clampScale(Math.min(usableWidth / spanX, usableHeight / spanY));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    scale,
    offsetX: width / 2 - centerX * scale,
    offsetY: height / 2 - centerY * scale,
  };
}

/**
 * 命中测试：返回**离得最近**且落在 `半径 + pad` 内的节点。
 *
 * 为什么取最近而不是「先命中先返回」：节点重叠时，先返回会让用户点 A 得到 B，
 * 取最近至少保证「点在哪个圆内部就选哪个」的直觉成立。
 *
 * @param nodes 已布局节点（只需 x / y / radius）
 * @param graphPoint **图坐标**下的指针位置（调用方先用 {@link toGraph} 转换）
 * @param pad 额外容差（默认 4px，图坐标下即 4/scale 屏幕像素）
 * @param minRadius 最小命中半径（默认 0 = 不改变既有口径；能力视图传 10 让小节点也点得到）
 * @returns 命中的节点；未命中返回 `null`
 */
export function hitTestNodes<T extends HittableNode>(
  nodes: readonly T[],
  graphPoint: ViewPoint,
  pad = 4,
  minRadius = 0,
): T | null {
  if (!Number.isFinite(graphPoint.x) || !Number.isFinite(graphPoint.y)) return null;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const node of nodes) {
    const dx = graphPoint.x - node.x;
    const dy = graphPoint.y - node.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const limit = Math.max(Math.max(0, node.radius), Math.max(0, minRadius)) + Math.max(0, pad);
    if (distance <= limit && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}
