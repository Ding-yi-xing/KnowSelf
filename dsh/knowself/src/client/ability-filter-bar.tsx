/**
 * 能力视图的**独立筛选栏**（T05，0.5.0）。
 *
 * 刻意**不塞进 ⚙**：这是能力视图专属的筛选维度（强度 / 关键词 / 置信），
 * 与人物图谱的 `GraphSettings` 各自独立、互不影响。纯展示 + `onChange(patch)` 上抛，
 * 状态由 `graph-panel.tsx` 持有（切走再切回不丢）。
 */
import type { CSSProperties, ReactElement } from "react";
import { PANEL_COLORS } from "./panel-states.js";
import type { AbilityFilters } from "./ability-filter.js";

/** 筛选栏 props。 */
export interface AbilityFilterBarProps {
  /** 当前筛选状态（面板持有）。 */
  filters: AbilityFilters;
  /** 局部更新筛选状态。 */
  onChange: (patch: Partial<AbilityFilters>) => void;
}

const BAR: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 14,
  padding: "6px 2px",
  fontSize: 12,
  color: PANEL_COLORS.muted,
  flexShrink: 0,
};

const GROUP_LABEL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  whiteSpace: "nowrap",
};

/**
 * 能力视图独立筛选栏。
 * @param props 见 {@link AbilityFilterBarProps}
 * @returns 筛选栏元素
 */
export function AbilityFilterBar({ filters, onChange }: AbilityFilterBarProps): ReactElement {
  return (
    <div data-testid="ability-filter-bar" style={BAR}>
      {/* 最小关联强度 */}
      <label style={GROUP_LABEL} title="只显示关联强度不低于该值的连线">
        强度≥
        <input
          type="range"
          data-testid="ability-filter-strength"
          min={0}
          max={1}
          step={0.05}
          value={filters.minStrength}
          onChange={(event) => onChange({ minStrength: Number(event.target.value) })}
          style={{ width: 90 }}
        />
        <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 28 }}>{filters.minStrength.toFixed(2)}</span>
      </label>

      {/* 仅看高置信 */}
      <label style={GROUP_LABEL}>
        <input
          type="checkbox"
          data-testid="ability-filter-confidence"
          checked={filters.highConfidenceOnly}
          onChange={(event) => onChange({ highConfidenceOnly: event.target.checked })}
        />
        仅看高置信
      </label>

      {/* 关键词搜索 */}
      <input
        type="search"
        data-testid="ability-filter-search"
        placeholder="搜索能力名"
        value={filters.search}
        onChange={(event) => onChange({ search: event.target.value })}
        style={{
          fontSize: 12,
          padding: "4px 8px",
          border: `1px solid ${PANEL_COLORS.border}`,
          borderRadius: 4,
          minWidth: 120,
        }}
      />
    </div>
  );
}
