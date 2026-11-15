// @vitest-environment jsdom
/**
 * 能力视图面板集成测试（T05，0.5.0）。
 *
 * 覆盖：切到能力视图渲染节点数 / 空态「去待整理」/ 点节点出详情且含证据片段 /
 * **切走再切回筛选保留** / ⚙ 在能力视图下不含「按社区聚合」等专属项。
 *
 * 渲染方式与既有图谱测试一致（createElement + @testing-library/react + 桩端口 + 640×420 容器）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AbilitySnapshot } from "@knowself/contracts";
import type { GraphPanelPayload } from "../src/client/graph-port.js";
import type { AbilitySnapshotResponse, KnowselfAbilityPort } from "../src/client/ability-graph-port.js";
import { DEFAULT_GRAPH_SETTINGS } from "../src/client/graph-settings.js";
import { layoutAbilityGraph } from "../src/client/ability-layout.js";
import { fitViewport, toScreen } from "../src/client/graph-viewport.js";
import { GraphPanelView, abilityToPanelEdge, abilityToPanelNode } from "../src/client/graph-panel.js";

/** 一个含 2 个能力节点 / 1 条边的能力快照（ability:1 带证据原文）。 */
const ABILITY: AbilitySnapshot = {
  graph_version: "ability-graph-v1",
  produced_by: "knowself:ability-rule-v1",
  generated_at: "2026-11-13T14:00:00+08:00",
  fingerprint: "a".repeat(40),
  stats: { node_count: 2, edge_count: 1, card_count: 1, source_count: 1 },
  nodes: [
    {
      id: "ability:1",
      label: "Python",
      category: "tech",
      size: 1,
      degree: 1,
      community_key: null,
      confidence: 0.9,
      attrs: { card_keys: ["skills"], group: "后端", evidence_ref: ["skills#7 《技能清单》: Python 后端开发"] },
    },
    {
      id: "ability:2",
      label: "Java",
      category: "tech",
      size: 0.6,
      degree: 1,
      community_key: null,
      confidence: 0.7,
      attrs: { card_keys: ["skills"], group: "后端", evidence_ref: [] },
    },
  ],
  edges: [
    { id: "e1", source: "ability:1", target: "ability:2", kind: "co_section", weight_raw: 3, strength: 0.9, directed: false, attrs: { evidence_ref: [] } },
  ],
};

/** 空能力快照（0 节点）。 */
const ABILITY_EMPTY: AbilitySnapshot = {
  ...ABILITY,
  stats: { node_count: 0, edge_count: 0, card_count: 0, source_count: 0 },
  nodes: [],
  edges: [],
};

/** 一个人物图谱载荷（只为让初始「群」模式有图、工具栏可点，从而能切到能力视图）。 */
const PERSON_PAYLOAD: GraphPanelPayload = {
  snapshot: { graph_version: "1", generated_at: "2026-11-12T00:00:00.000Z", node_count: 2, edge_count: 1, community_count: 1, modularity: 0.3 },
  nodes: [
    { id: "me", label: "我", kind: "person", size: 0.9, degree: 1, isolated: false, community_key: null, relation_type: null },
    { id: "p1", label: "张三", kind: "person", size: 0.5, degree: 1, isolated: false, community_key: null, relation_type: null },
  ],
  edges: [{ id: "e", source: "me", target: "p1", kind: "co_presence", strength: 0.5, directed: false }],
  warnings: [],
};

function abilityPortOf(snapshot: AbilitySnapshot): KnowselfAbilityPort {
  return { getSnapshot: async (): Promise<AbilitySnapshotResponse> => ({ snapshot, cache: "miss" }) };
}

function miningStub() {
  return {
    getStatus: async () => ({ has_snapshot: true, snapshot_id: "s", node_count: 2, edge_count: 1, chat_message_count: 50, chat_conversation_count: 1, person_count: 2 }),
    run: async () => ({}),
  };
}

/** 记录 arc 调用（= 已绘制的节点数），用来等待画布布局稳定（同 person 点击测的做法）。 */
let drawnArcs: number[] = [];

function fakeContext(): CanvasRenderingContext2D {
  return {
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textAlign: "", textBaseline: "",
    setTransform: () => {}, clearRect: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {},
    lineTo: () => {}, stroke: () => {}, fill: () => {},
    arc: (_x: number, _y: number, r: number) => { drawnArcs.push(r); },
    fillText: () => {},
  } as unknown as CanvasRenderingContext2D;
}

function renderPanel(ability: KnowselfAbilityPort, onGoInbox?: () => void) {
  return render(
    createElement(GraphPanelView, {
      port: { getGraph: async () => PERSON_PAYLOAD },
      miningPort: miningStub(),
      abilityPort: ability,
      ...(onGoInbox === undefined ? {} : { onGoInbox }),
    }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  drawnArcs = [];
  // jsdom 容器默认 0 尺寸，面板永远不画 → 固定 640×420
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640, height: 420, top: 0, left: 0, right: 640, bottom: 420, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 切到能力视图并等到筛选栏出现（= 能力快照已加载）。 */
async function gotoAbility(): Promise<void> {
  fireEvent.click(await screen.findByTestId("graph-mode-ability"));
  await screen.findByTestId("ability-filter-bar");
}

describe("能力视图面板", () => {
  it("A. 切到能力视图：筛选栏 + 画布出现，⚙ 统计含能力节点数", async () => {
    renderPanel(abilityPortOf(ABILITY));
    await gotoAbility();

    expect(screen.getByTestId("ability-filter-bar")).toBeDefined();
    expect(screen.getByTestId("graph-canvas")).toBeDefined();
    // 分类 / 抽取分组不再驱动能力视图 UI。
    expect(screen.queryByTestId("ability-filter-category-soft")).toBeNull();
    expect(screen.queryByTestId("ability-filter-group-后端")).toBeNull();
    // ⚙ 统计能查到「共 2 个能力」
    fireEvent.click(screen.getByTestId("graph-settings"));
    const stats = await screen.findByTestId("graph-settings-stats");
    expect(stats.textContent).toContain("个能力");
    expect(stats.textContent).toContain("2");
  });

  it("B. 空能力快照：出现 ability-empty + 「去待整理」按钮，点击触发回调", async () => {
    const onGoInbox = vi.fn();
    renderPanel(abilityPortOf(ABILITY_EMPTY), onGoInbox);
    await gotoAbility();

    const empty = await screen.findByTestId("ability-empty");
    expect(empty.textContent).toContain("还没蒸馏出能力项");
    fireEvent.click(screen.getByTestId("ability-empty-go-inbox"));
    expect(onGoInbox).toHaveBeenCalledTimes(1);
  });

  it("C. 点能力节点 → 详情侧栏出现且含证据原文片段", async () => {
    renderPanel(abilityPortOf(ABILITY));
    await gotoAbility();

    // 等画布把 2 个能力节点画出来（= 布局在 640×420 上稳定），否则点击坐标会对不上
    await waitFor(() => expect(drawnArcs.length).toBeGreaterThanOrEqual(2));

    const wrap = await screen.findByTestId("graph-canvas-wrap");
    // 用与面板完全相同的入参（能力专用布局）复算，取节点坐标
    const expected = layoutAbilityGraph(
      {
        nodes: ABILITY.nodes.map(abilityToPanelNode),
        edges: ABILITY.edges.map(abilityToPanelEdge),
        width: 640,
        height: 420,
      },
      { nodeSizeScale: DEFAULT_GRAPH_SETTINGS.nodeSizeScale / 5, minRadius: 6 },
    );
    const python = expected.nodes.find((n) => n.id === "ability:1");
    expect(python).toBeDefined();
    const screenPoint = toScreen(python!, fitViewport(expected.nodes, { width: 640, height: 420 }));
    fireEvent.click(wrap, { clientX: screenPoint.x, clientY: screenPoint.y });

    const detail = await screen.findByTestId("ability-node-detail");
    expect(detail.textContent).toContain("Python");
    expect(screen.getByTestId("ability-evidence-list").textContent).toContain("《技能清单》");
  });

  it("D. 切走再切回：能力筛选被保留（搜索条件仍生效）", async () => {
    renderPanel(abilityPortOf(ABILITY));
    await gotoAbility();

    // 搜索一个不存在的能力名 → 筛到 0。
    fireEvent.change(screen.getByTestId("ability-filter-search"), { target: { value: "不存在" } });
    await screen.findByTestId("ability-no-match");

    // 切走 → 群
    fireEvent.click(screen.getByTestId("graph-mode-group"));
    await waitFor(() => expect(screen.queryByTestId("ability-filter-bar")).toBeNull());

    // 切回 → 能力
    fireEvent.click(await screen.findByTestId("graph-mode-ability"));
    await screen.findByTestId("ability-filter-bar");

    // 关键断言：筛选状态被保留（切走再切回不丢）
    expect((screen.getByTestId("ability-filter-search") as HTMLInputElement).value).toBe("不存在");
    // 且筛选真实生效：0 条匹配 → 无匹配提示（而非「还没蒸馏」）
    expect(await screen.findByTestId("ability-no-match")).toBeDefined();
    expect(screen.queryByTestId("ability-empty")).toBeNull();
  });

  it("E. ⚙ 在能力视图下不含人物专属项（按社区聚合 / 局部深度）", async () => {
    renderPanel(abilityPortOf(ABILITY));
    await gotoAbility();

    fireEvent.click(screen.getByTestId("graph-settings"));
    await screen.findByTestId("graph-settings-panel");
    expect(screen.queryByTestId("graph-settings-aggregate-community")).toBeNull();
    expect(screen.queryByTestId("graph-settings-depth")).toBeNull();
    // 但通用渲染项仍在（节点大小）
    expect(screen.getByTestId("graph-settings-node-size")).toBeDefined();
  });
});
