// @vitest-environment jsdom
/**
 * C3 安全网：**重构前**先钉住「5 节点 / 14 边」的渲染结果。
 *
 * ## 为什么先写这条
 * `graph-panel.tsx` 要从 391 行拆到 ≤320。纯靠"拆完跑既有测试"不够：
 * 既有 16 条用例覆盖的是**交互与空态**，没有一条盯住"有图时页面上到底长了什么"。
 * 拆分最容易伤到的正是渲染结构（header / toolbar / stage / legend 的分层），
 * 所以先把产物钉死：拆分只许"搬家"，不许改文案、不许改 testid、不许改顺序。
 *
 * ## 断言选择
 * 只断言**用户看得见且文案固定**的东西（stats / legend / 画布 / 控件 testid），
 * 不断言 DOM 层级与内联样式 —— 那些正是本次要动的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GraphEdgeKind } from "@knowself/contracts";
import type { GraphPanelEdge, GraphPanelNode, GraphPanelPayload } from "../src/client/graph-port.js";
import { GraphPanelView } from "../src/client/graph-panel.js";

/** 5 个人物节点（其中一个是「我」）。 */
function nodes(): GraphPanelNode[] {
  return [
    { id: "me", label: "我", kind: "person", size: 0.9, degree: 6, isolated: false, community_key: null, relation_type: null },
    { id: "p-lisi", label: "李四", kind: "person", size: 0.7, degree: 4, isolated: false, community_key: null, relation_type: "friend" },
    { id: "p-wangwu", label: "王五", kind: "person", size: 0.6, degree: 3, isolated: false, community_key: null, relation_type: "colleague" },
    { id: "p-zhaoliu", label: "赵六", kind: "person", size: 0.5, degree: 3, isolated: false, community_key: null, relation_type: "classmate" },
    { id: "group-1", label: "老同学群", kind: "group", size: 0.4, degree: 4, isolated: false, community_key: null, relation_type: null },
  ];
}

/** 14 条边（co_presence / direct_reply 两种，分布贴近真机快照形状）。 */
function edges(): GraphPanelEdge[] {
  const kinds: GraphEdgeKind[] = ["co_presence", "direct_reply"];
  const pairs: [string, string][] = [
    ["me", "p-lisi"],
    ["me", "p-wangwu"],
    ["me", "p-zhaoliu"],
    ["me", "group-1"],
    ["p-lisi", "p-wangwu"],
    ["p-lisi", "p-zhaoliu"],
    ["p-lisi", "group-1"],
    ["p-wangwu", "p-zhaoliu"],
    ["p-wangwu", "group-1"],
    ["p-zhaoliu", "group-1"],
    ["me", "p-lisi"],
    ["me", "group-1"],
    ["p-lisi", "group-1"],
    ["p-wangwu", "group-1"],
  ];
  return pairs.map(([source, target], index) => ({
    id: `e-${index}-${source}-${target}`,
    source,
    target,
    kind: kinds[index % kinds.length] as GraphEdgeKind,
    strength: 0.4 + (index % 5) * 0.1,
    directed: index % 2 === 0,
  }));
}

function makePayload(): GraphPanelPayload {
  const ns = nodes();
  const es = edges();
  return {
    snapshot: {
      graph_version: "1",
      generated_at: "2026-11-12T00:00:00.000Z",
      node_count: ns.length,
      edge_count: es.length,
      community_count: 2,
      modularity: 0.42,
    },
    nodes: ns,
    edges: es,
    warnings: [],
  };
}

/** 挖掘状态桩：有 80 条消息、有快照、14 条边 → 判定树走到第 5 分支（画图）。 */
function miningStub() {
  return {
    getStatus: async () => ({
      has_snapshot: true,
      snapshot_id: "snap-1",
      node_count: 5,
      edge_count: 14,
      chat_message_count: 80,
      chat_conversation_count: 1,
      person_count: 5,
    }),
    run: async () => ({}),
  };
}

/** 记账用假 2D 上下文（jsdom 没有 canvas 实现）。 */
function fakeContext(): CanvasRenderingContext2D {
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    arc: () => {},
    fillText: () => {},
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext());
  // jsdom 没有 ResizeObserver；面板有 typeof 兜底，这里不装也不会崩
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("按社区聚合（视图开关）", () => {
  it("切「人」+ 开启聚合 → 折叠成超节点，并显示「全部社区」面包屑", async () => {
    const communityNodes: GraphPanelNode[] = [
      { id: "a1", label: "甲", kind: "person", size: 0.8, degree: 2, isolated: false, community_key: "c:aaa", relation_type: null },
      { id: "a2", label: "乙", kind: "person", size: 0.6, degree: 2, isolated: false, community_key: "c:aaa", relation_type: null },
      { id: "b1", label: "丙", kind: "person", size: 0.5, degree: 1, isolated: false, community_key: "c:bbb", relation_type: null },
    ];
    const communityEdges: GraphPanelEdge[] = [
      { id: "e1", source: "a1", target: "a2", kind: "co_presence", strength: 1, directed: false },
      { id: "e2", source: "a2", target: "b1", kind: "co_presence", strength: 0.5, directed: false },
    ];
    const payload: GraphPanelPayload = {
      snapshot: {
        graph_version: "graph-v1",
        generated_at: "2026-11-22T00:00:00.000Z",
        node_count: 3,
        edge_count: 2,
        community_count: 2,
        modularity: 0.4,
      },
      nodes: communityNodes,
      edges: communityEdges,
      warnings: [],
    };
    render(
      createElement(GraphPanelView, {
        port: { getGraph: () => Promise.resolve(payload) },
        miningPort: { getStatus: () => Promise.resolve({ chat_message_count: 12, has_snapshot: true }) } as never,
      }),
    );

    // 默认「群」模式无群节点 → 切「人」模式
    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    // 打开 ⚙ 并勾选「按社区聚合」
    fireEvent.click(screen.getByTestId("graph-settings"));
    fireEvent.click(await screen.findByTestId("graph-settings-aggregate-community"));

    // 面包屑：聚合视图顶层
    await waitFor(() =>
      expect(screen.getByTestId("graph-community-breadcrumb").textContent).toContain("全部社区"),
    );
    // 画布只画 2 个超节点（不是 3 个人物）——计数已挪进 ⚙「统计」
    const stats = await screen.findByTestId("graph-settings-stats");
    expect(stats.textContent).toContain("已绘制 2 个节点");
    // 图例只剩色块/颜色含义，不再有「已绘制 …」计数
    expect(screen.getByTestId("graph-legend").textContent).not.toContain("已绘制");
  });
});

describe("C3 安全网：5 节点 / 14 边的渲染产物", () => {
  it("stats / legend / 画布 / 控件四处文案与 testid 全部就位", async () => {
    const port = { getGraph: async () => makePayload() };
    render(createElement(GraphPanelView, { port, miningPort: miningStub() }));

    // ① 主界面不再有 graph-stats（统计已挪进 ⚙）
    expect(screen.queryByTestId("graph-stats")).toBeNull();

    // ② 画布确实画了（有图时不应该出现空态）——默认「群」模式无群外内容，切「人」模式看人物
    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    await waitFor(() => expect(screen.getByTestId("graph-canvas")).toBeDefined());
    expect(screen.queryByTestId("graph-empty")).toBeNull();

    // ③ 图例只留「色点 + 类型名」（数据无社区 → 按类型上色），不含计数/解释句
    const legend = screen.getByTestId("graph-legend");
    expect(legend.textContent).toContain("人物");
    expect(legend.textContent).not.toContain("已绘制");
    expect(legend.textContent).not.toContain("节点颜色");

    // ③b 统计收进 ⚙「统计」小节
    fireEvent.click(screen.getByTestId("graph-settings"));
    const stats = await screen.findByTestId("graph-settings-stats");
    expect(stats.textContent).toContain("共 5 个节点 / 14 条边");
    fireEvent.click(screen.getByTestId("graph-settings-close"));

    // ④ 控件条：默认 1.00×，且没有截断提示
    const controls = screen.getByTestId("graph-controls");
    expect(controls).toBeDefined();
    expect(screen.getByTestId("graph-zoom-level").textContent).toContain("1.00");
    expect(screen.queryByTestId("graph-truncated-tip")).toBeNull();

    // ⑤ 三选一视图模式：群 / 人 / 仅与我直接关系（已替换旧的边类型复选框）
    expect(screen.getByTestId("graph-mode-group")).toBeDefined();
    expect(screen.getByTestId("graph-mode-person")).toBeDefined();
    expect(screen.getByTestId("graph-mode-neighbors")).toBeDefined();
    // 旧复选框已删除
    expect(screen.queryByTestId("graph-only-my-neighbors")).toBeNull();
    expect(screen.queryByTestId("graph-filter-co_presence")).toBeNull();
  });

  it("空态时不该出现 toolbar / canvas / legend（保证拆分后互不影响）", async () => {
    const port = {
      getGraph: async () => ({ snapshot: null, nodes: [], edges: [], hint: "暂无图谱快照" }),
    };
    render(createElement(GraphPanelView, { port, miningPort: miningStub() }));

    await waitFor(() => expect(screen.getByTestId("graph-empty")).toBeDefined());
    expect(screen.queryByTestId("graph-controls")).toBeNull();
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
    expect(screen.queryByTestId("graph-legend")).toBeNull();
  });
});

describe("W-32 回归锁：主界面无诊断批注，统计只在 ⚙ 里", () => {
  it("未展开 ⚙ 时主界面不出现 生成于/已绘制/已显示度数最高/候选/节点过多；展开后 ⚙ 能查到统计", async () => {
    const port = { getGraph: async () => makePayload() };
    render(createElement(GraphPanelView, { port, miningPort: miningStub() }));

    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    await waitFor(() => expect(screen.getByTestId("graph-canvas")).toBeDefined());

    const panel = screen.getByTestId("graph-panel");
    // ⚙ 未展开：主界面不得出现任何"描述系统内部状态/统计/裁剪"的批注
    for (const banned of ["生成于", "已绘制", "已显示度数最高", "候选 ", "节点过多"]) {
      expect(panel.textContent).not.toContain(banned);
    }
    // ⚙ 也没渲染时，统计数据根本不在 DOM 里
    expect(screen.queryByTestId("graph-settings-stats")).toBeNull();

    // 展开 ⚙ → 统计能查到节点数/边数/生成时间
    fireEvent.click(screen.getByTestId("graph-settings"));
    const stats = await screen.findByTestId("graph-settings-stats");
    expect(stats.textContent).toContain("已绘制");
    expect(stats.textContent).toContain("个节点");
    expect(stats.textContent).toContain("条边");
    expect(stats.textContent).toContain("生成于");
  });
});

/**
 * 图例「单聊」：W29 末位追加的 direct（单聊会话）节点类型，图例（按类型上色时）必须
 * 显示 `单聊` 这一项，与 人物/群/话题 并列。数据里放一个 direct 节点、community_key 为空
 * → 不触发社区聚合（按类型上色），图例走类型名分支。
 */
describe("图例：含 direct 节点的数据 → 显示「单聊」", () => {
  const directPayload: GraphPanelPayload = {
    snapshot: {
      graph_version: "1",
      generated_at: "2026-11-12T00:00:00.000Z",
      node_count: 2,
      edge_count: 1,
      community_count: 1,
      modularity: 0.3,
    },
    nodes: [
      { id: "me", label: "我", kind: "person", size: 0.9, degree: 1, isolated: false, community_key: null, relation_type: null },
      { id: "c-direct", label: "单聊会话", kind: "direct", size: 0.5, degree: 1, isolated: false, community_key: null, relation_type: null },
    ],
    edges: [
      { id: "e1", source: "me", target: "c-direct", kind: "co_presence", strength: 0.5, directed: false },
    ],
    warnings: [],
  };

  it("切「人」模式（含 direct 节点）→ 图例文本包含「单聊」", async () => {
    const port = { getGraph: async () => directPayload };
    render(createElement(GraphPanelView, { port, miningPort: miningStub() }));

    // 默认「群」模式无群节点 → 切「人」模式（保留 person + direct）
    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    await waitFor(() => expect(screen.getByTestId("graph-canvas")).toBeDefined());

    const legend = screen.getByTestId("graph-legend");
    expect(legend.textContent).toContain("单聊");
  });
});
