// @vitest-environment jsdom
/**
 * 关系图谱改造（Obsidian Graph View）的**渲染层**测试：设置浮层 + 右键菜单。
 *
 * 只断言「控件 / 文案 / testid 是否就位」与「回调是否正确上抛」，不碰 canvas 与网络。
 * 用 `createElement` 构造（测试文件统一 `.ts`，与既有约定一致）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GraphContextMenu, type GraphContextMenuActions } from "../src/client/graph-context-menu.js";
import { GraphSettingsPanel } from "../src/client/graph-settings-panel.js";
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from "../src/client/graph-settings.js";
import type { GraphLayoutNode } from "../src/client/graph-layout.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 造一个布局节点（右键菜单用）。 */
function layoutNode(overrides: Partial<GraphLayoutNode> = {}): GraphLayoutNode {
  return {
    id: "p1",
    label: "张三",
    kind: "person",
    x: 0,
    y: 0,
    radius: 10,
    isolated: false,
    degree: 2,
    communityKey: null,
    prominence: 1,
    ...overrides,
  };
}

/** 造一组静态菜单动作。 */
function menuActions(overrides: Partial<GraphContextMenuActions> = {}): GraphContextMenuActions {
  return {
    canWrite: true,
    onRename: vi.fn(async () => {}),
    onMerge: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onClaim: vi.fn(),
    searchPersons: vi.fn(() => []),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("GraphSettingsPanel：四组设置 + 局部图谱深度", () => {
  it("渲染四个分组控件与图例", () => {
    const settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS };
    render(
      createElement(GraphSettingsPanel, {
        settings,
        onChange: () => {},
        communities: [
          { key: "c:aaa", label: "社区 aaa" },
          { key: null, label: "未分组" },
        ],
        onClose: () => {},
      }),
    );

    expect(screen.getByTestId("graph-settings-panel")).toBeDefined();
    expect(screen.getByTestId("graph-settings-search")).toBeDefined();
    expect(screen.getByTestId("graph-settings-show-orphans")).toBeDefined();
    expect(screen.queryByTestId("graph-settings-show-labels")).toBeNull();
    expect(screen.getByTestId("graph-settings-only-profiled")).toBeDefined();
    expect(screen.getByTestId("graph-settings-node-size")).toBeDefined();
    expect(screen.getByTestId("graph-settings-edge-width")).toBeDefined();
    expect(screen.getByTestId("graph-settings-center-force")).toBeDefined();
    expect(screen.getByTestId("graph-settings-repulsion")).toBeDefined();
    expect(screen.getByTestId("graph-settings-link-force")).toBeDefined();
    expect(screen.getByTestId("graph-settings-link-distance")).toBeDefined();
    expect(screen.getByTestId("graph-settings-depth")).toBeDefined();
  });

  it("滑杆变化 → onChange 收到局部 patch", () => {
    const onChange = vi.fn();
    const settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS };
    render(createElement(GraphSettingsPanel, { settings, onChange, communities: [], onClose: () => {} }));

    fireEvent.change(screen.getByTestId("graph-settings-depth"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith({ localDepth: 3 });

    fireEvent.change(screen.getByTestId("graph-settings-center-force"), { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledWith({ centerForce: 7 });
  });

  it("搜索输入 → onChange 收到 searchQuery", () => {
    const onChange = vi.fn();
    render(
      createElement(GraphSettingsPanel, {
        settings: { ...DEFAULT_GRAPH_SETTINGS },
        onChange,
        communities: [],
        onClose: () => {},
      }),
    );
    fireEvent.change(screen.getByTestId("graph-settings-search"), { target: { value: "张三" } });
    expect(onChange).toHaveBeenCalledWith({ searchQuery: "张三" });
  });
});

describe("GraphContextMenu：改名 / 合并 / 删除 / 认领", () => {
  it("person 节点 → 改名 / 合并 / 删除", () => {
    render(
      createElement(GraphContextMenu, {
        node: layoutNode(),
        position: { x: 10, y: 20 },
        actions: menuActions(),
      }),
    );
    expect(screen.getByTestId("graph-context-menu")).toBeDefined();
    expect(screen.getByText("改名")).toBeDefined();
    expect(screen.getByText("合并到…")).toBeDefined();
    expect(screen.getByText("归档（删除）")).toBeDefined();
  });

  it("direct 节点 → 认领为人物（不显示改名/合并/删除）", () => {
    render(
      createElement(GraphContextMenu, {
        node: layoutNode({ kind: "direct" as GraphLayoutNode["kind"], label: "未识别·abc" }),
        position: { x: 0, y: 0 },
        actions: menuActions(),
      }),
    );
    expect(screen.getByTestId("graph-context-claim")).toBeDefined();
    expect(screen.queryByText("改名")).toBeNull();
    expect(screen.queryByText("合并到…")).toBeNull();
  });

  it("canWrite=false → 无可用操作", () => {
    render(
      createElement(GraphContextMenu, {
        node: layoutNode(),
        position: { x: 0, y: 0 },
        actions: menuActions({ canWrite: false }),
      }),
    );
    expect(screen.getByText("无可用操作")).toBeDefined();
    expect(screen.queryByText("改名")).toBeNull();
    expect(screen.queryByText("归档（删除）")).toBeNull();
  });

  it("点击认领 → onClaim 被调用", () => {
    const actions = menuActions();
    render(
      createElement(GraphContextMenu, {
        node: layoutNode({ kind: "direct" as GraphLayoutNode["kind"] }),
        position: { x: 0, y: 0 },
        actions,
      }),
    );
    fireEvent.click(screen.getByTestId("graph-context-claim"));
    expect(actions.onClaim).toHaveBeenCalledTimes(1);
  });
});
