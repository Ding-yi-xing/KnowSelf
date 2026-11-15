/**
 * 图谱的**画布区**：舞台（canvas + 手势）+ 图例（C3 从 `graph-panel.tsx` 搬出，纯搬家）。
 *
 * 拆出来的理由与 `graph-toolbar.tsx` 相同：这段是"把 refs / 事件处理器塞进舞台"的接线，
 * 没有自己的状态。`GraphStage` / `GraphLegend` 仍在 `graph-stage.tsx`，这里只做组合，
 * 顺手保证「图例只在布局算出来之后出现」这条老行为不变。
 */
import type { ReactElement, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { GraphContextMenuActions } from "./graph-context-menu.js";
import type { GraphLayoutNode, GraphLayoutResult } from "./graph-layout.js";
import { GraphLegend, GraphStage } from "./graph-stage.js";

/** 画布区 props。 */
export interface GraphCanvasAreaProps {
  /** 舞台容器 ref（尺寸测量 + 手势挂载点）。 */
  containerRef: RefObject<HTMLDivElement | null>;
  /** canvas ref（绘制目标）。 */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** 当前布局（null = 尺寸还没量出来）。 */
  layout: GraphLayoutResult | null;
  /** 当前环境画不出 2D（显示不支持说明）。 */
  canvasUnsupported: boolean;
  /** 有节点被悬停（样式微调）。 */
  hovering: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onClick: (event: { clientX: number; clientY: number }) => void;
  /** 双击复位视口。 */
  onDoubleClick: () => void;
  /** W29 A3：悬停节点的完整 wxid（透传给 canvas 的原生 title）。 */
  canvasTitle?: string;
  /** 右键画布。 */
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** 当前打开的上下文菜单。 */
  contextMenu?: { node: GraphLayoutNode; position: { x: number; y: number } } | null;
  /** 上下文菜单动作。 */
  contextMenuActions?: GraphContextMenuActions | null;
  /** 图例是否按社区着色（决定色块/名字）。 */
  legendColorByCommunity?: boolean;
  /** 社区键 + 展示名（按社区上色时图例用）。 */
  legendCommunities?: readonly { key: string | null; label: string }[];
}

/**
 * 渲染舞台 + 图例。
 * @param props 见 {@link GraphCanvasAreaProps}
 * @returns 画布区元素
 */
export function GraphCanvasArea(props: GraphCanvasAreaProps): ReactElement {
  return (
    <>
      <GraphStage
        containerRef={props.containerRef}
        canvasRef={props.canvasRef}
        layout={props.layout}
        canvasUnsupported={props.canvasUnsupported}
        hovering={props.hovering}
        onPointerDown={props.onPointerDown}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
        onPointerCancel={props.onPointerUp}
        onPointerLeave={props.onPointerLeave}
        onClick={props.onClick}
        onDoubleClick={props.onDoubleClick}
        {...(props.canvasTitle === undefined ? {} : { canvasTitle: props.canvasTitle })}
        {...(props.onContextMenu === undefined ? {} : { onContextMenu: props.onContextMenu })}
        {...(props.contextMenu === undefined ? {} : { contextMenu: props.contextMenu })}
        {...(props.contextMenuActions === undefined ? {} : { contextMenuActions: props.contextMenuActions })}
      />
      {props.layout !== null && (
        <GraphLegend
          {...(props.legendColorByCommunity === undefined
            ? {}
            : { colorByCommunity: props.legendColorByCommunity })}
          {...(props.legendCommunities === undefined ? {} : { communities: props.legendCommunities })}
        />
      )}
    </>
  );
}
