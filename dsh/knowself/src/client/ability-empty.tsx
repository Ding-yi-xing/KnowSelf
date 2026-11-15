/**
 * 能力视图**空态**（T05，0.5.0）：0 个能力节点时不许白屏。
 *
 * 文案方向（PM 定）：说明「还没蒸馏出能力项」+「确认待整理里的提案后会在这里生成」+
 * 一个「去待整理」按钮（参数化回调，拿不到待审数量就别硬凑数字）。
 *
 * testid：`ability-empty`。
 */
import type { CSSProperties, ReactElement } from "react";
import { PANEL_COLORS } from "./panel-states.js";

/** 空态 props。 */
export interface AbilityEmptyProps {
  /** 「去待整理」回调（跳到待整理面板）。缺省时按钮仍渲染、点击无副作用。 */
  onGoInbox?: () => void;
}

const WRAP: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: "40px 24px",
  textAlign: "center",
  color: PANEL_COLORS.muted,
  flex: 1,
};

/**
 * 能力视图空态。
 * @param props 见 {@link AbilityEmptyProps}
 * @returns 空态元素
 */
export function AbilityEmpty({ onGoInbox }: AbilityEmptyProps): ReactElement {
  return (
    <div data-testid="ability-empty" style={WRAP}>
      <div style={{ fontSize: 15, fontWeight: 600, color: PANEL_COLORS.text }}>你的资料还没蒸馏出能力项</div>
      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
        确认「待整理」里的提案后会在这里生成能力图谱。
      </div>
      <button
        type="button"
        data-testid="ability-empty-go-inbox"
        onClick={() => onGoInbox?.()}
        style={{
          cursor: "pointer",
          fontSize: 12,
          padding: "6px 14px",
          borderRadius: 4,
          border: `1px solid ${PANEL_COLORS.accent}`,
          background: PANEL_COLORS.accentBg,
          color: PANEL_COLORS.accentText,
          marginTop: 4,
        }}
      >
        去待整理
      </button>
    </div>
  );
}
