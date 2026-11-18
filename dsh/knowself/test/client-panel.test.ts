/**
 * A2 单测（桩服务、不触网、不依赖 dsh 宿主 / better-sqlite3）。
 *
 * 覆盖：
 *   1. `brandString` 运行期返回普通字符串（brand 仅编译期）；
 *   2. `createPersonStoreDataPort` 确实委托 `PersonStore` 只读 API（A2 数据落地验证）；
 *   3. `apply(ctx)` 的注册形状（main key / sidebar.panellist id + label 函数 / order / locale）
 *      与 `ctx.layout.selectPanel` 接线（按 A2-核实.md 已核实签名）；
 *   4. `inject` 常量；
 *   5. 默认端口在未配置桥接时返回空数据（诚实反映「待接入」）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MainPanelId } from "@knowself/dsh-client-contract";
import type { PersonRow, PersonStore } from "@knowself/person-store";
import {
  brandString,
  GRAPH_PANEL_ID,
  PERSON_PANEL_ID,
  GRAPH_PANEL_LABEL,
  PERSON_PANEL_LABEL,
  KNOWSELF_LOCALE_NS,
} from "../src/client/brand.js";
import {
  getPersonPanelDataPort,
  isPersonPanelBridgeConfigured,
  setPersonPanelDataPort,
  UNAVAILABLE_PORT,
  type PersonPanelDataPort,
} from "../src/client/data-port.js";
import { createPersonStoreDataPort } from "../src/person-store-data-port.js";
import { apply, inject } from "../src/client/index.js";

// 模块级端口注册是共享状态，每个用例前重置，避免相互污染。
beforeEach(() => {
  setPersonPanelDataPort(undefined);
});

describe("A2 面板标识（brandString，brand 仅编译期）", () => {
  it("brandString 运行期返回原字符串", () => {
    expect(brandString<MainPanelId>("knowself-person")).toBe("knowself-person");
  });

  it("人物 / 图谱面板 id 为普通字符串且互不相同", () => {
    expect(PERSON_PANEL_ID).toBe("knowself-person");
    expect(GRAPH_PANEL_ID).toBe("knowself-graph");
    expect(PERSON_PANEL_ID).not.toBe(GRAPH_PANEL_ID);
  });

  it("侧栏 label 是 locale 感知函数（返回 string），locale 命名空间固定", () => {
    expect(typeof PERSON_PANEL_LABEL).toBe("function");
    expect(PERSON_PANEL_LABEL()).toBe("人物");
    expect(GRAPH_PANEL_LABEL()).toBe("图谱");
    expect(KNOWSELF_LOCALE_NS).toBe("knowself");
  });
});

describe("A2 数据端口：createPersonStoreDataPort 确实取 person-store 只读 API", () => {
  const row = {
    person_id: "p1",
    display_name: "张三",
    profile_json: "{}",
    msg_count: 12,
  } as unknown as PersonRow;
  const event = {
    event_id: "e1",
    event_date: "2026-01-01",
    title: "初次见面",
    summary: "示例",
    importance: 3,
  };

  it("三个方法逐一委托 listPersons / getPerson / events.timeline", async () => {
    const listPersons = vi.fn(() => [row]);
    const getPerson = vi.fn((id: string) => (id === "p1" ? row : null));
    const timeline = vi.fn(() => [event]);
    const store = {
      listPersons,
      getPerson,
      events: { timeline },
    } as unknown as PersonStore;

    const port = createPersonStoreDataPort(store);

    await expect(Promise.resolve(port.listPersons({ limit: 5 }))).resolves.toEqual([row]);
    expect(listPersons).toHaveBeenCalledWith({ limit: 5 });

    await expect(Promise.resolve(port.getPerson("p1"))).resolves.toBe(row);
    expect(getPerson).toHaveBeenCalledWith("p1");

    await expect(Promise.resolve(port.timeline("p1", { limit: 2 }))).resolves.toEqual([event]);
    expect(timeline).toHaveBeenCalledWith("p1", { limit: 2 });
  });

  it("getPerson 不存在时透传 null，timeline 空时透传空数组", async () => {
    const store = {
      listPersons: () => [],
      getPerson: () => null,
      events: { timeline: () => [] },
      messages: { count: () => 0, list: () => [] },
    } as unknown as PersonStore;
    const port = createPersonStoreDataPort(store);

    await expect(Promise.resolve(port.getPerson("missing"))).resolves.toBeNull();
    await expect(Promise.resolve(port.timeline("missing"))).resolves.toEqual([]);
  });

  it("关系事件尚未挖掘时回退为最新原始消息，并明确标记为消息互动", async () => {
    const messages = [
      { message_id: "m1", conversation_id: "wechat:alice", sender_name: "宝宝", role: "other", ts_ms: 1, msg_date: "2026-11-15", content: "早上好", content_type: "text" },
      { message_id: "m2", conversation_id: "wechat:alice", sender_name: "我", role: "me", ts_ms: 2, msg_date: "2026-11-16", content: "午饭吃了吗", content_type: "text" },
      { message_id: "m3", conversation_id: "wechat:alice", sender_name: "宝宝", role: "other", ts_ms: 3, msg_date: "2026-11-16", content: "吃了", content_type: "text" },
    ];
    const list = vi.fn(() => messages.slice(1));
    const store = {
      listPersons: () => [],
      getPerson: () => null,
      events: { timeline: () => [] },
      messages: { count: vi.fn(() => 3), list },
    } as unknown as PersonStore;
    const port = createPersonStoreDataPort(store);

    await expect(Promise.resolve(port.timeline("alice", { limit: 2 }))).resolves.toEqual([
      expect.objectContaining({ kind: "message", message_id: "m3", content: "吃了" }),
      expect.objectContaining({ kind: "message", message_id: "m2", content: "午饭吃了吗" }),
    ]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ person_id: "alice", limit: 2, offset: 1 }));
  });
});

describe("A2 数据端口默认态（桥接待接入，诚实空数据）", () => {
  it("未配置时 isBridgeConfigured=false，端口为 UNAVAILABLE_PORT 且返回空数据", async () => {
    expect(isPersonPanelBridgeConfigured()).toBe(false);
    const port = getPersonPanelDataPort();
    expect(port).toBe(UNAVAILABLE_PORT);
    await expect(Promise.resolve(port.listPersons())).resolves.toEqual([]);
    await expect(Promise.resolve(port.getPerson("any"))).resolves.toBeNull();
    await expect(Promise.resolve(port.timeline("any"))).resolves.toEqual([]);
  });

  it("setPersonPanelDataPort 注入后标记 bridgeConfigured=true 并生效", async () => {
    const injected: PersonPanelDataPort = {
      listPersons: () => [],
      getPerson: () => null,
      timeline: () => [],
    };
    setPersonPanelDataPort(injected);
    expect(isPersonPanelBridgeConfigured()).toBe(true);
    expect(getPersonPanelDataPort()).toBe(injected);
  });
});

/** 桩 client ctx：记录 register / inject / selectPanel 调用。 */
function makeStubClientContext(): {
  ctx: Parameters<typeof apply>[0];
  registered: Array<{ options: unknown; component: unknown }>;
  injected: string[];
  selected: Array<string | null>;
} {
  const registered: Array<{ options: unknown; component: unknown }> = [];
  const injected: string[] = [];
  const selected: Array<string | null> = [];

  const slots = {
    register: (options: unknown, component: unknown) => {
      registered.push({ options, component });
      return () => {};
    },
    inject: (slotName: string, factory: () => () => void) => {
      injected.push(slotName);
      factory();
      return () => {};
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
  };
}

describe("A2 apply(ctx)：main / sidebar.panellist 注册 + selectPanel 接线", () => {
  it("inject 常量为 cordis 服务键 slots / layout", () => {
    expect(Array.from(inject)).toEqual(["slots", "layout"]);
  });

  it("注册 7 个 main（keyed）+ 2 个 sidebar.panellist（list）：KnowSelf 入口 + 图谱", () => {
    const { ctx, registered, injected } = makeStubClientContext();
    apply(ctx);

    // 2026-11-18：人物/画像/待整理/日志/资料合并为 KnowSelf 一个入口，main 注册
    // 保留五个旧 key 作兼容别名（各自落到对应 tab），侧栏只剩 KnowSelf + 图谱。
    expect(injected).toEqual([
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
    expect(registered).toHaveLength(9);

    const mainOptions = registered
      .map((r) => r.options as { name: string; key: string })
      .filter((o) => o.name === "main");
    expect(mainOptions).toHaveLength(7);
    expect(mainOptions.map((o) => o.key)).toEqual([
      "knowself-hub",
      "knowself-person",
      "knowself-profile",
      "knowself-inbox",
      "knowself-journal",
      "knowself-sources",
      "knowself-graph",
    ]);
    // keyed main 用 key，不带 id
    expect(mainOptions.every((o) => !("id" in o))).toBe(true);

    const sidebarOptions = registered
      .map((r) => r.options as Record<string, unknown>)
      .filter((o) => o["name"] === "sidebar.panellist");
    expect(sidebarOptions).toHaveLength(2);
    expect(sidebarOptions.map((o) => o["id"])).toEqual([
      "knowself-hub",
      "knowself-graph",
    ]);
    expect(sidebarOptions.map((o) => o["order"])).toEqual([0, 1]);
    // label 必须是 () => string 函数（locale 感知），不是 string
    for (const options of sidebarOptions) {
      expect(typeof options["label"]).toBe("function");
      expect((options["label"] as () => string)()).not.toBe("");
      expect(options["locale"]).toBe("knowself");
    }
    expect((sidebarOptions[0]?.["label"] as () => string)()).toBe("KnowSelf");
  });

  it("侧栏图标点击触发 ctx.layout.selectPanel(对应面板 id)", () => {
    const { ctx, registered, selected } = makeStubClientContext();
    apply(ctx);

    const hubIconEntry = registered.find((r) => {
      const o = r.options as { name?: string; id?: string };
      return o.name === "sidebar.panellist" && o.id === "knowself-hub";
    });
    const graphIconEntry = registered.find((r) => {
      const o = r.options as { name?: string; id?: string };
      return o.name === "sidebar.panellist" && o.id === "knowself-graph";
    });
    expect(hubIconEntry).toBeDefined();
    expect(graphIconEntry).toBeDefined();

    // 直接调用闭包函数组件（无 hooks），读取其返回 element 上的 onSelect 并触发。
    type IconComponent = (props: {
      size: number;
      active: boolean;
    }) => { props: { onSelect?: () => void } };

    const hubIcon = hubIconEntry?.component as IconComponent;
    const graphIcon = graphIconEntry?.component as IconComponent;
    hubIcon({ size: 24, active: false }).props.onSelect?.();
    graphIcon({ size: 24, active: true }).props.onSelect?.();

    expect(selected).toEqual(["knowself-hub", "knowself-graph"]);
  });

  it("apply 接受 ctx.knowself.personPanelDataPort 注入而不抛错", () => {
    const { ctx, registered } = makeStubClientContext();
    const injectedCtx = ctx as typeof ctx & {
      knowself?: { personPanelDataPort?: PersonPanelDataPort };
    };
    injectedCtx.knowself = { personPanelDataPort: UNAVAILABLE_PORT };
    expect(() => apply(injectedCtx)).not.toThrow();
    expect(registered).toHaveLength(9);
  });
});
