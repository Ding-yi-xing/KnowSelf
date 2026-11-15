/**
 * 图谱交互控件条：缩放 `+` / `−` / 重置 + **四选一视图模式**（群 / 人 / 仅与我直接关系 / 我的能力）
 * + 社区面包屑 + 截断提示 + ⚙ 设置入口。
 *
 * ## 为什么是「四选一」而不是边类型复选框
 * 用户明确要求把原来那排 `边类型：共现 / direct_reply / …` 复选框与「仅看我的直接关系」
 * 复选框，合并成**一组单选**：
 *   - 群：社区聚合视图（关系簇，无社区数据时降级为全量成员）；
 *   - 人：人物 / 单聊节点；
 *   - 仅与我直接关系：在「人」基础上只留以「我」为中心 N 层邻居（深度取 ⚙ 里的滑块）。
 *
 * ## 截断提示
 * 布局层 `MAX_RENDER_NODES = 200`，超出会静默丢节点。这里在命中上限时显示一行
 * 明确提示，避免用户以为「我的关系就这么点」。
 */
import type { ReactElement } from "react";
import type { GraphMode } from "./graph-subgraph.js";
import { PANEL_COLORS } from "./panel-states.js";
import { MIN_SCALE, MAX_SCALE } from "./graph-viewport.js";

/** 控件条 props。 */
export interface GraphControlsProps {
  /** 当前缩放系数（只用于显示）。 */
  scale: number;
  /** 放大一级。 */
  onZoomIn: () => void;
  /** 缩小一级。 */
  onZoomOut: () => void;
  /** 复位（铺满画布）。 */
  onReset: () => void;
  /** 当前视图模式（四选一）。 */
  mode: GraphMode;
  /** 切换视图模式。 */
  onChangeMode: (mode: GraphMode) => void;
  /** 是否处于社区聚合视图。 */
  communityView?: boolean;
  /** 当前下钻的社区键。 */
  communityDrill?: string | null;
  /** 下钻到空社区（面包屑旁显示「该社区暂无可见成员」）。 */
  communityEmpty?: boolean;
  /** 返回顶层。 */
  onCommunityBack?: () => void;
  /** 设置浮层是否展开（⚙ 按钮高亮）。 */
  settingsOpen?: boolean;
  /** 切换设置浮层。 */
  onToggleSettings?: () => void;
}

/** 模式选项（顺序即展示顺序：群 / 人 / 仅与我 / 我的能力）。 */
const MODE_OPTIONS: readonly { mode: GraphMode; label: string; testId: string }[] = [
  { mode: "group", label: "群", testId: "graph-mode-group" },
  { mode: "person", label: "人", testId: "graph-mode-person" },
  { mode: "neighbors", label: "仅与我直接关系", testId: "graph-mode-neighbors" },
  { mode: "ability", label: "我的能力", testId: "graph-mode-ability" },
];

/** 小按钮统一样式。 */
const BUTTON_STYLE = {
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.4,
  border: `1px solid ${PANEL_COLORS.border}`,
  background: PANEL_COLORS.subtleBg,
  color: PANEL_COLORS.text,
  borderRadius: 4,
  padding: "2px 9px",
} as const;

/**
 * 图谱控件条。
 * @param props 见 {@link GraphControlsProps}
 * @returns 控件条元素
 */
export function GraphControls({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
  mode,
  onChangeMode,
  communityView = false,
  communityDrill = null,
  communityEmpty = false,
  onCommunityBack,
  settingsOpen = false,
  onToggleSettings,
}: GraphControlsProps): ReactElement {
  return (
    <div
      data-testid="graph-controls"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        flexShrink: 0,
        fontSize: 12,
        color: PANEL_COLORS.muted,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <button
          type="button"
          data-testid="graph-zoom-out"
          title={`缩小（最小 ${MIN_SCALE}×）`}
          onClick={onZoomOut}
          style={BUTTON_STYLE}
        >
          −
        </button>
        <span data-testid="graph-zoom-level" style={{ minWidth: 38, textAlign: "center" }}>
          {scale.toFixed(2)}×
        </span>
        <button
          type="button"
          data-testid="graph-zoom-in"
          title={`放大（最大 ${MAX_SCALE}×）`}
          onClick={onZoomIn}
          style={BUTTON_STYLE}
        >
          +
        </button>
        <button type="button" data-testid="graph-reset" onClick={onReset} style={BUTTON_STYLE}>
          重置
        </button>
      </span>

      {/* 四选一：群 / 人 / 仅与我直接关系 / 我的能力（分段单选） */}
      <span
        data-testid="graph-mode"
        role="radiogroup"
        aria-label="视图模式"
        style={{
          display: "inline-flex",
          border: `1px solid ${PANEL_COLORS.border}`,
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {MODE_OPTIONS.map((option) => {
          const active = mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={option.testId}
              onClick={() => onChangeMode(option.mode)}
              style={{
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1.4,
                fontFamily: "inherit",
                fontWeight: active ? 600 : 400,
                border: "none",
                borderLeft: option.mode === "group" ? "none" : `1px solid ${PANEL_COLORS.border}`,
                background: active ? PANEL_COLORS.accentBg : PANEL_COLORS.surface,
                color: active ? PANEL_COLORS.accentText : PANEL_COLORS.text,
                padding: "4px 10px",
              }}
            >
              {option.label}
            </button>
          );
        })}
      </span>

      {communityView && (
        <span
          data-testid="graph-community-breadcrumb"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500, color: PANEL_COLORS.muted }}
        >
          {communityDrill === null ? (
            <span>全部社区</span>
          ) : (
            <>
              <button
                type="button"
                data-testid="graph-community-back"
                onClick={onCommunityBack}
                style={{
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "2px 8px",
                  border: `1px solid ${PANEL_COLORS.border}`,
                  background: PANEL_COLORS.surface,
                  color: PANEL_COLORS.text,
                  borderRadius: 6,
                  fontFamily: "inherit",
                }}
              >
                ← 全部社区
              </button>
              <span aria-hidden="true">/</span>
              <span title={communityDrill}>{`社区 ${communityDrill.replace(/^c:/, "").slice(0, 6)}`}</span>
            </>
          )}
        </span>
      )}

      {communityView && communityDrill !== null && communityEmpty && (
        <span data-testid="graph-community-empty" style={{ fontSize: 12, color: PANEL_COLORS.warnText }}>
          该社区暂无可见成员
        </span>
      )}

      <button
        type="button"
        data-testid="graph-settings"
        title="图谱设置"
        aria-expanded={settingsOpen}
        onClick={onToggleSettings}
        style={{
          ...BUTTON_STYLE,
          marginLeft: "auto",
          background: settingsOpen ? PANEL_COLORS.accentBg : PANEL_COLORS.subtleBg,
          color: settingsOpen ? PANEL_COLORS.accentText : PANEL_COLORS.text,
          borderColor: settingsOpen ? PANEL_COLORS.accent : PANEL_COLORS.border,
          fontWeight: 600,
        }}
      >
        ⚙
      </button>
    </div>
  );
}
