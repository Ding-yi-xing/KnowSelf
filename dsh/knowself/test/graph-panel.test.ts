// @vitest-environment jsdom
/**
 * W-2 图谱面板交互测试（jsdom，真实 React 渲染，无网络、无真实 canvas）。
 *
 * canvas 走既有做法：把 `HTMLCanvasElement.prototype.getContext` 换成记账用假上下文，
 * 并且**专门有一条用例把 `getContext` 打成 `null`**（模拟 jsdom 未装 canvas 包），
 * 断言面板不抛错、如实显示「当前环境不支持 Canvas 2D 绘制」。
 *
 * 覆盖：
 *   ① canvas 不可用不抛错；
 *   ② 无快照 → 空态 hint、不画空画布；
 *   ③ `onSelectPerson` 未传时不崩；
 *   ④ 点击人物节点 → 回调拿到 person_id；
 *   ⑤ 滚轮缩放 → 缩放档位读得出来；
 *   ⑥ 拖拽平移 → 同一屏幕位置不再命中原来那个节点；
 *   ⑦ 勾选边类型 → 带 `edge_kinds` 重新取数 + URL 出现该参数；
 *   ⑧ 节点数命中上限 → 显示截断提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GRAPH_EMPTY_HINT, type GraphPanelPayload } from "../src/client/graph-port.js";
import { GraphPanelView } from "../src/client/graph-panel.js";
import { layoutGraph, MAX_RENDER_NODES } from "../src/client/graph-layout.js";
import { DEFAULT_GRAPH_SETTINGS, layoutOptionsFromSettings } from "../src/client/graph-settings.js";
import { fitViewport, toScreen, zoomAt } from "../src/client/graph-viewport.js";
import { BUTTON_ZOOM, ZOOM_STEP } from "../src/client/graph-interactions.js";

/** 挖掘状态桩：status 为 null 表示「状态端点不可用」（判定树退化到只看 graph）。 */
function miningStub(status: { chat_message_count: number; has_snapshot: boolean } | null, run = vi.fn(async () => ({}))) {
  return {
    getStatus: async () => ({
      has_snapshot: status?.has_snapshot ?? false,
      snapshot_id: null,
      node_count: 0,
      edge_count: 0,
      chat_message_count: status?.chat_message_count ?? 0,
      chat_conversation_count: 0,
      person_count: 1,
    }),
    run,
  };
}

/** 2 个人物 + 1 条边（与 m3c 用例同形状，便于复用直觉）。 */
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
        community_key: "c:1",
        relation_type: "friend",
      },
      {
        id: "p2",
        label: "李四",
        kind: "person",
        size: 0.2,
        degree: 1,
        isolated: false,
        community_key: "c:1",
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

/** 记账用假 2D 上下文（只实现绘制路径用到的方法）。 */
function makeFakeCanvasContext() {
  const arcs: Array<{ x: number; y: number; r: number }> = [];
  const labels: string[] = [];
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
    moveTo: vi.fn(),
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
  return { ctx, arcs, labels };
}

function expectedPersonLayout() {
  const payload = makePayload();
  return layoutGraph(
    { nodes: payload.nodes, edges: payload.edges, width: 640, height: 420 },
    { maxNodes: 200, ...layoutOptionsFromSettings(DEFAULT_GRAPH_SETTINGS) },
  );
}

function expectedPersonViewport() {
  return fitViewport(expectedPersonLayout().nodes, { width: 640, height: 420 });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // 容器尺寸（jsdom 默认全 0，会让面板永远不画）
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
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("W-2 图谱面板：无 canvas / 无快照 / 无回调", () => {
  it("canvas 不可用（getContext 返回 null）→ 不抛错，显示不支持说明", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    const port = { getGraph: () => Promise.resolve(makePayload()) };
    const { container } = render(createElement(GraphPanelView, { port, miningPort: miningStub({ chat_message_count: 69, has_snapshot: false }) }));

    // 默认「群」模式在只有人物节点的数据里没有群 → 切到「人」模式才会有节点绘制
    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    await waitFor(() =>
      expect(container.textContent).toContain("当前环境不支持 Canvas 2D 绘制"),
    );
    expect(screen.getByTestId("graph-canvas")).toBeDefined();
  });

  it("无快照 → 显示宿主 hint、不渲染画布", async () => {
    const port = {
      getGraph: () => Promise.resolve({ snapshot: null, nodes: [], edges: [], hint: GRAPH_EMPTY_HINT }),
    };
    // 状态端点不可用（statusUnknown）→ 才退回宿主 hint；
    // 「确定 0 条消息」的分支 1 有专门文案（指向导入），见下一条用例。
    const failingStatus = {
      getStatus: async () => {
        throw new Error("status down");
      },
      run: async () => ({}),
    };
    const { container } = render(
      createElement(GraphPanelView, { port, miningPort: failingStatus as never }),
    );

    await waitFor(() => expect(screen.getByTestId("graph-empty")).toBeDefined());
    expect(container.textContent).toContain(GRAPH_EMPTY_HINT);
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
    // 统计已从主界面移除（原 graph-stats 不再存在）→ 主界面不应再出现该 testid
    expect(screen.queryByTestId("graph-stats")).toBeNull();
    // 成因标签：0 条消息 → no-data（分支 1）
    expect(screen.getByTestId("graph-empty").getAttribute("data-empty-kind")).toBe("no-data");
  });

  /**
   * W-9 裁定：**「挖过了但没有第三方」不能与「还没挖过」共用一句话**。
   * 前者若还提示「去让助手挖掘」，用户会反复挖、反复空。
   */
  it("有快照但 0 条边 → 如实说明「只有你与助手的对话」，不提示去挖掘", async () => {
    const port = {
      getGraph: () =>
        Promise.resolve({
          snapshot: {
            graph_version: "1",
            generated_at: "2026-11-12T02:00:00.000Z",
            node_count: 1,
            edge_count: 0,
            community_count: 0,
            modularity: 0,
          },
          nodes: [
            {
              id: "me",
              label: "我",
              kind: "person" as const,
              size: 0.5,
              degree: 0,
              isolated: true,
              community_key: null,
              relation_type: null,
            },
          ],
          edges: [],
        }),
    };
    const { container } = render(createElement(GraphPanelView, { port, miningPort: miningStub({ chat_message_count: 69, has_snapshot: false }) }));

    const empty = await screen.findByTestId("graph-empty");
    expect(empty.getAttribute("data-empty-kind")).toBe("no-relations");
    expect(container.textContent).toContain("没有第三方参与者");
    expect(container.textContent).toContain("导入含他人参与的聊天记录后可生成关系图");
    // 事实行：1 个节点 / 0 条边
    expect(screen.getByTestId("graph-empty-facts").textContent).toContain("1 个节点 / 0 条边");
    // 不许再引导「先去挖掘」——挖掘已经做过了
    expect(container.textContent).not.toContain("先在对话里让助手执行一次挖掘");
    // 也不画只有孤点的画布
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
  });

  /** 分支 1（判定树最外层）：库里一条消息都没有 → 引导去导入。 */
  it("chat_message_count === 0 → no-data：引导导入，且**不**显示「开始挖掘」", async () => {
    const port = { getGraph: () => Promise.resolve({ snapshot: null, nodes: [], edges: [], hint: GRAPH_EMPTY_HINT }) };
    render(createElement(GraphPanelView, { port, miningPort: miningStub({ chat_message_count: 0, has_snapshot: false }) }));

    const empty = await screen.findByTestId("graph-empty");
    await waitFor(() => expect(empty.getAttribute("data-empty-kind")).toBe("no-data"));
    expect(screen.queryByTestId("graph-run-mining")).toBeNull();
  });

  /** 分支 2：有消息但没挖过 → 给「开始挖掘」按钮；点它要真的调挖掘端口。 */
  it("有消息但无快照 → not-mined：显示「开始挖掘」，点击调用挖掘端口", async () => {
    const run = vi.fn(async () => ({ snapshot_id: "s1", nodes: 1, edges: 0, persons: 1, scopes: 1, warnings: [] }));
    const port = { getGraph: () => Promise.resolve({ snapshot: null, nodes: [], edges: [], hint: GRAPH_EMPTY_HINT }) };
    render(
      createElement(GraphPanelView, {
        port,
        miningPort: miningStub({ chat_message_count: 80, has_snapshot: false }, run),
      }),
    );

    const empty = await screen.findByTestId("graph-empty");
    await waitFor(() => expect(empty.getAttribute("data-empty-kind")).toBe("not-mined"));

    const button = await screen.findByTestId("graph-run-mining");
    expect(button.textContent).toBe("开始挖掘");
    fireEvent.click(button);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  /** 挖掘失败要能看见（不静默）。 */
  it("挖掘失败 → 显示失败提示", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const port = { getGraph: () => Promise.resolve({ snapshot: null, nodes: [], edges: [], hint: GRAPH_EMPTY_HINT }) };
    render(
      createElement(GraphPanelView, {
        port,
        miningPort: miningStub({ chat_message_count: 80, has_snapshot: false }, run),
      }),
    );

    fireEvent.click(await screen.findByTestId("graph-run-mining"));
    const err = await screen.findByTestId("graph-mining-error");
    expect(err.textContent).toContain("boom");
  });

  it("有快照但 0 个节点 → 第三种成因（no-nodes）", async () => {
    const port = {
      getGraph: () =>
        Promise.resolve({
          snapshot: {
            graph_version: "1",
            generated_at: "2026-11-12T02:00:00.000Z",
            node_count: 0,
            edge_count: 0,
            community_count: 0,
            modularity: 0,
          },
          nodes: [],
          edges: [],
        }),
    };
    const { container } = render(createElement(GraphPanelView, { port, miningPort: miningStub({ chat_message_count: 69, has_snapshot: false }) }));

    const empty = await screen.findByTestId("graph-empty");
    expect(empty.getAttribute("data-empty-kind")).toBe("no-nodes");
    expect(container.textContent).toContain("快照里没有可展示的节点");
  });

  it("onSelectPerson 未传时点击画布不崩", async () => {
    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );
    const port = { getGraph: () => Promise.resolve(makePayload()) };
    render(createElement(GraphPanelView, { port, miningPort: miningStub({ chat_message_count: 69, has_snapshot: false }) }));

    const wrap = await screen.findByTestId("graph-canvas-wrap");
    // 点哪儿都行——没有回调时应当静默，不抛错
    expect(() => fireEvent.click(wrap, { clientX: 10, clientY: 10 })).not.toThrow();
  });
});

describe("W-2 图谱面板：点击人物节点", () => {
  /** 用与面板「人」模式完全相同的入参复算布局（input 与 options 分两个参数），拿到确定性坐标。 */
  function expectedLayout() {
    const payload = makePayload();
    return layoutGraph(
      { nodes: payload.nodes, edges: payload.edges, width: 640, height: 420 },
      { maxNodes: 200, ...layoutOptionsFromSettings(DEFAULT_GRAPH_SETTINGS) },
    );
  }

  function expectedViewport() {
    return fitViewport(expectedLayout().nodes, { width: 640, height: 420 });
  }

  it("点击人物节点 → onSelectPerson(person_id)", async () => {
    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );
    const onSelectPerson = vi.fn();
    const port = { getGraph: () => Promise.resolve(makePayload()) };
    render(createElement(GraphPanelView, { port, onSelectPerson }));

    // 默认「群」模式无群节点 → 切「人」模式才有节点
    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    const wrap = await screen.findByTestId("graph-canvas-wrap");
    await waitFor(() => expect(fake.arcs.length).toBeGreaterThanOrEqual(2));
    const node = expectedLayout().nodes[0]!;
    const screenPoint = toScreen(node, expectedViewport());

    fireEvent.click(wrap, { clientX: screenPoint.x, clientY: screenPoint.y });

    expect(onSelectPerson).toHaveBeenCalledWith(node.id);
  });

  it("点在空白处 → 不触发回调", async () => {
    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );
    const onSelectPerson = vi.fn();
    render(createElement(GraphPanelView, { port: { getGraph: () => Promise.resolve(makePayload()) }, onSelectPerson }));

    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    const wrap = await screen.findByTestId("graph-canvas-wrap");
    fireEvent.click(wrap, { clientX: 2, clientY: 2 });

    expect(onSelectPerson).not.toHaveBeenCalled();
  });
});

describe("W-2 图谱面板：缩放与平移", () => {
  it("滚轮向下 → 按当前 fit 视口缩小一档", async () => {
    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );
    render(createElement(GraphPanelView, { port: { getGraph: () => Promise.resolve(makePayload()) } }));

    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    const wrap = await screen.findByTestId("graph-canvas-wrap");
    const initialViewport = expectedPersonViewport();
    expect(screen.getByTestId("graph-zoom-level").textContent).toBe(`${initialViewport.scale.toFixed(2)}×`);

    fireEvent(wrap, new WheelEvent("wheel", { deltaY: 100, clientX: 300, clientY: 200, bubbles: true, cancelable: true }));

    const expected = zoomAt(initialViewport, { x: 300, y: 200 }, 1 / ZOOM_STEP);
    await waitFor(() =>
      expect(screen.getByTestId("graph-zoom-level").textContent).toBe(`${expected.scale.toFixed(2)}×`),
    );
  });

  it("缩放按钮：缩小后重置回到 fit 结果", async () => {
    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );
    render(createElement(GraphPanelView, { port: { getGraph: () => Promise.resolve(makePayload()) } }));

    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    await screen.findByTestId("graph-canvas-wrap");
    const initialViewport = expectedPersonViewport();
    const expectedZoomOut = zoomAt(initialViewport, { x: 320, y: 210 }, 1 / BUTTON_ZOOM);
    fireEvent.click(screen.getByTestId("graph-zoom-out"));
    await waitFor(() =>
      expect(screen.getByTestId("graph-zoom-level").textContent).toBe(`${expectedZoomOut.scale.toFixed(2)}×`),
    );

    fireEvent.click(screen.getByTestId("graph-reset"));
    await waitFor(() =>
      expect(screen.getByTestId("graph-zoom-level").textContent).toBe(`${initialViewport.scale.toFixed(2)}×`),
    );
  });

  it("拖拽平移 → 原屏幕位置的节点不再命中，偏移后的位置命中", async () => {
    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );
    const onSelectPerson = vi.fn();
    render(
      createElement(GraphPanelView, {
        port: { getGraph: () => Promise.resolve(makePayload()) },
        onSelectPerson,
      }),
    );

    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    const wrap = await screen.findByTestId("graph-canvas-wrap");
    const node = layoutGraph(
      { nodes: makePayload().nodes, edges: makePayload().edges, width: 640, height: 420 },
      { maxNodes: 200, ...layoutOptionsFromSettings(DEFAULT_GRAPH_SETTINGS) },
    ).nodes[0]!;
    const screenPoint = toScreen(node, expectedPersonViewport());

    // 拖拽 120px（超过 3px 阈值 → 判定为拖拽，不触发点击）
    // jsdom 没有 PointerEvent（实测 typeof === 'undefined'），用 MouseEvent 造同名事件，
    // 这样 clientX/clientY 才是真的——否则拖拽阈值判定拿到 NaN，拖了等于没拖。
    fireEvent(wrap, new MouseEvent('pointerdown', { clientX: screenPoint.x, clientY: screenPoint.y, bubbles: true }));
    fireEvent(wrap, new MouseEvent('pointermove', { clientX: screenPoint.x + 120, clientY: screenPoint.y, bubbles: true }));
    fireEvent(wrap, new MouseEvent('pointerup', { clientX: screenPoint.x + 120, clientY: screenPoint.y, bubbles: true }));
    expect(onSelectPerson).not.toHaveBeenCalled();

    // 原点位已无节点
    fireEvent.click(wrap, { clientX: screenPoint.x, clientY: screenPoint.y });
    expect(onSelectPerson).not.toHaveBeenCalled();

    // 偏移 120px 后命中同一节点
    fireEvent.click(wrap, { clientX: screenPoint.x + 120, clientY: screenPoint.y });
    expect(onSelectPerson).toHaveBeenCalledWith(node.id);
  });
});

describe("W-2 图谱面板：截断统计（已挪进 ⚙）", () => {
  it("节点数命中渲染上限 → 截断计数在 ⚙「统计」里（主界面不再有截断提示条）", async () => {
    const fake = makeFakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D,
    );

    // 链式连边：所有节点诱导度数 > 0，不会被「默认不画孤立节点」清掉，从而真正触发渲染上限截断。
    const total = MAX_RENDER_NODES + 5;
    const many = {
      snapshot: {
        graph_version: "1",
        generated_at: "2026-05-30T00:00:00.000Z",
        node_count: total,
        edge_count: total - 1,
        community_count: 1,
        modularity: 0.1,
      },
      nodes: Array.from({ length: total }, (_, i) => ({
        id: `p${i}`,
        label: `人${i}`,
        kind: "person" as const,
        size: 0.5,
        degree: 2,
        isolated: false,
        community_key: null,
        relation_type: null,
      })),
      edges: Array.from({ length: total - 1 }, (_, i) => ({
        id: `e${i}`,
        source: `p${i}`,
        target: `p${i + 1}`,
        kind: "co_presence" as const,
        strength: 0.5,
        directed: false,
      })),
    };

    render(createElement(GraphPanelView, { port: { getGraph: () => Promise.resolve(many) }, miningPort: miningStub({ chat_message_count: 69, has_snapshot: true }) }));

    // 默认「群」模式无群节点 → 切「人」模式；205 人 > 200 → 触发截断
    fireEvent.click(await screen.findByTestId("graph-mode-person"));
    // 主界面不再有截断提示条
    expect(screen.queryByTestId("graph-truncated-tip")).toBeNull();
    // 截断计数收进 ⚙「统计」
    fireEvent.click(screen.getByTestId("graph-settings"));
    const stats = await screen.findByTestId("graph-settings-stats");
    expect(stats.textContent).toContain(`已绘制 ${MAX_RENDER_NODES} 个节点`);
    expect(stats.textContent).toContain("超出渲染上限");
  });
});
