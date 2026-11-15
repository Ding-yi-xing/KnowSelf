// @vitest-environment jsdom
/**
 * M3 波 3 客户端测试：图谱端口错误语义 + 图谱面板四种态 + canvas 力导向实现的可验证部分。
 *
 * 沿用既有做法（`test/m3b-client.test.ts` / `test/profile-panel.test.ts`）：
 *   - 文件是 `.ts`（不是 `.tsx`），组件用 `createElement` 构造；
 *   - 端口用 `vi.stubGlobal('fetch')` 桩，不触网；
 *   - 面板用 jsdom + @testing-library/react 真实渲染。
 *
 * canvas 的处理（关键）：jsdom 不实现 Canvas 2D（`getContext` 返回 null 并打 not-implemented
 * 噪声），因此本文件把 `HTMLCanvasElement.prototype.getContext` 换成一个**记账用**的假上下文：
 *   - 断言「真的调用了 arc / fillText」→ 证明力导向结果真的被绘制，而不只是元素存在；
 *   - 断言 `canvas.width > 0`：把容器 `getBoundingClientRect` 桩成 640×420 后，
 *     画布位图宽度 = CSS 宽度 × dpr（jsdom 的 dpr 恒为 1）→ 640。
 * 真浏览器的像素验收由 `docs/dsh-integration/evidence/m3c-probe.mjs`（Playwright）承担。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createRestGraphPort,
  GRAPH_EMPTY_HINT,
  type GraphPanelPayload,
  type KnowselfGraphPort,
} from "../src/client/graph-port.js";
import { DegradedError, SessionExpiredError } from "../src/client/profile-port.js";
import { GraphPanelView, truncateLabel } from "../src/client/graph-panel.js";
import { layoutGraph, MAX_RENDER_NODES, nodeRadiusByDegree } from "../src/client/graph-layout.js";
import { fitViewport, toScreen } from "../src/client/graph-viewport.js";

/** 一份有数据的图谱响应（2 人 1 边）。 */
function makePayload(): GraphPanelPayload {
  return {
    snapshot: {
      graph_version: "1",
      generated_at: "2026-05-30T00:00:00.000Z",
      node_count: 2,
      edge_count: 1,
      community_count: 1,
      modularity: 0.42,
    },
    nodes: [
      {
        id: "p1",
        label: "张三",
        kind: "person",
        size: 0.8,
        degree: 1,
        isolated: false,
        community_key: "c:aaaa",
        relation_type: "friend",
      },
      {
        id: "p2",
        label: "李四",
        kind: "person",
        size: 0.2,
        degree: 1,
        isolated: false,
        community_key: "c:aaaa",
        relation_type: null,
      },
    ],
    edges: [
      {
        id: "co_presence:p1|p2",
        source: "p1",
        target: "p2",
        kind: "co_presence",
        strength: 0.6,
        directed: false,
      },
    ],
    warnings: [],
  };
}

/** 端口桩：默认返回有数据的响应。 */
function makePort(overrides: Partial<KnowselfGraphPort> = {}): KnowselfGraphPort {
  return {
    getGraph: () => Promise.resolve(makePayload()),
    ...overrides,
  };
}

/** 桩 fetch：返回可控的 { ok, status, json() }（不依赖 jsdom 的 Response）。 */
function stubFetch(body: unknown = null, status = 200) {
  const fn = vi.fn(async (_input: string, _init?: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** 记账用的假 2D 上下文（记录画了多少圆 / 多少线 / 哪些标签）。 */
interface FakeCanvasContext {
  ctx: Record<string, unknown>;
  arcs: Array<{ x: number; y: number; r: number }>;
  moves: number;
  labels: string[];
}

/**
 * 造一个可断言绘制行为的假 2D 上下文。
 * @returns 假上下文与记账数组
 */
function makeFakeCanvasContext(): FakeCanvasContext {
  const arcs: Array<{ x: number; y: number; r: number }> = [];
  const labels: string[] = [];
  const state = { moves: 0 };
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(() => {
      state.moves += 1;
    }),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn((x: number, y: number, r: number) => {
      arcs.push({ x, y, r });
    }),
    fillText: vi.fn((text: string) => {
      labels.push(text);
    }),
  };
  return {
    ctx,
    arcs,
    get moves() {
      return state.moves;
    },
    labels,
  };
}

beforeEach(() => {
  // React 18 act() 需要该标志，避免 "not configured to support act" 噪声。
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // 给面板一个真实的容器尺寸（jsdom 默认全是 0），让画布走「按容器尺寸 + dpr」的真实路径。
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 420,
    top: 0,
    left: 0,
    right: 640,
    bottom: 420,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── A. 端口：URL 拼接 + 错误语义三分 ───────────────────────────────────────

describe("M3C 端口：图谱只读方法的 URL 拼接", () => {
  it("无参 → /knowself-api/graph；带参 → edge_kinds 逗号拼接 + min_interaction", async () => {
    const fetchStub = stubFetch(makePayload());
    const port = createRestGraphPort();

    await port.getGraph();
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/graph");

    await port.getGraph({ edge_kinds: ["mention", "co_presence"], min_interaction: 3 });
    expect(fetchStub.mock.calls[1]![0]).toBe(
      "/knowself-api/graph?edge_kinds=mention%2Cco_presence&min_interaction=3",
    );

    // 只带 min_interaction 时不应出现空的 edge_kinds 参数
    await port.getGraph({ min_interaction: 0 });
    expect(fetchStub.mock.calls[2]![0]).toBe("/knowself-api/graph?min_interaction=0");
  });

  it("200 → 原样透传响应体（含空快照）", async () => {
    stubFetch(makePayload());
    await expect(createRestGraphPort().getGraph()).resolves.toEqual(makePayload());

    const empty: GraphPanelPayload = {
      snapshot: null,
      nodes: [],
      edges: [],
      hint: GRAPH_EMPTY_HINT,
    };
    stubFetch(empty);
    await expect(createRestGraphPort().getGraph()).resolves.toEqual(empty);
  });
});

describe("M3C 端口：错误语义三分（401 / 503 / 其它）", () => {
  it("401 → SessionExpiredError", async () => {
    stubFetch("dsh web authentication required", 401);
    const err = await createRestGraphPort().getGraph().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect((err as Error).message).toBe("会话已失效，请重新打开 dsh web");
  });

  it("503 + 降级体 → DegradedError（携带 reason / layer）", async () => {
    stubFetch({ status: "degraded", reason: "人物层未就绪", layer: "person" }, 503);
    const err = await createRestGraphPort().getGraph().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect((err as DegradedError).reason).toBe("人物层未就绪");
    expect((err as DegradedError).layer).toBe("person");
  });

  it("503 但不是降级体 → 通用 Error（不误报降级）", async () => {
    stubFetch({ nope: true }, 503);
    const err = await createRestGraphPort().getGraph().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DegradedError);
    expect((err as Error).message).toBe("GET /knowself-api/graph → 503");
  });

  it("500 → 通用 Error（含 URL 与状态码）", async () => {
    stubFetch({ error: "boom" }, 500);
    await expect(createRestGraphPort().getGraph()).rejects.toThrow(
      "GET /knowself-api/graph → 500",
    );
  });
});

// ── B. 面板四种态 ──────────────────────────────────────────────────────────

describe("M3C 图谱面板：空快照 / 降级 / 会话失效 / 错误", () => {
  it("空快照：显示 host 给的 hint、**不画空画布**、不是错误", async () => {
    const port = makePort({
      getGraph: () =>
        Promise.resolve({ snapshot: null, nodes: [], edges: [], hint: GRAPH_EMPTY_HINT }),
    });
    const { container } = render(createElement(GraphPanelView, { port }));

    await waitFor(() => expect(screen.getByTestId("graph-empty")).toBeDefined());
    expect(container.textContent).toContain(GRAPH_EMPTY_HINT);
    // 空画布会比任何提示都更容易被误读成「图就是这样」，必须不渲染
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
    expect(container.textContent).not.toContain("数据读取失败");
    expect(container.textContent).not.toContain("数据层未就绪");
    // 统计已从主界面移除（原 graph-stats 不再存在）
    expect(screen.queryByTestId("graph-stats")).toBeNull();
  });

  it("空快照且宿主未给 hint → 回落到内置提示（不显示空白）", async () => {
    const port = makePort({
      getGraph: () => Promise.resolve({ snapshot: null, nodes: [], edges: [] }),
    });
    const { container } = render(createElement(GraphPanelView, { port }));
    await waitFor(() => expect(container.textContent).toContain(GRAPH_EMPTY_HINT));
  });

  it("降级态（503）：显示原因 + 重试按钮，点击后重新取数并画出图", async () => {
    let attempt = 0;
    const getGraph = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new DegradedError("人物层装配失败", "person"));
      return Promise.resolve(makePayload());
    });

    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );

    render(createElement(GraphPanelView, { port: makePort({ getGraph }) }));

    await waitFor(() =>
      expect(screen.getByTestId("graph-panel-degraded").textContent).toContain(
        "数据层未就绪：人物层装配失败",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(getGraph).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("graph-panel-degraded")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("graph-canvas")).toBeDefined());
  });

  it("会话失效（401）：提示重开 dsh web，且**不给**重试按钮", async () => {
    const getGraph = vi.fn(() => Promise.reject(new SessionExpiredError()));
    render(createElement(GraphPanelView, { port: makePort({ getGraph }) }));

    await waitFor(() =>
      expect(screen.getByTestId("graph-panel-session-expired").textContent).toContain(
        "会话已失效，请重新打开 dsh web",
      ),
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("通用错误：显示「数据读取失败：<message>」", async () => {
    const getGraph = vi.fn(() => Promise.reject(new Error("boom-graph")));
    render(createElement(GraphPanelView, { port: makePort({ getGraph }) }));

    await waitFor(() =>
      expect(screen.getByTestId("graph-panel-error").textContent).toContain(
        "数据读取失败：boom-graph",
      ),
    );
  });
});

// ── C. 有数据：canvas 真的被绘制 ────────────────────────────────────────────

describe("M3C 图谱面板：有数据时真实绘制到 canvas", () => {
  it("渲染 canvas 并按容器尺寸 × dpr 设置位图，调用 arc / moveTo / fillText", async () => {
    const fake = makeFakeCanvasContext();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => fake.ctx as unknown as CanvasRenderingContext2D);

    render(createElement(GraphPanelView, { port: makePort() }));

    // 默认「群」模式只有人物节点 → 切「人」模式才会真正绘制
    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    const canvas = (await screen.findByTestId("graph-canvas")) as HTMLCanvasElement;
    await waitFor(() => expect(getContext).toHaveBeenCalled());

    // 位图尺寸：640 x 420（jsdom 的 devicePixelRatio = 1）
    await waitFor(() => expect(canvas.width).toBe(640));
    expect(canvas.height).toBe(420);
    expect(canvas.width).toBeGreaterThan(0);

    // 两个节点 → 两次 arc；一条边 → 一次 moveTo；标签写进画布
    await waitFor(() => expect(fake.arcs.length).toBeGreaterThanOrEqual(2));
    expect(fake.moves).toBeGreaterThanOrEqual(1);
    expect(fake.labels).toEqual(expect.arrayContaining(["张三", "李四"]));
    // 半径来自**度数归一**（关系图谱改造：degree 越高的节点越大；两节点 degree 均为 1 → 同半径 17）
    const radii = fake.arcs.slice(-2).map((arc) => arc.r).sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(nodeRadiusByDegree(1, 1), 5);
    expect(radii[1]).toBeCloseTo(nodeRadiusByDegree(1, 1), 5);
    // 图例只剩颜色含义（2 人 1 社区 → 数无社区 → 按类型上色，显示类型名），不含计数
    expect(screen.getByTestId("graph-legend").textContent).toContain("人物");
    expect(screen.getByTestId("graph-legend").textContent).not.toContain("已绘制");
    // 统计收进 ⚙「统计」小节
    fireEvent.click(screen.getByTestId("graph-settings"));
    const stats = await screen.findByTestId("graph-settings-stats");
    expect(stats.textContent).toContain("共 2 个节点 / 1 条边");
  });

  it("环境不支持 Canvas 2D（getContext 返回 null）→ 如实说明，不崩溃", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    const { container } = render(createElement(GraphPanelView, { port: makePort() }));

    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    await waitFor(() =>
      expect(container.textContent).toContain("当前环境不支持 Canvas 2D 绘制"),
    );
    expect(screen.getByTestId("graph-canvas")).toBeDefined();
  });
});

// ── D. 布局与文案纯函数（确定性 / 边界） ────────────────────────────────────

describe("M3C 力导向布局与标签截断（纯函数）", () => {
  it("世界坐标有限、可由 fit 视口完整呈现、同输入同输出（确定性，不用随机数）", () => {
    const payload = makePayload();
    const input = { nodes: payload.nodes, edges: payload.edges, width: 640, height: 420 };

    const first = layoutGraph(input, { iterations: 60 });
    const second = layoutGraph(input, { iterations: 60 });

    expect(first.nodes).toHaveLength(2);
    expect(first.edges).toHaveLength(1);
    const viewport = fitViewport(first.nodes, { width: 640, height: 420 });
    for (const node of first.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.radius).toBeGreaterThan(0);
      const screenPoint = toScreen(node, viewport);
      expect(screenPoint.x - node.radius * viewport.scale).toBeGreaterThanOrEqual(-0.001);
      expect(screenPoint.x + node.radius * viewport.scale).toBeLessThanOrEqual(640.001);
      expect(screenPoint.y - node.radius * viewport.scale).toBeGreaterThanOrEqual(-0.001);
      expect(screenPoint.y + node.radius * viewport.scale).toBeLessThanOrEqual(420.001);
    }
    expect(viewport.scale).toBeGreaterThan(0);
    expect(second.nodes.map((node) => [node.x, node.y])).toEqual(
      first.nodes.map((node) => [node.x, node.y]),
    );
    // 边的两端坐标与节点坐标一致（绘制不会画出「悬空线」）
    const byId = new Map(first.nodes.map((node) => [node.id, node]));
    const edge = first.edges[0]!;
    expect(edge.x1).toBe(byId.get("p1")!.x);
    expect(edge.y2).toBe(byId.get("p2")!.y);
  });

  it("空输入 / 非法尺寸不产生 NaN，也返回空结果", () => {
    const empty = layoutGraph({ nodes: [], edges: [], width: 0, height: Number.NaN });
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);

    const payload = makePayload();
    const tiny = layoutGraph({
      nodes: payload.nodes,
      edges: payload.edges,
      width: 0,
      height: 0,
    });
    for (const node of tiny.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("超过渲染上限时按上限截断并如实报告 droppedNodes / droppedEdges", () => {
    const payload = makePayload();
    const result = layoutGraph(
      { nodes: payload.nodes, edges: payload.edges, width: 640, height: 420 },
      { maxNodes: 1, iterations: 10 },
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.droppedNodes).toBe(1);
    // 端点被省略的边一并丢弃（否则会画出指向不存在节点的线）
    expect(result.edges).toHaveLength(0);
    expect(result.droppedEdges).toBe(1);
    expect(MAX_RENDER_NODES).toBe(200);
  });

  it("truncateLabel：不超过上限原样返回，超过则按码点截断并加省略号", () => {
    expect(truncateLabel("张三")).toBe("张三");
    // 显式上限 8（默认上限已放宽到 20，好让「群 · 末6位 · N人」完整显示）
    expect(truncateLabel("一二三四五六七八", 8)).toBe("一二三四五六七八");
    expect(truncateLabel("一二三四五六七八九", 8)).toBe("一二三四五六七八…");
    expect(truncateLabel("😀😀😀", 2)).toBe("😀😀…");
  });
});
