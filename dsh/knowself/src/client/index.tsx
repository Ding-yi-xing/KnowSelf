/**
 * knowSelf dsh **client 插件入口**（A2 面板扩展）。
 *
 * 加载方式（package.json）：
 *   exports["./client"] → 本文件编译产物 dist/src/client/index.js
 *   dsh.client.inject    → 依赖的 client 服务包（renderer / layout / sidebar / locale）
 *   dsh.client.platform  → "web"
 *
 * 注册内容（全部按 A2-核实.md §1 已核实的真实签名，纯插件级、零改 dsh 源码）：
 *   ① main（keyed）：`ctx.slots.register({ name:'main', key: PANEL_ID }, Component)`
 *   ② sidebar.panellist（list）：`ctx.slots.register({ name, id, order, label:()=>string, locale }, Icon)`
 *   ③ `ctx.slots.inject(slotName, () => register(...))` 做声明门控（等 slot 声明存在后再注册）
 *   ④ `ctx.layout.selectPanel(PANEL_ID)` 由侧栏图标点击闭包触发
 *
 * 类型来源：`types/dsh-client-contract.d.ts` 的本地 ambient 契约（只 `import type`，
 * 运行期零依赖）。**不 import 任何 `@deepseek-ai/dsh-client-ui-*` 包**——它们在本
 * 独立工作区不可解析（虚拟模块 / 未链接），落地 dsh web 打包环境时由宿主提供实例。
 *
 * ## 统一入口（2026-11-18）
 * 侧栏不再平铺「人物 / 画像 / 待整理 / 日志 / 资料」五个图标，而是收进一个
 * **KnowSelf** 入口（`knowself-hub`），内部用顶部 tab 切换（见 `hub-panel.tsx`）。
 * 图谱保留独立入口（画布型视图，不在这五个里）。
 *
 * 兼容：五个旧面板 id 仍注册为 main 别名（各自落到对应 tab），这样
 * `ctx.layout.selectPanel("knowself-person")` 这类既有调用/历史深链不会因为
 * “main panel 未注册”而抛错（dsh 的 selectPanel 对未注册 key 会 throw）。
 *
 * 数据（B2 已接通）：人物面板只依赖 `PersonPanelDataPort`（见 data-port.ts 头注）。端口优先级：
 * ① `ctx.knowself.personPanelDataPort` 显式注入 → ② `setPersonPanelDataPort()` 模块级显式注册
 * → ③ 默认 `createRestDataPort()`（同 origin `/knowself-api` REST 端口，bridgeReady=true）。
 * 画像 / 待整理 / 日志 / 资料共用 `KnowselfProfilePort`（`profile-port.ts`），图谱走
 * `KnowselfGraphPort`（`graph-port.ts`），都是同 origin REST。
 */
import type {
  ClientContext,
  ClientServiceKey,
  MainPanelComponent,
  MainPanelId,
  SidebarPanelIconComponent,
} from "@knowself/dsh-client-contract";
import type { ReactElement } from "react";
import {
  GRAPH_PANEL_ID,
  GRAPH_PANEL_LABEL,
  HUB_PANEL_ID,
  HUB_PANEL_LABEL,
  INBOX_PANEL_ID,
  JOURNAL_PANEL_ID,
  KNOWSELF_LOCALE_NS,
  PERSON_PANEL_ID,
  PROFILE_PANEL_ID,
  SOURCES_PANEL_ID,
} from "./brand.js";
import {
  getPersonPanelDataPort,
  isPersonPanelBridgeConfigured,
  type PersonPanelDataPort,
} from "./data-port.js";
import { createRestDataPort } from "./rest-data-port.js";
import { createRestProfilePort, type KnowselfProfilePort } from "./profile-port.js";
import { createRestGraphPort, type KnowselfGraphPort } from "./graph-port.js";
import { PersonPanelView } from "./person-panel.js";
import { createRestPersonWritePort } from "./person-write-port.js";
import { GraphPanelView } from "./graph-panel.js";
import { focusPerson } from "./panel-jump.js";
import { ProfilePanelView } from "./profile-panel.js";
import { JournalPanelView } from "./journal-panel.js";
import { InboxPanelView } from "./inbox-panel.js";
import { SourcesPanelView } from "./sources-panel.js";
import { KnowselfHubPanel, type HubTabDefinition } from "./hub-panel.js";
import { openHubTab, type HubTabId } from "./hub-tab.js";
import { GraphPanelIcon, HubPanelIcon } from "./icons.js";

/**
 * cordis 风格依赖服务 key（与 package.json 中 `dsh.client.inject` 的**服务包名**不同：
 * 这里是 apply 依赖的 ctx 服务键 `slots` / `layout`，见 A2-工单.md 原始蓝图）。
 */
export const inject: readonly ClientServiceKey[] = ["slots", "layout"];

/** KnowSelf 统一入口内的 tab 顺序（= 侧栏原来的 人物/画像/待整理/日志/资料）。 */
const HUB_TABS: readonly HubTabDefinition[] = [
  { id: "person", label: "人物", testId: "knowself-hub-tab-person" },
  { id: "profile", label: "画像", testId: "knowself-hub-tab-profile" },
  { id: "inbox", label: "待整理", testId: "knowself-hub-tab-inbox" },
  { id: "journal", label: "日志", testId: "knowself-hub-tab-journal" },
  { id: "sources", label: "资料", testId: "knowself-hub-tab-sources" },
];

/**
 * 旧面板 id → hub tab 的兼容别名。
 *
 * 这些 main key 仍注册（各渲染「停在对应 tab」的 KnowSelf），保证既有
 * `selectPanel` 调用不会命中 dsh 的未注册检查；侧栏不再展示它们。
 */
const HUB_TAB_ALIASES: ReadonlyArray<readonly [HubTabId, MainPanelId]> = [
  ["person", PERSON_PANEL_ID],
  ["profile", PROFILE_PANEL_ID],
  ["inbox", INBOX_PANEL_ID],
  ["journal", JOURNAL_PANEL_ID],
  ["sources", SOURCES_PANEL_ID],
];

/** 宿主可按需在 ctx 上注入的 knowSelf client 服务（duck typing，避免契约耦合）。 */
interface InjectedKnowselfServices {
  personPanelDataPort?: PersonPanelDataPort;
  /** M3：画像 / 日志端口（可选注入，缺省走同 origin REST）。 */
  profileDataPort?: KnowselfProfilePort;
  /** M3 波 3：图谱端口（可选注入，缺省走同 origin REST `/knowself-api/graph`）。 */
  graphDataPort?: KnowselfGraphPort;
}

/**
 * 读取宿主可选注入的 `ctx.knowself` 服务。
 *
 * cordis 的 Context 是 Proxy：访问**未在 inject 中声明**的服务键会直接抛
 * `cannot get property "x" without inject`（不是返回 undefined）。因此这里必须
 * 用 try/catch 做「探测」，不能用 `?.` 静默读取——否则插件会在 apply 阶段整体失败。
 */
function readInjectedServices(ctx: ClientContext): InjectedKnowselfServices | undefined {
  try {
    return (ctx as ClientContext & { knowself?: InjectedKnowselfServices }).knowself;
  } catch {
    return undefined;
  }
}

/**
 * 解析人物面板数据端口：优先 ctx 注入 → 显式注册的模块级端口 → 默认 REST 端口（B2）。
 */
function resolveDataPort(ctx: ClientContext): {
  port: PersonPanelDataPort;
  bridgeReady: boolean;
} {
  const injected = readInjectedServices(ctx)?.personPanelDataPort;
  if (injected !== undefined) {
    return { port: injected, bridgeReady: true };
  }
  if (isPersonPanelBridgeConfigured()) {
    return { port: getPersonPanelDataPort(), bridgeReady: true };
  }
  // B2：未注入且未显式注册端口时，默认走同 origin 的 REST 端口（bridgeReady=true）。
  // 保留 data-port.ts 的 UNAVAILABLE_PORT / getPersonPanelDataPort() 端口级语义不变
  // （A2 端口级单测仍通过），只让 apply 的真实渲染路径拿到真实数据通道。
  return { port: createRestDataPort(), bridgeReady: true };
}

/**
 * 解析画像 / 日志端口（M3）：优先 ctx 注入，否则默认同 origin REST 端口。
 * @param ctx dsh client Context
 */
function resolveProfilePort(ctx: ClientContext): KnowselfProfilePort {
  return readInjectedServices(ctx)?.profileDataPort ?? createRestProfilePort();
}

/**
 * 解析图谱端口（M3 波 3）：优先 ctx 注入，否则默认同 origin REST 端口。
 * @param ctx dsh client Context
 */
function resolveGraphPort(ctx: ClientContext): KnowselfGraphPort {
  return readInjectedServices(ctx)?.graphDataPort ?? createRestGraphPort();
}

/**
 * client 插件 apply：注册 KnowSelf 统一入口（含五个 tab）+ 知识图谱面板，以及
 * 对应的侧栏图标。
 * @param ctx dsh client Context（含 renderer 提供的 slots 与 layout 提供的 layout）
 */
export function apply(ctx: ClientContext): void {
  const { port, bridgeReady } = resolveDataPort(ctx);
  const profilePort = resolveProfilePort(ctx);
  const graphPort = resolveGraphPort(ctx);

  // keyed main 无 owner props → 用闭包把数据端口绑定进组件。
  // W-3：写端口默认走同 origin REST（`/knowself-api/write/*`）。
  // 只在 bridgeReady 时注入：未接桥的环境（浏览器直开）不该出现"点了必然失败"的按钮。
  const personWritePort = bridgeReady ? createRestPersonWritePort() : undefined;

  /**
   * 跳到统一入口的某个 tab（用于其它面板发起的跳转）。
   * 先更新 tab 状态（已挂载的 hub 会原地响应），再确保主面板是 KnowSelf。
   */
  const openHub = (tab: HubTabId): void => {
    openHubTab(tab);
    ctx.layout.selectPanel(HUB_PANEL_ID);
  };

  // 五个 tab 的内容。人物空态的「导入聊天记录」不再切到独立资料面板，
  // 而是跳到同一个入口内的「资料」tab。
  const tabViews: Record<HubTabId, ReactElement> = {
    person: (
      <PersonPanelView
        port={port}
        bridgeReady={bridgeReady}
        onImportChat={() => openHub("sources")}
        {...(personWritePort === undefined ? {} : { writePort: personWritePort })}
      />
    ),
    profile: <ProfilePanelView port={profilePort} />,
    inbox: <InboxPanelView port={profilePort} />,
    journal: <JournalPanelView port={profilePort} />,
    sources: <SourcesPanelView port={profilePort} />,
  };

  /**
   * 构造 KnowSelf 入口的 main 组件。
   * @param initialTab 该 main key 落到的 tab（兼容别名用）；缺省沿用模块级当前 tab
   */
  const hubPanel = (initialTab?: HubTabId): MainPanelComponent => () => (
    <KnowselfHubPanel
      tabs={HUB_TABS}
      renderTab={(tab) => tabViews[tab]}
      {...(initialTab === undefined ? {} : { initialTab })}
    />
  );

  // W-2：点击图谱里的人物节点 → 投递 handoff 并切到入口的「人物」tab。
  //      两个面板可能是**持续挂载**的，所以不能靠 props 直接传 selectedId，
  //      统一走 `panel-jump.ts` 的一次性投递（订阅 + 挂载兜底消费，见该文件头注）。
  const GraphPanel: MainPanelComponent = () => (
    <GraphPanelView
      port={graphPort}
      // W29 B2：认领面板复用已装配的人物写端口（未接桥时不注入，避免必然失败的按钮）。
      {...(personWritePort === undefined ? {} : { claimPort: personWritePort })}
      // 右键「合并到…」复用已装配的人物只读端口做目标搜索。
      personPort={port}
      onSelectPerson={(personId) => {
        focusPerson(personId);
        openHub("person");
      }}
    />
  );

  // list 侧栏图标接收 { size, active }；闭包注入 onSelect → ctx.layout.selectPanel。
  const HubIcon: SidebarPanelIconComponent = (props) => (
    <HubPanelIcon {...props} onSelect={() => ctx.layout.selectPanel(HUB_PANEL_ID)} />
  );
  const GraphIcon: SidebarPanelIconComponent = (props) => (
    <GraphPanelIcon {...props} onSelect={() => ctx.layout.selectPanel(GRAPH_PANEL_ID)} />
  );

  // ① 中央主区（keyed main）：KnowSelf 统一入口 + 五个旧 id 兼容别名 + 知识图谱。
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: HUB_PANEL_ID }, hubPanel()),
  );
  for (const [tab, panelId] of HUB_TAB_ALIASES) {
    ctx.slots.inject("main", () =>
      ctx.slots.register({ name: "main", key: panelId }, hubPanel(tab)),
    );
  }
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: GRAPH_PANEL_ID }, GraphPanel),
  );

  // ② 侧栏图标：KnowSelf（order 0）+ 图谱（order 1）。原来五个图标已合并。
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: HUB_PANEL_ID,
        order: 0,
        label: HUB_PANEL_LABEL,
        locale: KNOWSELF_LOCALE_NS,
      },
      HubIcon,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: GRAPH_PANEL_ID,
        order: 1,
        label: GRAPH_PANEL_LABEL,
        locale: KNOWSELF_LOCALE_NS,
      },
      GraphIcon,
    ),
  );
}
