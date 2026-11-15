/**
 * W-2 图谱视口纯函数测试（零 DOM、零 canvas）。
 *
 * 这一组断言钉的是**坐标不变式**而不是具体数字：
 *   ① 往返一致：`toScreen(toGraph(p)) ≈ p`；
 *   ② 锚点不动：`zoomAt` 后锚点在世界坐标中不位移（这是「滚轮缩放不跑偏」的本质）；
 *   ③ 夹紧边界：缩放恒在 `[0.5, 3]`；
 *   ④ 命中取最近：重叠时点在哪个圆内就选哪个。
 */
import { describe, it, expect } from "vitest";
import {
  clampScale,
  fitViewport,
  hitTestNodes,
  IDENTITY_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  toGraph,
  toScreen,
  zoomAt,
  type Viewport,
} from "../src/client/graph-viewport.js";

const VP: Viewport = { scale: 1.7, offsetX: -42, offsetY: 31 };

describe("toScreen / toGraph 往返", () => {
  it("往返误差 < 0.5（含非 1 缩放与非零平移）", () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 123.4, y: -56.7 },
      { x: -800, y: 640 },
    ]) {
      const round = toGraph(toScreen(point, VP), VP);
      expect(Math.abs(round.x - point.x)).toBeLessThan(0.5);
      expect(Math.abs(round.y - point.y)).toBeLessThan(0.5);
    }
  });

  it("缩放为 0 时 toGraph 不产生 Infinity/NaN（防御性）", () => {
    const broken: Viewport = { scale: 0, offsetX: 10, offsetY: 20 };
    const out = toGraph({ x: 5, y: 6 }, broken);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
  });
});

describe("clampScale", () => {
  it("小于下限夹到 0.15、大于上限夹到 8", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.4)).toBe(1.4);
  });

  it("非有限值退化为 1（不把 NaN 传进 canvas）", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("zoomAt：锚点在世界坐标中不位移", () => {
  it("放大后锚点对应的图坐标仍落在同一个屏幕位置", () => {
    const anchor = { x: 300, y: 200 };
    const worldBefore = toGraph(anchor, VP);
    const next = zoomAt(VP, anchor, 1.5);
    const worldAfter = toGraph(anchor, next);

    expect(next.scale).toBeCloseTo(VP.scale * 1.5, 6);
    expect(Math.abs(worldAfter.x - worldBefore.x)).toBeLessThan(0.5);
    expect(Math.abs(worldAfter.y - worldBefore.y)).toBeLessThan(0.5);
  });

  it("缩小同样保持锚点不动", () => {
    const anchor = { x: 10, y: 400 };
    const worldBefore = toGraph(anchor, VP);
    const next = zoomAt(VP, anchor, 0.6);
    const worldAfter = toGraph(anchor, next);
    expect(Math.abs(worldAfter.x - worldBefore.x)).toBeLessThan(0.5);
    expect(Math.abs(worldAfter.y - worldBefore.y)).toBeLessThan(0.5);
  });

  it("顶到上限后继续放大：视口不变（offset 不漂移）", () => {
    const maxed: Viewport = { scale: MAX_SCALE, offsetX: 5, offsetY: 7 };
    expect(zoomAt(maxed, { x: 1, y: 2 }, 2)).toEqual(maxed);
  });

  it("非法因子直接返回原视口", () => {
    expect(zoomAt(VP, { x: 0, y: 0 }, Number.NaN)).toEqual(VP);
    expect(zoomAt(VP, { x: 0, y: 0 }, 0)).toEqual(VP);
    expect(zoomAt(VP, { x: 0, y: 0 }, -1)).toEqual(VP);
  });
});

describe("fitViewport", () => {
  const nodes = [
    { x: 100, y: 100, radius: 5 },
    { x: 300, y: 200, radius: 5 },
  ];

  it("把外接盒居中并落在缩放区间内", () => {
    const vp = fitViewport(nodes, { width: 640, height: 420 }, 24);
    expect(vp.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(vp.scale).toBeLessThanOrEqual(MAX_SCALE);
    // 外接盒中心 (200,150) 在 640×420 画布上应落在中心附近
    const center = toScreen({ x: 200, y: 150 }, vp);
    expect(Math.abs(center.x - 320)).toBeLessThan(1);
    expect(Math.abs(center.y - 210)).toBeLessThan(1);
  });

  it("无节点 / 尺寸为 0 时回落到 1:1（绝不产生 NaN）", () => {
    expect(fitViewport([], { width: 640, height: 420 })).toEqual({ ...IDENTITY_VIEWPORT });
    const zero = fitViewport(nodes, { width: 0, height: 0 });
    expect(zero).toEqual({ ...IDENTITY_VIEWPORT });
    expect(Number.isFinite(zero.scale)).toBe(true);
  });

  it("所有节点重合（外接盒退化）时不除零", () => {
    const vp = fitViewport([{ x: 50, y: 50, radius: 4 }], { width: 200, height: 200 }, 10);
    expect(Number.isFinite(vp.scale)).toBe(true);
    expect(Number.isFinite(vp.offsetX)).toBe(true);
    expect(Number.isFinite(vp.offsetY)).toBe(true);
  });
});

describe("hitTestNodes", () => {
  const nodes = [
    { id: "a", x: 100, y: 100, radius: 10 },
    { id: "b", x: 140, y: 100, radius: 10 },
    { id: "c", x: 400, y: 400, radius: 5 },
  ];

  it("点在圆内 → 命中该节点", () => {
    expect(hitTestNodes(nodes, { x: 102, y: 103 })?.id).toBe("a");
    expect(hitTestNodes(nodes, { x: 398, y: 401 })?.id).toBe("c");
  });

  it("点在所有圆外 → null", () => {
    expect(hitTestNodes(nodes, { x: 250, y: 250 })).toBeNull();
  });

  it("落在容差边缘内仍命中（pad 生效）", () => {
    // 距 a 圆心 12：超出半径 10，但在 pad=4 的容差内
    expect(hitTestNodes(nodes, { x: 112, y: 100 }, 4)?.id).toBe("a");
    // 无容差时同样的点应当落空
    expect(hitTestNodes(nodes, { x: 112, y: 100 }, 0)).toBeNull();
  });

  it("重叠区域命中**最近**的那个", () => {
    // 两个大圆深度重叠：点落在哪个圆心更近就选哪个
    const overlapping = [
      { id: "left", x: 100, y: 100, radius: 20 },
      { id: "right", x: 120, y: 100, radius: 20 },
    ];
    // 距 left 4、距 right 16 → left
    expect(hitTestNodes(overlapping, { x: 104, y: 100 })?.id).toBe("left");
    // 距 left 16、距 right 4 → right
    expect(hitTestNodes(overlapping, { x: 116, y: 100 })?.id).toBe("right");
  });

  it("非法坐标返回 null（不抛错）", () => {
    expect(hitTestNodes(nodes, { x: Number.NaN, y: 0 })).toBeNull();
  });
});
