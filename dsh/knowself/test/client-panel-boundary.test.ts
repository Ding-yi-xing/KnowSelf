// @vitest-environment jsdom
/**
 * QA 独立补测（Task #2）：A2 client 面板的边界 / 错误路径 / 卸载路径。
 *
 * 与 `test/client-panel.test.ts` 的区别：那份只做「注册形状 + 端口委托」的桩断言，
 * 未真正渲染 React 组件、未覆盖 `useEffect` 内的数据加载与异常分支，也未验证
 * `ctx.slots.inject` factory 返回的 disposer 能否被回收。本文件用
 * jsdom + @testing-library/react 做真实渲染补测，只新增测试代码，不改任何源码。
 *
 * 覆盖：
 *   A. 未注入数据端口 → 默认 UNAVAILABLE_PORT + 面板「数据桥接待接入」提示真实出现
 *      （前 3 条为端口级语义，B2 后保持不变；第 4 条端到端 apply 因 B2 语义变更就地更新为
 *       「默认 REST 端口 + bridgeReady=true + fetch 被调用 + 不再显示待接入提示」，未删除、未弱化）；
 *   B. 空人物列表 / getPerson 返回 null / 端口同步抛错 / 端口异步 reject 时渲染不崩溃；
 *   C. 图标收到 { size, active } 时真实点击触发 selectPanel 且面板 id 正确；
 *   D. ctx.slots.inject 的 factory 返回的 disposer 可被调用回收（卸载路径）；
 *   E. 图谱面板（M3 波 3）：空快照显示 hint、不画空画布、A2-2 占位文案已移除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PersonRow } from "@knowself/person-store";
import {
  UNAVAILABLE_PORT,
  getPersonPanelDataPort,
  isPersonPanelBridgeConfigured,
  setPersonPanelDataPort,
  type PersonPanelDataPort,
} from "../src/client/data-port.js";
import { PersonPanelView } from "../src/client/person-panel.js";
import { GraphPanelView } from "../src/client/graph-panel.js";
import { GRAPH_EMPTY_HINT, type GraphPanelPayload, type KnowselfGraphPort } from "../src/client/graph-port.js";
import { PersonPanelIcon, GraphPanelIcon } from "../src/client/icons.js";
import { apply } from "../src/client/index.js";

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 构造一行人物档案（字段按 PersonRow 真实形态，用 as 规避测试桩的类型完备性）。 */
function makeRow(overrides: Record<string, unknown> = {}): PersonRow {
  return {
    person_id: "p1",
    display_name: "张三",
    subject_kind: "person",
    status: "active",
    remark: null,
    msg_count: 12,
    conv_count: 2,
    first_msg_at: null,
    last_msg_at: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    profile_json: "{}",
    ...overrides,
  } as unknown as PersonRow;
}

/**
 * 构造图谱端口桩（M3 波 3）：直接返回给定响应体，供面板态断言使用。
 * @param payload 图谱响应体（空快照 / 有快照）
 * @returns 只读图谱端口
 */
function makeGraphPort(payload: GraphPanelPayload): KnowselfGraphPort {
  return { getGraph: () => Promise.resolve(payload) };
}

interface StubCtx {
  ctx: Parameters<typeof apply>[0];
  registered: Array<{ options: unknown; component: unknown }>;
  injected: Array<{
    slotName: string;
    factoryResult: unknown;
    outerDisposer: () => void;
  }>;
  selected: Array<string | null>;
  disposed: string[];
}

/**
 * 桩 client ctx：register 返回可观测的 disposer；inject 调用 factory 拿到内层
 * disposer 后，返回一个级联调用它的外层 disposer（贴近日后 cordis effect 卸载语义）。
 */
function makeStubClientContext(): StubCtx {
  const registered: Array<{ options: unknown; component: unknown }> = [];
  const injected: StubCtx["injected"] = [];
  const selected: Array<string | null> = [];
  const disposed: string[] = [];

  const slots = {
    register: (options: unknown, component: unknown) => {
      registered.push({ options, component });
      const o = options as { key?: string; id?: string };
      const id = o.key ?? o.id ?? "unknown";
      return () => {
        disposed.push(id);
      };
    },
    inject: (slotName: string, factory: () => () => void) => {
      const inner = factory();
      const outer = () => inner();
      injected.push({ slotName, factoryResult: inner, outerDisposer: outer });
      return outer;
    },
  };
  const layout = {
    selectPanel: (id: string | null) => {
      selected.push(id);
    },
    toggleSidebar: () => {},
    openRightbar: () => {},
    closeRightbar: () => {},
  };

  return {
    ctx: { slots, layout } as unknown as Parameters<typeof apply>[0],
    registered,
    injected,
    selected,
    disposed,
  };
}

beforeEach(() => {
  // React 18 act() 需要该标志，避免 "not configured to support act" 噪声。
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setPersonPanelDataPort(undefined);
});

afterEach(() => {
  cleanup();
});

// ── A. 默认端口 / 桥接提示（真实渲染） ─────────────────────────────────────

describe("A. 未注入数据端口：默认 UNAVAILABLE_PORT 与「数据桥接待接入」提示", () => {
  it("未配置时端口即 UNAVAILABLE_PORT，三方法返回空数据，bridgeConfigured=false", () => {
    expect(getPersonPanelDataPort()).toBe(UNAVAILABLE_PORT);
    expect(isPersonPanelBridgeConfigured()).toBe(false);
    expect(UNAVAILABLE_PORT.listPersons()).toEqual([]);
    expect(UNAVAILABLE_PORT.getPerson("any")).toBeNull();
    expect(UNAVAILABLE_PORT.timeline("any")).toEqual([]);
  });

  it("bridgeReady=false 时面板真实渲染出「数据桥接待接入」且列表为空态，不抛错", async () => {
    const { container } = render(
      createElement(PersonPanelView, {
        port: getPersonPanelDataPort(),
        bridgeReady: isPersonPanelBridgeConfigured(),
      }),
    );
    expect(screen.getByRole("status").textContent).toContain("数据桥接待接入");
    await waitFor(() => expect(container.textContent).toContain("暂无人物数据"));
    expect(container.textContent).not.toContain("数据读取失败");
  });

  it("bridgeReady=true 时不再显示桥接待接入提示", async () => {
    const { container } = render(
      createElement(PersonPanelView, { port: UNAVAILABLE_PORT, bridgeReady: true }),
    );
    // 等 useEffect 的 listPersons 落地，避免 cleanup 时的 act 警告。
    await waitFor(() => expect(container.textContent).toContain("暂无人物数据"));
    expect(container.textContent).not.toContain("数据桥接待接入");
  });

  it("端到端：apply 未注入端口 → B2 默认 REST 端口 + bridgeReady=true，渲染不再显示桥接待接入提示且发起 fetch", async () => {
    // B2 语义变更：apply 真实渲染路径在无显式端口时默认走同 origin REST 端口。
    // 用 stubGlobal 桩掉 fetch，避免 jsdom 环境触网；data-port.ts 端口级语义未变（A 组前 3 条仍成立）。
    const fetchStub = vi.fn(async (_input: string, _init?: unknown) =>
      ({
        ok: true,
        status: 200,
        json: async () => [],
      }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const { ctx, registered } = makeStubClientContext();
      apply(ctx);
      const personMain = registered.find((r) => {
        const o = r.options as { name?: string; key?: string };
        return o.name === "main" && o.key === "knowself-person";
      });
      expect(personMain).toBeDefined();
      const Comp = personMain!.component as () => ReactElement;
      const { container } = render(createElement(Comp));
      await waitFor(() => expect(fetchStub).toHaveBeenCalled());
      expect(fetchStub.mock.calls[0]![0]).toContain("/knowself-api/persons");
      await waitFor(() => expect(container.textContent).toContain("暂无人物数据"));
      expect(container.textContent).not.toContain("数据桥接待接入");
      expect(container.textContent).not.toContain("数据读取失败");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── B. 边界与错误路径（useEffect 内数据加载） ──────────────────────────────

describe("B. 面板在空数据 / null / 端口异常时不崩溃", () => {
  it("空人物列表 → 显示「暂无人物数据」，listPersons 带 limit=200", async () => {
    const listPersons = vi.fn(() => [] as PersonRow[]);
    const port: PersonPanelDataPort = {
      listPersons,
      getPerson: () => null,
      timeline: () => [],
    };
    const { container } = render(
      createElement(PersonPanelView, { port, bridgeReady: true }),
    );
    await waitFor(() => expect(container.textContent).toContain("暂无人物数据"));
    expect(listPersons).toHaveBeenCalledWith({ limit: 200, direct_only: true });
    expect(container.textContent).not.toContain("数据读取失败");
  });

  it("点击人物后 getPerson 返回 null → 详情保持空态，timeline 仍被调用，不崩溃", async () => {
    const row = makeRow();
    const getPerson = vi.fn(() => null);
    const timeline = vi.fn(() => []);
    const port: PersonPanelDataPort = {
      listPersons: () => [row],
      getPerson,
      timeline,
    };
    const { container } = render(
      createElement(PersonPanelView, { port, bridgeReady: true }),
    );
    await waitFor(() => expect(container.textContent).toContain("张三"));
    fireEvent.click(screen.getByRole("button", { name: /张三/ }));
    await waitFor(() => expect(getPerson).toHaveBeenCalledWith("p1"));
    expect(timeline).toHaveBeenCalledWith("p1", { limit: 50 });
    expect(container.textContent).toContain("从左侧选择一个人物查看档案");
    expect(container.textContent).not.toContain("数据读取失败");
  });

  it("listPersons 同步抛错 → 捕获并显示「数据读取失败：boom-list」，不崩溃", async () => {
    const port: PersonPanelDataPort = {
      listPersons: () => {
        throw new Error("boom-list");
      },
      getPerson: () => null,
      timeline: () => [],
    };
    const { container } = render(
      createElement(PersonPanelView, { port, bridgeReady: true }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("数据读取失败：boom-list"),
    );
    expect(container.textContent).toContain("暂无人物数据");
  });

  it("timeline 返回 rejected Promise → 选中后捕获错误并显示提示，不崩溃", async () => {
    const row = makeRow();
    const port: PersonPanelDataPort = {
      listPersons: () => [row],
      getPerson: () => row,
      timeline: () => Promise.reject(new Error("boom-timeline")),
    };
    const { container } = render(
      createElement(PersonPanelView, { port, bridgeReady: true }),
    );
    await waitFor(() => expect(container.textContent).toContain("张三"));
    fireEvent.click(screen.getByRole("button", { name: /张三/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("数据读取失败：boom-timeline"),
    );
    expect(container.textContent).toContain("人物档案");
  });
});

// ── C. 图标 { size, active } 与 selectPanel 接线（真实渲染 + 点击） ─────────

describe("C. 侧栏图标真实渲染与 selectPanel 接线", () => {
  it("独立图标：size/active 映射到 button，onSelect 点击即触发", () => {
    const onSelect = vi.fn();
    const p = render(
      createElement(PersonPanelIcon, { size: 24, active: false, onSelect }),
    );
    const btn = p.container.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("人物档案");
    expect(btn.style.width).toBe("24px");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledTimes(1);

    const g = render(
      createElement(GraphPanelIcon, { size: 32, active: true, onSelect }),
    );
    const btnG = g.container.querySelector("button")!;
    expect(btnG.getAttribute("aria-label")).toBe("知识图谱");
    expect(btnG.style.height).toBe("32px");
    expect(btnG.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btnG);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("apply 注册的侧栏图标：真实点击触发 ctx.layout.selectPanel 且面板 id 正确", () => {
    const { ctx, registered, selected } = makeStubClientContext();
    apply(ctx);

    const findIcon = (id: string) =>
      registered.find((r) => {
        const o = r.options as { name?: string; id?: string };
        return o.name === "sidebar.panellist" && o.id === id;
      });
    const hub = findIcon("knowself-hub");
    const graph = findIcon("knowself-graph");
    expect(hub).toBeDefined();
    expect(graph).toBeDefined();

    type IconComponent = (props: { size: number; active: boolean }) => ReactElement;
    const HubIcon = hub!.component as IconComponent;
    const GraphIcon = graph!.component as IconComponent;

    const rh = render(createElement(HubIcon, { size: 24, active: false }));
    fireEvent.click(rh.container.querySelector("button")!);
    const rg = render(createElement(GraphIcon, { size: 32, active: true }));
    fireEvent.click(rg.container.querySelector("button")!);

    expect(selected).toEqual(["knowself-hub", "knowself-graph"]);
  });

  it("旧面板 id 的 main 别名落到对应 tab（兼容既有 selectPanel 调用）", async () => {
    const fetchStub = vi.fn(async (_input: string, _init?: unknown) =>
      ({
        ok: true,
        status: 200,
        json: async () => [],
      }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const { ctx, registered } = makeStubClientContext();
      apply(ctx);

      const inboxMain = registered.find((r) => {
        const o = r.options as { name?: string; key?: string };
        return o.name === "main" && o.key === "knowself-inbox";
      });
      expect(inboxMain).toBeDefined();

      const Comp = inboxMain!.component as () => ReactElement;
      render(createElement(Comp));
      expect(screen.getByTestId("knowself-hub-tab-inbox").getAttribute("aria-selected")).toBe("true");

      // 等 effect 里的 fetch 落地，避免 cleanup 时的 act 警告。
      await waitFor(() => expect(fetchStub).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── D. inject factory disposer 卸载路径 ────────────────────────────────────

describe("D. ctx.slots.inject factory disposer 可被调用回收", () => {
  it("9 处 inject 的 factory 均返回 disposer，外层卸载器级联回收全部注册", () => {
    const { ctx, injected, disposed } = makeStubClientContext();
    apply(ctx);

    // 2026-11-18：main ×7（KnowSelf + 5 个兼容别名 + 图谱）+ sidebar.panellist ×2。
    expect(injected.map((x) => x.slotName)).toEqual([
      "main",
      "main",
      "main",
      "main",
      "main",
      "main",
      "main",
      "sidebar.panellist",
      "sidebar.panellist",
    ]);
    for (const x of injected) {
      expect(typeof x.factoryResult).toBe("function");
      expect(typeof x.outerDisposer).toBe("function");
    }

    expect(disposed).toHaveLength(0);
    for (const x of injected) x.outerDisposer();
    expect(disposed).toHaveLength(9);
    expect(disposed).toContain("knowself-hub");
    expect(disposed).toContain("knowself-person");
    expect(disposed).toContain("knowself-graph");
    expect(disposed).toContain("knowself-profile");
    expect(disposed).toContain("knowself-journal");
    expect(disposed).toContain("knowself-inbox");
    expect(disposed).toContain("knowself-sources");
  });
});

// ── E. 图谱面板：M3 波 3 由占位改为真实实现 ────────────────────────────────

describe("E. 图谱面板（M3 波 3）：空快照显示 hint、不画空画布、旧占位文案已移除", () => {
  it("空快照：显示宿主 hint，且**不再出现** A2-2 的占位说明；不渲染 canvas", async () => {
    const { container } = render(
      createElement(GraphPanelView, {
        port: makeGraphPort({ snapshot: null, nodes: [], edges: [], hint: GRAPH_EMPTY_HINT }),
      }),
    );

    await waitFor(() => expect(screen.getByTestId("graph-empty")).toBeDefined());
    expect(container.textContent).toContain(GRAPH_EMPTY_HINT);
    // 力导向图 / 数据桥接已真实实现 → 旧占位文案必须彻底消失
    expect(container.textContent).not.toContain("占位视图");
    expect(container.textContent).not.toContain("未引入第三方图谱库");
    expect(container.textContent).not.toContain("力导向图渲染");
    // 空快照不画空画布（空白 canvas 会被误读成「图就是这样」）
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
  });
});
