/**
 * 图谱**设置浮层**（右上角 ⚙，Obsidian Graph View 的 Filters / Groups / Display / Forces）。
 *
 * 纯展示 + 回调：所有状态由面板持有（`GraphSettings`），本组件只渲染控件并把
 * 变化上抛（`onChange(patch)`）。四组设置 + 局部图谱深度，布局与设计稿
 * `ui-redesign-proposal.html` 的 `.flyout` 对齐。
 */
import type { ReactElement } from "react";
import { communityColor } from "./graph-colors.js";
import {
  SETTINGS_RANGES,
  type GraphSettings,
} from "./graph-settings.js";
import { COLORS, RADIUS, SPACE, TYPE } from "./ui-tokens.js";

/** 设置浮层 props。 */
export interface GraphSettingsPanelProps {
  /** 当前设置（面板持有）。 */
  settings: GraphSettings;
  /** 局部更新（只传变化的字段）。 */
  onChange: (patch: Partial<GraphSettings>) => void;
  /** 颜色分组图例（社区键 + 展示名；未分组键为 `null`）。 */
  communities: readonly { key: string | null; label: string }[];
  /**
   * 统计信息（节点/边/社区/生成时间/截断/候选边/度数上限等）。
   * 主界面不再显示这些诊断信息，全部收进这里，排查问题时点开 ⚙ 可查。
   */
  stats?: readonly string[];
  /**
   * 能力视图模式：隐藏**人物专属**的 4 项无效开关（社区聚合 / 仅看已建档 / 孤立节点 / 局部深度），
   * 保留通用渲染项（节点大小 / 连线粗细 / 标签淡出 / 力学四参 / 显示标签）。
   */
  abilityMode?: boolean;
  /** 关闭浮层。 */
  onClose: () => void;
}

/** 段落标题。 */
const SECTION_TITLE: React.CSSProperties = {
  ...TYPE.section,
  fontSize: 12,
  color: COLORS.text,
  margin: 0,
};

/** 段落容器。 */
const SECTION: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  fontSize: 12,
  color: COLORS.muted,
};

/** 一行「label + 滑杆」。 */
function RangeRow({
  label,
  value,
  min,
  max,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  testId: string;
  onChange: (value: number) => void;
}): ReactElement {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
      <span style={{ flexShrink: 0, width: 72 }}>{label}</span>
      <input
        type="range"
        data-testid={testId}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
      <span style={{ flexShrink: 0, width: 32, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </label>
  );
}

/** 一行「label + 复选」。 */
function CheckRow({
  label,
  checked,
  testId,
  onChange,
}: {
  label: string;
  checked: boolean;
  testId: string;
  onChange: (value: boolean) => void;
}): ReactElement {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
      <input type="checkbox" data-testid={testId} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

/**
 * 图谱设置浮层。
 * @param props 见 {@link GraphSettingsPanelProps}
 * @returns 浮层元素
 */
export function GraphSettingsPanel({
  settings,
  onChange,
  communities,
  stats = [],
  abilityMode = false,
  onClose,
}: GraphSettingsPanelProps): ReactElement {
  const set = <K extends keyof GraphSettings>(key: K, value: GraphSettings[K]): void => {
    onChange({ [key]: value } as Partial<GraphSettings>);
  };

  return (
    <div
      data-testid="graph-settings-panel"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 260,
        maxHeight: "70%",
        overflow: "auto",
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.card,
        boxShadow: "0 8px 24px rgba(0,0,0,.12)",
        padding: SPACE.md,
        display: "flex",
        flexDirection: "column",
        gap: SPACE.sm,
        zIndex: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <b style={{ ...SECTION_TITLE, fontSize: 13 }}>图谱设置</b>
        <button
          type="button"
          data-testid="graph-settings-close"
          onClick={onClose}
          style={{
            cursor: "pointer",
            border: "none",
            background: "transparent",
            color: COLORS.muted,
            fontSize: 14,
            padding: 0,
          }}
        >
          ✕
        </button>
      </div>

      <section style={SECTION}>
        <b style={SECTION_TITLE}>过滤</b>
        <input
          data-testid="graph-settings-search"
          placeholder="搜索人物 / 标签"
          value={settings.searchQuery}
          onChange={(event) => set("searchQuery", event.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontSize: 12,
            padding: "6px 8px",
            border: `1px solid ${COLORS.borderStrong}`,
            borderRadius: RADIUS.control,
            fontFamily: "inherit",
          }}
        />
        {!abilityMode && (
          <CheckRow
            label="显示未建档（孤儿）"
            checked={settings.showOrphans}
            testId="graph-settings-show-orphans"
            onChange={(value) => set("showOrphans", value)}
          />
        )}
        {!abilityMode && (
          <CheckRow
            label="只显示已建档"
            checked={settings.onlyProfiled}
            testId="graph-settings-only-profiled"
            onChange={(value) => set("onlyProfiled", value)}
          />
        )}
      </section>

      <section style={SECTION}>
        <b style={SECTION_TITLE}>颜色分组</b>
        <CheckRow
          label="按社区上色"
          checked={settings.colorByCommunity}
          testId="graph-settings-color-community"
          onChange={(value) => set("colorByCommunity", value)}
        />
        {!abilityMode && (
          <CheckRow
            label="按社区聚合（视图）"
            checked={settings.aggregateByCommunity}
            testId="graph-settings-aggregate-community"
            onChange={(value) => set("aggregateByCommunity", value)}
          />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 120, overflow: "auto" }}>
          {communities.map((entry) => (
            <span key={entry.key ?? "__ungrouped"} style={{ display: "inline-flex", alignItems: "center", gap: SPACE.sm }}>
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: communityColor(entry.key),
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</span>
            </span>
          ))}
        </div>
      </section>

      <section style={SECTION}>
        <b style={SECTION_TITLE}>显示</b>
        <RangeRow
          label="节点大小"
          value={settings.nodeSizeScale}
          min={SETTINGS_RANGES.nodeSizeScale.min}
          max={SETTINGS_RANGES.nodeSizeScale.max}
          testId="graph-settings-node-size"
          onChange={(value) => set("nodeSizeScale", value)}
        />
        <RangeRow
          label="连线粗细"
          value={settings.edgeWidthScale}
          min={SETTINGS_RANGES.edgeWidthScale.min}
          max={SETTINGS_RANGES.edgeWidthScale.max}
          testId="graph-settings-edge-width"
          onChange={(value) => set("edgeWidthScale", value)}
        />
      </section>

      <section style={SECTION}>
        <b style={SECTION_TITLE}>力学</b>
        <RangeRow
          label="中心力"
          value={settings.centerForce}
          min={SETTINGS_RANGES.centerForce.min}
          max={SETTINGS_RANGES.centerForce.max}
          testId="graph-settings-center-force"
          onChange={(value) => set("centerForce", value)}
        />
        <RangeRow
          label="斥力"
          value={settings.repulsionForce}
          min={SETTINGS_RANGES.repulsionForce.min}
          max={SETTINGS_RANGES.repulsionForce.max}
          testId="graph-settings-repulsion"
          onChange={(value) => set("repulsionForce", value)}
        />
        <RangeRow
          label="连力"
          value={settings.linkForce}
          min={SETTINGS_RANGES.linkForce.min}
          max={SETTINGS_RANGES.linkForce.max}
          testId="graph-settings-link-force"
          onChange={(value) => set("linkForce", value)}
        />
        <RangeRow
          label="连距"
          value={settings.linkDistance}
          min={SETTINGS_RANGES.linkDistance.min}
          max={SETTINGS_RANGES.linkDistance.max}
          testId="graph-settings-link-distance"
          onChange={(value) => set("linkDistance", value)}
        />
      </section>

      {!abilityMode && (
        <section style={{ ...SECTION, borderTop: `1px solid ${COLORS.border}`, paddingTop: SPACE.sm }}>
          <b style={SECTION_TITLE}>局部图谱</b>
          <RangeRow
            label="深度"
            value={settings.localDepth}
            min={SETTINGS_RANGES.localDepth.min}
            max={SETTINGS_RANGES.localDepth.max}
            testId="graph-settings-depth"
            onChange={(value) => set("localDepth", value)}
          />
          <span style={{ fontSize: 11, color: COLORS.subtle }}>
            选中某节点后（右键 → 聚焦局部图），只显示其 {settings.localDepth} 层邻居。
          </span>
        </section>
      )}

      {stats.length > 0 && (
        <section
          data-testid="graph-settings-stats"
          style={{ ...SECTION, borderTop: `1px solid ${COLORS.border}`, paddingTop: SPACE.sm }}
        >
          <b style={SECTION_TITLE}>统计</b>
          {stats.map((line, index) => (
            <span
              key={index}
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                color: COLORS.subtle,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }}
            >
              {line}
            </span>
          ))}
        </section>
      )}
    </div>
  );
}
