/**
 * 关系图谱改造（Obsidian Graph View）的**纯函数**测试。
 *
 * 覆盖：设置夹紧 / 力参数映射、节点度数半径、社区配色、过滤（搜索 / 孤儿 / 已建档）、
 * 局部图谱 N 层邻居。全部不碰 DOM / canvas，node 环境直跑。
 */
import { describe, expect, it, vi } from "vitest";
import { communityColor, UNGROUPED_COLOR } from "../src/client/graph-colors.js";
import { layoutGraph, nodeRadiusByDegree } from "../src/client/graph-layout.js";
import { drawGraph } from "../src/client/graph-canvas.js";
import {
  DEFAULT_GRAPH_SETTINGS,
  clampGraphSettings,
  layoutOptionsFromSettings,
} from "../src/client/graph-settings.js";
import {
  applyGraphFilters,
  applySearchFilter,
  buildLocalGraph,
  dropIsolated,
  filterByMode,
} from "../src/client/graph-subgraph.js";
import type { GraphPanelEdge, GraphPanelNode } from "../src/client/graph-port.js";

/** 造节点。 */
function node(id: string, overrides: Partial<GraphPanelNode> = {}): GraphPanelNode {
  return {
    id,
    label: id,
    kind: "person",
    size: 0.5,
    degree: 1,
    isolated: false,
    community_key: null,
    relation_type: null,
    ...overrides,
  };
}

/** 造边。 */
function edge(source: string, target: string, strength = 1): GraphPanelEdge {
  return { id: `${source}-${target}`, source, target, kind: "co_presence", strength, directed: false };
}

describe("clampGraphSettings（防御脏值）", () => {
  it("越界 / NaN 都被夹回合法区间", () => {
    const dirty = clampGraphSettings({
      ...DEFAULT_GRAPH_SETTINGS,
      nodeSizeScale: 99,
      linkDistance: Number.NaN,
      localDepth: 9.7,
    });
    expect(dirty.nodeSizeScale).toBe(10);
    expect(dirty.linkDistance).toBe(10);
    expect(dirty.localDepth).toBe(5);
  });

  it("布尔开关用显式默认（缺省不丢原语义）", () => {
    const s = clampGraphSettings({ ...DEFAULT_GRAPH_SETTINGS, showOrphans: false, showLabels: false, onlyProfiled: true });
    expect(s.showOrphans).toBe(false);
    expect(s.showLabels).toBe(true);
    expect(s.onlyProfiled).toBe(true);
  });
});

describe("layoutOptionsFromSettings（力学滑杆 → 布局参数）", () => {
  it("缺省滑杆映射到稳定可复现的力参数（斥力已上调一档）", () => {
    const opts = layoutOptionsFromSettings(DEFAULT_GRAPH_SETTINGS);
    expect(opts.centerStrength).toBeCloseTo(0.03);
    expect(opts.repulsion).toBeCloseTo(1.25);
    expect(opts.linkStrength).toBeCloseTo(0.8);
    expect(opts.linkDistance).toBe(120);
    expect(opts.nodeSizeScale).toBeCloseTo(1);
  });
});

describe("nodeRadiusByDegree（节点大小 ∝ 度数）", () => {
  it("度数越高半径越大；0 度给最小可见半径", () => {
    expect(nodeRadiusByDegree(0, 10)).toBe(3);
    expect(nodeRadiusByDegree(1, 10)).toBeGreaterThan(3);
    expect(nodeRadiusByDegree(10, 10)).toBeGreaterThan(nodeRadiusByDegree(5, 10));
    expect(nodeRadiusByDegree(10, 10)).toBeCloseTo(17, 5);
  });

  it("maxDegree 非法时退化为 1，不产生 NaN", () => {
    expect(Number.isFinite(nodeRadiusByDegree(3, 0))).toBe(true);
    expect(Number.isFinite(nodeRadiusByDegree(Number.NaN, 4))).toBe(true);
  });
});

describe("layoutGraph（世界坐标与碰撞间距）", () => {
  it("节点数量增加时扩展世界面积，而不是固定压在 viewport 两倍范围内", async () => {
    const { layoutGraph } = await import("../src/client/graph-layout.js");
    const nodes = Array.from({ length: 80 }, (_, i) => node(`n-${i}`, { degree: 2 }));
    const result = layoutGraph({ nodes, edges: [], width: 640, height: 420 }, { iterations: 80 });
    const spanX = Math.max(...result.nodes.map((item) => item.x)) - Math.min(...result.nodes.map((item) => item.x));
    const spanY = Math.max(...result.nodes.map((item) => item.y)) - Math.min(...result.nodes.map((item) => item.y));
    expect(spanX).toBeGreaterThan(640);
    expect(spanY).toBeGreaterThan(420);
    expect(result.nodes.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
  });

  it("确定性地保持不同节点之间的安全间距", async () => {
    const { layoutGraph } = await import("../src/client/graph-layout.js");
    const nodes = Array.from({ length: 18 }, (_, i) => node(`collision-${i}`, { degree: 4 }));
    const spacingOptions = { iterations: 160, repulsion: 0, linkStrength: 0, centerStrength: 0 };
    const first = layoutGraph({ nodes, edges: [], width: 320, height: 240 }, spacingOptions);
    const second = layoutGraph({ nodes, edges: [], width: 320, height: 240 }, spacingOptions);
    expect(second.nodes).toEqual(first.nodes);
    for (let i = 0; i < first.nodes.length; i += 1) {
      for (let j = i + 1; j < first.nodes.length; j += 1) {
        const a = first.nodes[i]!;
        const b = first.nodes[j]!;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        expect(distance).toBeGreaterThanOrEqual(a.radius + b.radius + 36);
      }
    }
  });
});

describe("drawGraph（节点身份始终可见）", () => {
  it("忽略旧调用方的 showLabels=false，仍绘制节点名称", () => {
    const fillText = vi.fn();
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText,
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      style: {},
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const layout = layoutGraph({ nodes: [node("named", { label: "姓名不可隐藏" })], edges: [], width: 320, height: 240 });

    expect(drawGraph(canvas, layout, 320, 240, { showLabels: false })).toBe(true);
    expect(fillText).toHaveBeenCalledWith("姓名不可隐藏", expect.any(Number), expect.any(Number));
  });
});

describe("communityColor（按社区上色）", () => {
  it("未分组（null）→ 灰；同键同色；不同键可能不同", () => {
    expect(communityColor(null)).toBe(UNGROUPED_COLOR);
    expect(communityColor(undefined)).toBe(UNGROUPED_COLOR);
    expect(communityColor("c:aaa")).toBe(communityColor("c:aaa"));
  });
});

describe("applyGraphFilters（过滤组）", () => {
  const nodes = [
    node("me", { label: "我", degree: 3 }),
    node("p-zhang", { label: "张三", degree: 2, community_key: "c:a" }),
    node("p-li", { label: "李四", degree: 1, community_key: "c:a" }),
    node("g-1", { label: "老同学群", kind: "group", degree: 1, isolated: true }),
    node("t-1", { label: "项目", kind: "topic", degree: 0, isolated: true }),
  ];
  const edges = [
    edge("me", "p-zhang"),
    edge("me", "p-li"),
    edge("p-zhang", "p-li"),
  ];

  it("默认设置（showOrphans=false）会清掉孤立节点", () => {
    const out = applyGraphFilters(nodes, edges, DEFAULT_GRAPH_SETTINGS);
    expect(out.nodes.some((n) => n.isolated)).toBe(false);
    expect(out.nodes).toHaveLength(3);
  });

  it("showOrphans=true → 保留孤立节点（原样）", () => {
    const out = applyGraphFilters(nodes, edges, { ...DEFAULT_GRAPH_SETTINGS, showOrphans: true });
    expect(out.nodes).toHaveLength(nodes.length);
    expect(out.edges).toHaveLength(edges.length);
  });

  it("搜索「张三」→ 命中节点 + 其直接邻居", () => {
    const out = applySearchFilter(nodes, edges, "张三");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["me", "p-li", "p-zhang"].sort());
    expect(out.edges.map((e) => e.id).sort()).toEqual(["me-p-li", "me-p-zhang", "p-zhang-p-li"].sort());
  });

  it("搜索无命中 → 空子图（不假装全画）", () => {
    const out = applySearchFilter(nodes, edges, "不存在的名字");
    expect(out.nodes).toHaveLength(0);
    expect(out.edges).toHaveLength(0);
  });

  it("只显示已建档 → 去掉 group / topic", () => {
    const out = applyGraphFilters(nodes, edges, { ...DEFAULT_GRAPH_SETTINGS, onlyProfiled: true });
    expect(out.nodes.every((n) => n.kind === "person")).toBe(true);
    expect(out.edges).toHaveLength(3);
  });

  it("关闭孤儿 → 去掉 isolated 节点", () => {
    const out = applyGraphFilters(nodes, edges, { ...DEFAULT_GRAPH_SETTINGS, showOrphans: false });
    expect(out.nodes.some((n) => n.isolated)).toBe(false);
    expect(out.nodes).toHaveLength(3);
  });
});

describe("buildLocalGraph（局部图谱 N 层邻居）", () => {
  // 链：a - b - c - d（a 为中心，深度 2 应到 c）
  const nodes = ["a", "b", "c", "d"].map((id) => node(id));
  const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

  it("深度 1 只取中心 + 直接邻居", () => {
    const out = buildLocalGraph(nodes, edges, "a", 1);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(out.edges).toHaveLength(1);
  });

  it("深度 2 取到第二层", () => {
    const out = buildLocalGraph(nodes, edges, "a", 2);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(out.edges).toHaveLength(2);
  });

  it("中心不存在 → 空子图（调用方据此兜底）", () => {
    expect(buildLocalGraph(nodes, edges, "nope", 2).nodes).toHaveLength(0);
  });

  it("深度越界按 1 夹紧", () => {
    const out = buildLocalGraph(nodes, edges, "a", 0);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });
});

describe("filterByMode（三选一模式过滤）", () => {
  const nodes = [
    node("me", { label: "我", kind: "person", degree: 3 }),
    node("p2", { label: "李四", kind: "person", degree: 2 }),
    node("d1", { label: "单聊A", kind: "direct", degree: 1 }),
    node("g1", { label: "篮球群", kind: "group", degree: 1 }),
    node("t1", { label: "话题", kind: "topic", degree: 1 }),
  ];
  const edges = [
    edge("me", "p2"),
    edge("me", "d1"),
    edge("p2", "d1"),
    edge("me", "g1"),
    // 真实群聊链路：membership（g1 有成员 me / p2），用于派生群-群共同成员边
    { id: "m1", source: "g1", target: "me", kind: "membership", strength: 0.5, directed: false },
    { id: "m2", source: "g1", target: "p2", kind: "membership", strength: 0.5, directed: false },
  ];

  it("group 模式 → 只留 group 节点（真实群聊）", () => {
    const out = filterByMode(nodes, edges, "group", 1);
    expect(out.nodes.map((n) => n.id)).toEqual(["g1"]);
  });

  it("person 模式 → 只留 person + direct", () => {
    const out = filterByMode(nodes, edges, "person", 1);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["d1", "me", "p2"]);
    expect(out.nodes.some((n) => n.kind === "group" || n.kind === "topic")).toBe(false);
  });

  it("neighbors 模式 → person 中以「我」为中心的 N 层邻居，且**只留我与邻居的边**", () => {
    // 加一条「邻居彼此之间」的边：p2-d1（neighbors 模式不应画它）
    const out = filterByMode(nodes, edges, "neighbors", 1);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["d1", "me", "p2"]);
    // 只保留 me 相关的边：me-p2、me-d1；不含 p2-d1
    expect(out.edges.every((e) => e.source === "me" || e.target === "me")).toBe(true);
    expect(out.edges.map((e) => e.id).sort()).toEqual(["me-d1", "me-p2"].sort());
  });
});

describe("group 模式：数字群名转可读占位", () => {
  it("纯数字 / @chatroom 群名 → 「群 · 末6位 · N人」，真实群名原样", () => {
    const nodes = [
      node("g-num", { kind: "group", label: "123456789" }),
      node("g-raw", { kind: "group", label: "篮球群" }),
      node("p1", { kind: "person" }),
      node("p2", { kind: "person" }),
    ];
    const edges = [
      { id: "m1", source: "g-num", target: "p1", kind: "membership" as const, strength: 1, directed: false },
      { id: "m2", source: "g-num", target: "p2", kind: "membership" as const, strength: 1, directed: false },
    ];
    const out = filterByMode(nodes, edges, "group", 1);
    const gNum = out.nodes.find((n) => n.id === "g-num");
    const gRaw = out.nodes.find((n) => n.id === "g-raw");
    expect(gNum?.label).toBe("群 · 456789 · 2人");
    expect(gNum?.title).toBe("123456789");
    expect(gRaw?.label).toBe("篮球群"); // 真实名原样
  });
});

describe("径向布局：中心必须是「我」", () => {
  it("radialCenterId='me' → me 落在世界坐标中心", () => {
    const nodes = [
      node("me", { label: "我", degree: 3 }),
      node("a", { degree: 1 }),
      node("b", { degree: 2 }),
      node("c", { degree: 1 }),
    ];
    const edges = [edge("me", "a"), edge("me", "b"), edge("me", "c")];
    const out = layoutGraph(
      { nodes, edges, width: 640, height: 420 },
      { radialCenterId: "me" },
    );
    const me = out.nodes.find((n) => n.id === "me");
    expect(me).toBeDefined();
    expect(Math.abs(me!.x - 640)).toBeLessThan(1);
    expect(Math.abs(me!.y - 420)).toBeLessThan(1);
  });
});

describe("dropIsolated（去诱导度 0 的散点）", () => {
  it("按给定边集重算度数，清掉孤立节点", () => {
    const nodes = [
      node("a", { degree: 1 }),
      node("b", { degree: 1 }),
      node("c", { degree: 0 }), // 诱导度数也是 0
    ];
    const edges = [edge("a", "b")];
    const out = dropIsolated(nodes, edges);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("边全被过滤 → 节点全清空（不留空白散点）", () => {
    const out = dropIsolated([node("x"), node("y")], []);
    expect(out.nodes).toHaveLength(0);
  });
});
