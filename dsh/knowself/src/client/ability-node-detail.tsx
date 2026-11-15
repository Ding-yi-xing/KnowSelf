/**
 * 能力节点**详情侧栏**（T05，0.5.0）。
 *
 * PM 明确：「没有证据溯源就等于技能卡翻版」。所以详情除名称 / 度数 / 置信度外，
 * **必须展示来源资料卡列表 + 证据原文片段**（`attrs.evidence_ref` 每条是
 * `<card>#<section> 《title》: <body 前 80 字>`）。
 *
 * testid：`ability-node-detail` / `ability-evidence-list` / `ability-detail-close`。
 */
import type { CSSProperties, ReactElement } from "react";
import type { AbilityNode } from "@knowself/contracts";
import { PANEL_COLORS } from "./panel-states.js";

/** 详情侧栏 props。 */
export interface AbilityNodeDetailProps {
  /** 被选中的能力节点。 */
  node: AbilityNode;
  /** 关闭侧栏。 */
  onClose: () => void;
}

const PANEL: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  width: 320,
  maxHeight: "82%",
  overflow: "auto",
  background: PANEL_COLORS.surface,
  border: `1px solid ${PANEL_COLORS.border}`,
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,.12)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  zIndex: 7,
  fontSize: 12,
  color: PANEL_COLORS.text,
};

const ROW: CSSProperties = { display: "flex", gap: 8, lineHeight: 1.5 };

/**
 * 能力节点详情侧栏。
 * @param props 见 {@link AbilityNodeDetailProps}
 * @returns 侧栏元素
 */
export function AbilityNodeDetail({ node, onClose }: AbilityNodeDetailProps): ReactElement {
  return (
    <aside data-testid="ability-node-detail" style={PANEL}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <b style={{ fontSize: 14 }}>{node.label}</b>
        <button
          type="button"
          data-testid="ability-detail-close"
          onClick={onClose}
          title="关闭"
          style={{
            cursor: "pointer",
            border: "none",
            background: "transparent",
            color: PANEL_COLORS.muted,
            fontSize: 14,
            padding: 0,
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>

      <div style={ROW}>
        <span style={{ color: PANEL_COLORS.muted, minWidth: 56 }}>度数</span>
        <span>{node.degree}</span>
      </div>
      <div style={ROW}>
        <span style={{ color: PANEL_COLORS.muted, minWidth: 56 }}>置信度</span>
        <span>{node.confidence.toFixed(2)}</span>
      </div>

      <div>
        <div style={{ color: PANEL_COLORS.muted, marginBottom: 4 }}>来源资料卡</div>
        {node.attrs.card_keys.length === 0 ? (
          <span style={{ color: PANEL_COLORS.muted }}>—</span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {node.attrs.card_keys.map((key) => (
              <span
                key={key}
                style={{
                  border: `1px solid ${PANEL_COLORS.border}`,
                  borderRadius: 4,
                  padding: "1px 6px",
                  background: PANEL_COLORS.subtleBg,
                }}
              >
                {key}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={{ color: PANEL_COLORS.muted, marginBottom: 4 }}>证据原文</div>
        <ul
          data-testid="ability-evidence-list"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}
        >
          {node.attrs.evidence_ref.length === 0 ? (
            <li style={{ color: PANEL_COLORS.muted }}>暂无证据原文</li>
          ) : (
            node.attrs.evidence_ref.map((ref, index) => (
              <li
                key={index}
                style={{
                  borderLeft: `3px solid ${PANEL_COLORS.border}`,
                  padding: "2px 0 2px 8px",
                  lineHeight: 1.5,
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                }}
              >
                {ref}
              </li>
            ))
          )}
        </ul>
      </div>
    </aside>
  );
}
