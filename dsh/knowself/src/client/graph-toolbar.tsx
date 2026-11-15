/**
 * 图谱面板的**头部**与**控件条**（C3 从 `graph-panel.tsx` 搬出，纯搬家）。
 *
 * ## 为什么拆成两个导出而不是一个
 * 原结构里 `<header>` 在**body 之外**，`<GraphControls>` 在 **body 之内**（notices 之后）。
 * 合成一个组件就会改变 DOM 顺序（控件跑到 notices 之上）。所以分开导出，
 * 面板在原来的位置各放一次 —— 拆分只许搬家，不许动顺序。
 *
 * ## 头部只留标题
 * 「共 N 节点 / M 边 · 生成于 …」这类**统计/诊断批注**已从主界面移除，收进 ⚙ 设置面板
 * 的「统计」小节（见 `graph-settings-panel.tsx`）。头部只剩 h2 标题。
 */
import type { ReactElement } from "react";
import { GraphControls } from "./graph-controls.js";
import type { GraphMode } from "./graph-subgraph.js";

/**
 * 面板头部：只有标题（统计已挪进 ⚙）。
 * @returns 头部元素
 */
export function GraphPanelHeader(): ReactElement {
  return (
    <header style={{ padding: "12px 16px 8px", flexShrink: 0 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>知识图谱</h2>
    </header>
  );
}

/** 控件条 props（缩放 / 模式 / 截断提示，全部由面板透传）。 */
export interface GraphToolbarProps {
  /** 当前缩放档位（`0.5`–`3`）。 */
  scale: number;
  /** 放大一档。 */
  onZoomIn: () => void;
  /** 缩小一档。 */
  onZoomOut: () => void;
  /** 复位视口。 */
  onReset: () => void;
  /** 当前视图模式（群 / 人 / 仅与我直接关系）。 */
  mode: GraphMode;
  /** 切换视图模式。 */
  onChangeMode: (mode: GraphMode) => void;
  /** 是否处于社区聚合视图（决定是否显示面包屑）。 */
  communityView?: boolean;
  /** 当前下钻的社区键（null = 顶层）。 */
  communityDrill?: string | null;
  /** 下钻到空社区（面包屑旁提示「该社区暂无可见成员」）。 */
  communityEmpty?: boolean;
  /** 返回顶层社区视图。 */
  onCommunityBack?: () => void;
  /** 设置浮层是否展开。 */
  settingsOpen?: boolean;
  /** 切换设置浮层。 */
  onToggleSettings?: () => void;
}

/**
 * 控件条：缩放按钮 + 四选一模式 + 面包屑 + 截断提示。
 * @param props 见 {@link GraphToolbarProps}
 * @returns 控件元素
 */
export function GraphToolbar(props: GraphToolbarProps): ReactElement {
  return (
    <GraphControls
      scale={props.scale}
      onZoomIn={props.onZoomIn}
      onZoomOut={props.onZoomOut}
      onReset={props.onReset}
      mode={props.mode}
      onChangeMode={props.onChangeMode}
      {...(props.communityView === undefined ? {} : { communityView: props.communityView })}
      {...(props.communityDrill === undefined ? {} : { communityDrill: props.communityDrill })}
      {...(props.communityEmpty === undefined ? {} : { communityEmpty: props.communityEmpty })}
      {...(props.onCommunityBack === undefined ? {} : { onCommunityBack: props.onCommunityBack })}
      {...(props.settingsOpen === undefined ? {} : { settingsOpen: props.settingsOpen })}
      {...(props.onToggleSettings === undefined ? {} : { onToggleSettings: props.onToggleSettings })}
    />
  );
}
