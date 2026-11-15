/**
 * 本地 ambient 契约（A2）——dsh client 端最小类型面。
 *
 * 背景（见 A2-核实.md §2）：`ctx.slots` / `ctx.layout` 的真实类型由 dsh web 打包器注入的
 * 虚拟模块 `@deepseek-ai/dsh-client-ui-slots` 及各 UI 包的 `declare module` 增强提供。
 * 这些包在本独立 pnpm 子工作区中：
 *   - `@deepseek-ai/dsh-client-ui-slots` 实体包完全不存在（仅各 UI 包 devDependency）；
 *   - `dsh-client-ui-layout` / `-sidebar` / `-renderer` 只在 node_modules/.pnpm 虚拟存储，
 *     未链接到本工作区顶层，直接 import 会导致 typecheck 失败。
 *
 * 因此本文件按 **A2-核实.md §1 已核实的真实签名** 声明一份等价的最小契约：
 * client 源码只 `import type` 本模块（编译期擦除，运行期零依赖），不 import 任何
 * `@deepseek-ai/dsh-client-ui-*` 运行时包。落地 dsh 宿主/web 打包环境后，可把此契约
 * 替换为真实包类型；调用形状与核实结论逐字一致，无需改动 apply 逻辑。
 *
 * 形状来源（A2-核实.md）：
 *   - main：kind:'keyed', scope:'root'，register 选项 { name:'main', key: MainPanelId }
 *   - sidebar.panellist：kind:'list', scope:'root'，register 选项
 *     { name:'sidebar.panellist', id: MainPanelId, order, label:()=>string, locale }
 *     owner = SidebarPanelIconOwnerProps { size:number; active:boolean }
 *   - ctx.slots.inject(slotName, () => register(...)): disposer（声明门控）
 *   - ctx.layout.selectPanel(MainPanelId|null) / toggleSidebar() / openRightbar() / closeRightbar()
 *   - MainPanelId = Branded<'MainPanelId'>，运行期即普通字符串
 *
 * 注意：本文件保持为「script」（无顶层 import/export），`declare module` 才是环境模块声明；
 * 模块内部对 React 类型的引用一律用 `import("react").X` 内联查询，避免把文件变成 module
 * 而退化成「模块增强」。
 */
declare module "@knowself/dsh-client-contract" {
  /** 卸载器：注册返回的回收函数（cordis 风格）。 */
  export type Disposer = () => void;

  /**
   * MainPanelId —— 对 `@deepseek-ai/dsh-brand` 的 `Branded<'MainPanelId'>` 的本地最小复刻。
   * 编译期为 branded string，运行期就是普通字符串（brandString 为 identity）。
   */
  export type MainPanelId = string & { readonly __knowselfBrand: "MainPanelId" };

  /** 侧栏图标组件实际收到的 owner props（A2-核实.md §1.1 / §1.2）。 */
  export interface SidebarPanelIconOwnerProps {
    size: number;
    active: boolean;
  }

  /** keyed main 面板组件：无 owner props。 */
  export type MainPanelComponent = import("react").ComponentType;

  /** list 侧栏图标组件：接收 owner props。 */
  export type SidebarPanelIconComponent =
    import("react").ComponentType<SidebarPanelIconOwnerProps>;

  /** main（keyed）注册选项。 */
  export interface MainSlotOptions {
    name: "main";
    key: MainPanelId;
  }

  /**
   * sidebar.panellist（list）注册选项。
   * 注意：label 是 `() => string` 函数（locale 感知），不是 string；
   * SlotMap 元数据里的 `SidebarPanelMetadata.label` 才是 string。
   */
  export interface SidebarPanelListOptions {
    name: "sidebar.panellist";
    id: MainPanelId;
    order: number;
    label: () => string;
    locale: string;
  }

  /** 支持声明门控的 slot 名。 */
  export type SlotName = "main" | "sidebar.panellist";

  /** SlotRegistry —— `ctx.slots` 的最小契约（由 dsh-client-ui-renderer 提供）。 */
  export interface SlotRegistry {
    register(options: MainSlotOptions, component: MainPanelComponent): Disposer;
    register(
      options: SidebarPanelListOptions,
      component: SidebarPanelIconComponent,
    ): Disposer;
    /** 等该 slot 声明存在后再注册（声明门控），返回 disposer。 */
    inject(slotName: SlotName, factory: () => Disposer): Disposer;
  }

  /** LayoutController —— `ctx.layout` 的最小契约（由 dsh-client-ui-layout 提供）。 */
  export interface LayoutController {
    selectPanel(panelId: MainPanelId | null): void;
    toggleSidebar(): void;
    openRightbar(): void;
    closeRightbar(): void;
  }

  /** client 插件 apply 收到的 Context 最小面（真实 Context 由 cordis + 各 UI 包增强）。 */
  export interface ClientContext {
    slots: SlotRegistry;
    layout: LayoutController;
  }

  /** cordis 风格依赖服务 key（client 入口导出的 `inject` 常量用）。 */
  export type ClientServiceKey = "slots" | "layout";
}
