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
 * 数据（B2 已接通）：人物面板只依赖 `PersonPanelDataPort`（见 data-port.ts 头注）。端口优先级：
 * ① `ctx.knowself.personPanelDataPort` 显式注入 → ② `setPersonPanelDataPort()` 模块级显式注册
 * → ③ 默认 `createRestDataPort()`（同 origin `/knowself-api` REST 端口，bridgeReady=true）。
 * `UNAVAILABLE_PORT` / `getPersonPanelDataPort()` 的端口级「未配置」语义保持不变（A2 单测仍成立）；
 * 变化只在 `apply` 的真实渲染路径：不再显示「数据桥接待接入」，改由 REST 端口取真实数据，
 * fetch 失败时走 `PersonPanelView` 既有的「数据读取失败」错误态。
 *
 * M3（只读面板阶段）新增四个面板，数据经 `KnowselfProfilePort`（`profile-port.ts`）：
 *   ④ 画像 `knowself-profile`（L1 core + L2 cards）+ 侧栏 order=2
 *   ⑤ 日志 `knowself-journal`（L3 journal）+ 侧栏 order=4
 *   ⑥ 待整理 `knowself-inbox`（pending proposals，无写按钮）+ 侧栏 order=3
 *   ⑦ 资料 `knowself-sources`（sources 列表）+ 侧栏 order=5
 * 侧栏最终 order = 人物 0 / 图谱 1 / 画像 2 / 待整理 3 / 日志 4 / 资料 5，
 * **既有 person=0 / graph=1 / profile=2 / journal=4 全部未改动**（只插入 3 与 5）。
 *
 * M3 波 3：图谱面板由占位改为真实实现，数据经 `KnowselfGraphPort`（`graph-port.ts`，
 * 默认 `GET /knowself-api/graph`）；**注册位置与 order=1 保持不变**，只替换组件实现。
 */
import type {
  ClientContext,
  ClientServiceKey,
  MainPanelComponent,
  SidebarPanelIconComponent,
} from "@knowself/dsh-client-contract";
import {
  GRAPH_PANEL_ID,
  GRAPH_PANEL_LABEL,
  INBOX_PANEL_ID,
  INBOX_PANEL_LABEL,
  JOURNAL_PANEL_ID,
  JOURNAL_PANEL_LABEL,
  KNOWSELF_LOCALE_NS,
  PERSON_PANEL_ID,
  PERSON_PANEL_LABEL,
  PROFILE_PANEL_ID,
  PROFILE_PANEL_LABEL,
  SOURCES_PANEL_ID,
  SOURCES_PANEL_LABEL,
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
import {
  GraphPanelIcon,
  InboxPanelIcon,
  JournalPanelIcon,
  PersonPanelIcon,
  ProfilePanelIcon,
  SourcesPanelIcon,
} from "./icons.js";

/**
 * cordis 风格依赖服务 key（与 package.json 中 `dsh.client.inject` 的**服务包名**不同：
 * 这里是 apply 依赖的 ctx 服务键 `slots` / `layout`，见 A2-工单.md 原始蓝图）。
 */
export const inject: readonly ClientServiceKey[] = ["slots", "layout"];

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
 * client 插件 apply：注册人物档案 / 知识图谱 / 画像 / 日志 / 待整理 / 资料六个面板的 main
 * 与侧栏图标，并把图标点击接到 `ctx.layout.selectPanel`。
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
  const PersonPanel: MainPanelComponent = () => (
    <PersonPanelView
      port={port}
      bridgeReady={bridgeReady}
      // 空态「导入聊天记录」→ 切到资料面板（导入表单在 `SourcesAddForm` 的「添加资料」里）。
      // 面板本身不碰导入端点：`ChatImportPort` 那条链路归资料面板，这里只做跳转。
      onImportChat={() => ctx.layout.selectPanel(SOURCES_PANEL_ID)}
      {...(personWritePort === undefined ? {} : { writePort: personWritePort })}
    />
  );
  // M3 波 3：图谱从占位视图改为真实实现（canvas 力导向图），数据经 KnowselfGraphPort。
  // W-2：点击图谱里的人物节点 → 投递 handoff 并切到人物面板（`ctx.layout.selectPanel`）。
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
        ctx.layout.selectPanel(PERSON_PANEL_ID);
      }}
    />
  );
  const ProfilePanel: MainPanelComponent = () => <ProfilePanelView port={profilePort} />;
  const JournalPanel: MainPanelComponent = () => <JournalPanelView port={profilePort} />;
  const InboxPanel: MainPanelComponent = () => <InboxPanelView port={profilePort} />;
  const SourcesPanel: MainPanelComponent = () => <SourcesPanelView port={profilePort} />;

  // list 侧栏图标接收 { size, active }；闭包注入 onSelect → ctx.layout.selectPanel。
  const PersonIcon: SidebarPanelIconComponent = (props) => (
    <PersonPanelIcon
      {...props}
      onSelect={() => ctx.layout.selectPanel(PERSON_PANEL_ID)}
    />
  );
  const GraphIcon: SidebarPanelIconComponent = (props) => (
    <GraphPanelIcon
      {...props}
      onSelect={() => ctx.layout.selectPanel(GRAPH_PANEL_ID)}
    />
  );
  const ProfileIcon: SidebarPanelIconComponent = (props) => (
    <ProfilePanelIcon
      {...props}
      onSelect={() => ctx.layout.selectPanel(PROFILE_PANEL_ID)}
    />
  );
  const JournalIcon: SidebarPanelIconComponent = (props) => (
    <JournalPanelIcon
      {...props}
      onSelect={() => ctx.layout.selectPanel(JOURNAL_PANEL_ID)}
    />
  );
  const InboxIcon: SidebarPanelIconComponent = (props) => (
    <InboxPanelIcon
      {...props}
      onSelect={() => ctx.layout.selectPanel(INBOX_PANEL_ID)}
    />
  );
  const SourcesIcon: SidebarPanelIconComponent = (props) => (
    <SourcesPanelIcon
      {...props}
      onSelect={() => ctx.layout.selectPanel(SOURCES_PANEL_ID)}
    />
  );

  // ① / ② 中央主区（keyed main）：人物 + 图谱 + 画像 + 日志 + 待整理 + 资料
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: PERSON_PANEL_ID }, PersonPanel),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: GRAPH_PANEL_ID }, GraphPanel),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: PROFILE_PANEL_ID }, ProfilePanel),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: JOURNAL_PANEL_ID }, JournalPanel),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: INBOX_PANEL_ID }, InboxPanel),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: SOURCES_PANEL_ID }, SourcesPanel),
  );

  // ③ 侧栏图标（list sidebar.panellist）：label 为 locale 感知函数、id 复用面板 id。
  //    order 依次 0 / 1 / 2 / 3 / 4 / 5——3（待整理 inbox）、5（资料 sources）为 M3 波 2
  //    新增，既有 person=0 / graph=1 / profile=2 / journal=4 全部未动。
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PERSON_PANEL_ID,
        order: 0,
        label: PERSON_PANEL_LABEL,
        locale: KNOWSELF_LOCALE_NS,
      },
      PersonIcon,
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
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PROFILE_PANEL_ID,
        order: 2,
        label: PROFILE_PANEL_LABEL,
        locale: KNOWSELF_LOCALE_NS,
      },
      ProfileIcon,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: INBOX_PANEL_ID,
        order: 3,
        label: INBOX_PANEL_LABEL,
        locale: KNOWSELF_LOCALE_NS,
      },
      InboxIcon,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: JOURNAL_PANEL_ID,
        order: 4,
        label: JOURNAL_PANEL_LABEL,
        locale: KNOWSELF_LOCALE_NS,
      },
      JournalIcon,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: SOURCES_PANEL_ID,
        order: 5,
        label: SOURCES_PANEL_LABEL,
        locale: KNOWSELF_LOCALE_NS,
      },
      SourcesIcon,
    ),
  );
}
