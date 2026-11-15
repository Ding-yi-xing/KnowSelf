/**
 * 图谱面板的**画布舞台与说明块**（W-2 从 `graph-panel.tsx` 抽出）。
 *
 * 三个纯展示组件，都不持有状态、不读数据端口：
 *   - {@link GraphStage}：canvas 容器（指针事件从 props 透传，canvas 尺寸由绘制侧设置）；
 *   - {@link GraphEmptyState}：无快照 / 无节点的空态（**不画空画布**）；
 *   - {@link GraphLegend}：节点类型色块 + 规模统计 + 截断说明。
 *
 * 抽出来的原因：`graph-panel.tsx` 拆分前 483 行（超 350 行上限），而这三块全是
 * 「结构 + 内联样式」，与取数 / 交互状态无关，放在面板里只会挤占可读性。
 */
import type { CSSProperties, MutableRefObject, ReactElement } from "react";
import type { GraphNodeKind } from "@knowself/contracts";
import { GRAPH_EMPTY_HINT } from "./graph-port.js";
import { NODE_COLORS, NODE_KIND_LABELS } from "./graph-canvas.js";
import { communityColor } from "./graph-colors.js";
import { GraphContextMenu, type GraphContextMenuActions } from "./graph-context-menu.js";
import type { GraphLayoutNode, GraphLayoutResult } from "./graph-layout.js";
import {
  EmptyNotice,
  LoadingNotice,
  PANEL_COLORS,
  WRAP_TEXT,
} from "./panel-states.js";

/** 画布最小高度（容器过矮时仍然可读）。 */
export const CANVAS_MIN_HEIGHT = 220;

/** 画布舞台 props。 */
export interface GraphStageProps {
  /** 舞台容器 ref（尺寸观测与坐标换算都靠它）。 */
  containerRef: MutableRefObject<HTMLDivElement | null>;
  /** canvas ref（绘制侧写入位图尺寸）。 */
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  /** 当前布局（仅用于「不支持 Canvas」提示里的节点/边计数）。 */
  layout: GraphLayoutResult | null;
  /** 环境是否不支持 Canvas 2D。 */
  canvasUnsupported: boolean;
  /** 指针是否正悬停在某个节点上（决定 cursor: pointer）。 */
  hovering: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onClick: (event: { clientX: number; clientY: number }) => void;
  onDoubleClick: () => void;
  /** W29 A3：悬停节点的完整 wxid。canvas 2D 无 per-node DOM，用原生 title 兜底上屏。 */
  canvasTitle?: string;
  /** 右键画布（命中节点 → 打开上下文菜单）。 */
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** 当前打开的上下文菜单（节点 + 局部坐标）。 */
  contextMenu?: { node: GraphLayoutNode; position: { x: number; y: number } } | null;
  /** 上下文菜单动作。 */
  contextMenuActions?: GraphContextMenuActions | null;
}

/**
 * canvas 舞台：一个相对定位的容器 + 绝对定位的 canvas + 不支持时的覆盖说明。
 * @param props 见 {@link GraphStageProps}
 * @returns 舞台元素
 */
export function GraphStage({
  containerRef,
  canvasRef,
  layout,
  canvasUnsupported,
  hovering,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onClick,
  onDoubleClick,
  canvasTitle,
  onContextMenu,
  contextMenu = null,
  contextMenuActions = null,
}: GraphStageProps): ReactElement {
  return (
    <div
      ref={containerRef}
      data-testid="graph-canvas-wrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{
        flex: 1,
        minHeight: CANVAS_MIN_HEIGHT,
        // The graph is an explorable world inside the panel, not a nested card.
        border: "none",
        borderRadius: 0,
        overflow: "hidden",
        background: "transparent",
        position: "relative",
        cursor: hovering ? "pointer" : "grab",
        touchAction: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="graph-canvas"
        // W29 A3：canvas 2D 没有 per-node DOM，用原生 title / aria-label 承载完整 wxid。
        title={canvasTitle}
        aria-label={canvasTitle}
        // 绝对定位：画布尺寸由绘制函数按容器尺寸显式设置，
        // 不让它反过来撑大容器（否则 ResizeObserver 会自我放大）。
        style={{ display: "block", position: "absolute", top: 0, left: 0 }}
      />
      {contextMenu !== null && contextMenuActions !== null && (
        <GraphContextMenu
          node={contextMenu.node}
          position={contextMenu.position}
          actions={contextMenuActions}
        />
      )}
      {canvasUnsupported && (
        <p style={UNSUPPORTED_STYLE}>
          当前环境不支持 Canvas 2D 绘制，无法显示关系图（数据本身已取到：
          {layout?.nodes.length ?? 0} 个节点 / {layout?.edges.length ?? 0} 条边）。
        </p>
      )}
    </div>
  );
}

/** 「不支持 Canvas」覆盖层样式。 */
const UNSUPPORTED_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  margin: 0,
  padding: 12,
  fontSize: 12,
  color: PANEL_COLORS.warnText,
  background: PANEL_COLORS.warnBg,
  ...WRAP_TEXT,
};

/**
 * 空态的三种成因（**不能共用一句话**，W-9 裁定）。
 *
 *   - `no-snapshot`：还没挖过 → 用宿主 hint，引导「去让助手挖一次」；
 *   - `no-nodes`   ：挖过但快照里没有可展示节点（互动都低于阈值）；
 *   - `no-relations`：**有节点但没有关系边** —— 当前数据只有「我 ↔ 助手」，
 *     没有第三方参与者。这种情况若还提示「去挖掘」，用户会反复挖、反复空，
 *     所以必须如实说清「挖掘过了，是数据里没有别人」。
 */
export type GraphEmptyKind = "no-data" | "not-mined" | "no-nodes" | "no-relations";

/** 空态 props。 */
export interface GraphEmptyStateProps {
  /** 空态成因（决定文案）。 */
  kind: GraphEmptyKind;
  /** 宿主给的提示（`kind === "no-snapshot"` 时优先使用）。 */
  hint?: string | undefined;
  /** 当前快照的节点数（`no-relations` 时展示事实）。 */
  nodeCount?: number | undefined;
  /** 当前快照的边数（`no-relations` 时展示事实）。 */
  edgeCount?: number | undefined;
  /** 触发挖掘（仅 `not-mined` 分支显示按钮）。 */
  onRunMining?: (() => void) | undefined;
  /** 挖掘进行中（按钮 disabled + 文案变化）。 */
  miningBusy?: boolean | undefined;
  /** 挖掘失败提示（非空即显示）。 */
  miningError?: string | null | undefined;
  /** 挖掘状态接口不可用（无法区分「没数据」与「没挖过」）。 */
  statusUnknown?: boolean | undefined;
  /** 重试拉取状态。 */
  onRetryStatus?: (() => void) | undefined;
  /** 点击刷新。 */
  onRefresh: () => void;
}

/** 三种空态的主文案。 */
const EMPTY_TEXT: Readonly<Record<GraphEmptyKind, string>> = {
  "no-data": "库里还没有聊天数据，所以还生成不了关系图。",
  "not-mined": "库里已有聊天数据，但还没有挖掘过，所以暂时没有关系图。",
  "no-nodes": "快照里没有可展示的节点（可能所有互动都低于阈值）。",
  "no-relations":
    "当前快照没有关系边：库里只有你与助手之间的对话，没有第三方参与者，因此暂无关系可展示。" +
    "导入含他人参与的聊天记录后可生成关系图。",
};

/**
 * 空态：只给提示，**绝不画空画布**（空画布会被误读成「图就是这样」或「加载失败」）。
 * @param props 见 {@link GraphEmptyStateProps}
 * @returns 空态元素
 */
export function GraphEmptyState({
  kind,
  hint,
  nodeCount,
  edgeCount,
  onRunMining,
  miningBusy,
  miningError,
  statusUnknown,
  onRetryStatus,
  onRefresh,
}: GraphEmptyStateProps): ReactElement {
  // no-data 有两种来路：①确定库里 0 条消息 → 指向「去导入」（不能让人去挖掘，挖了必然空）；
  // ②状态接口不可用（statusUnknown）→ 才退回宿主 hint，因为它讲的是通用情况。
  const text =
    kind === "no-data" && statusUnknown === true ? (hint ?? GRAPH_EMPTY_HINT) : EMPTY_TEXT[kind];
  return (
    <div data-testid="graph-empty" data-empty-kind={kind}>
      <EmptyNotice text={text} />
      {kind === "no-relations" && nodeCount !== undefined && edgeCount !== undefined && (
        <p
          data-testid="graph-empty-facts"
          style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: "6px 0 0", ...WRAP_TEXT }}
        >
          当前快照：{nodeCount} 个节点 / {edgeCount} 条边。
        </p>
      )}
      <p style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: "8px 0 0", ...WRAP_TEXT }}>
        {kind === "no-data"
          ? "先导入一份含他人参与的聊天记录（资料面板 → 导入聊天记录），导入后会自动挖掘并生成关系图。"
          : kind === "no-relations"
          ? "图谱来自「数据挖掘」：挖掘本身已完成，问题是数据里还没有他人参与。"
          : kind === "not-mined"
            ? "点下面的按钮直接开始挖掘，不需要回到对话里让助手代劳。"
            : "图谱由「数据挖掘」产出：先在对话里让助手执行一次挖掘，回到本面板刷新即可看到关系图。"}
      </p>
      {kind === "not-mined" && onRunMining !== undefined && (
        <button
          type="button"
          data-testid="graph-run-mining"
          onClick={onRunMining}
          disabled={miningBusy === true}
          style={{ ...REFRESH_BUTTON, ...(miningBusy === true ? { cursor: "progress", opacity: 0.7 } : {}) }}
        >
          {miningBusy === true ? "挖掘中…" : "开始挖掘"}
        </button>
      )}
      {miningError !== undefined && miningError !== null && (
        <p data-testid="graph-mining-error" style={{ fontSize: 12, color: PANEL_COLORS.dangerText, margin: "6px 0 0", ...WRAP_TEXT }}>
          挖掘失败：{miningError}
        </p>
      )}
      {statusUnknown === true && (
        <p data-testid="graph-status-unknown" style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: "6px 0 0", ...WRAP_TEXT }}>
          无法确认当前数据状态（状态接口未返回）。
          <button
            type="button"
            data-testid="graph-retry-status"
            onClick={onRetryStatus}
            style={{ marginLeft: 6, border: "none", background: "none", color: PANEL_COLORS.accentText, cursor: "pointer", fontSize: 12, padding: 0, textDecoration: "underline" }}
          >
            重试
          </button>
        </p>
      )}
      <button type="button" onClick={onRefresh} style={REFRESH_BUTTON}>
        刷新
      </button>
    </div>
  );
}

/** 空态「刷新」按钮样式（与降级态的重试按钮同视觉语言）。 */
const REFRESH_BUTTON: CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  marginTop: 8,
  border: `1px solid ${PANEL_COLORS.border}`,
  background: PANEL_COLORS.subtleBg,
  color: PANEL_COLORS.text,
  borderRadius: 4,
  padding: "3px 10px",
};

/** 图例 props。 */
export interface GraphLegendProps {
  /** 是否按社区着色（社区色块 / 节点类型色块）。 */
  colorByCommunity?: boolean;
  /** 社区键 + 展示名（`colorByCommunity` 时用；未分组键为 `null`）。 */
  communities?: readonly { key: string | null; label: string }[];
}

/** 图例单条（色点 + 名字）的样式。 */
const LEGEND_ITEM: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4 };

/** 色点样式。 */
function legendDot(color: string, key: string): ReactElement {
  return (
    <span
      key={key}
      aria-hidden="true"
      style={{
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
      }}
    />
  );
}

/**
 * 图例：**色点 + 社区名/类型名**（不再有「节点颜色 = …」这种解释性句子，也不含任何计数）。
 *
 * - 按社区上色：多色点时**色块并列**（并列本身即表达「颜色 = 社区」）；单色点时只显示那一个名字；
 * - 按类型上色：显示 人物 / 群 / 话题 / 单聊 的色点 + 类型名。
 *
 * `graph-legend` testid 保留。节点/边/截断等统计已全部收进 ⚙「统计」小节。
 * @param props 见 {@link GraphLegendProps}
 * @returns 图例元素
 */
export function GraphLegend({ colorByCommunity = true, communities = [] }: GraphLegendProps): ReactElement {
  let content: ReactElement[];
  if (colorByCommunity) {
    if (communities.length <= 1) {
      const only = communities[0];
      content = [
        <span key="single" style={LEGEND_ITEM}>
          {legendDot(communityColor(only?.key ?? null), "dot-single")}
          {only?.label ?? "社区"}
        </span>,
      ];
    } else {
      // 多色点：色块并列，不加解释文字
      content = communities.slice(0, 12).map((entry, index) =>
        legendDot(communityColor(entry.key), `dot-${entry.key ?? "u"}-${index}`),
      );
    }
  } else {
    const kinds: GraphNodeKind[] = ["person", "group", "topic", "direct"];
    content = kinds.map((kind) => (
      <span key={kind} style={LEGEND_ITEM}>
        {legendDot(NODE_COLORS[kind] ?? "#334155", `dot-${kind}`)}
        {NODE_KIND_LABELS[kind]}
      </span>
    ));
  }
  return (
    <div
      data-testid="graph-legend"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        color: PANEL_COLORS.muted,
        flexShrink: 0,
      }}
    >
      {content}
    </div>
  );
}

/** 加载中提示的透传（保持面板侧 import 面最小）。 */
export { LoadingNotice };
