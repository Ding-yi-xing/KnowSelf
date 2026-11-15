/**
 * W29 B2：认领面板（侧栏，点击 direct / 未识别 person 节点后出现）。
 *
 * 职责：输入真名 → `claimPort.claimPerson({ sender_ref, display_name })` →
 * 成功 `onDone()`（主面板收起 + 重新取数）；失败按后端错误码显示可读中文。
 * 409（`alias_already_claimed`）显示「这个人已经被认领过了」，其余显示错误消息，
 * 不吞异常。只依赖 React 与注入的端口，零 UI 库。
 */
import { useState } from "react";
import type { CSSProperties, FormEvent, ReactElement } from "react";
import type { PersonWritePort } from "./person-write-port.js";
import { PANEL_COLORS, WRAP_TEXT } from "./panel-states.js";

/** props（端口只用到 claimPerson，取最小面便于测试桩注入）。 */
export interface GraphClaimPanelProps {
  claimPort: Pick<PersonWritePort, "claimPerson">;
  /** 目标节点当前显示的标签（给用户看的上下文）。 */
  nodeLabel: string;
  /** 认领目标：`wechat:<uid>`。 */
  senderRef: string;
  /** 成功后回调（主面板收起并刷新）。 */
  onDone: () => void;
  /** 取消。 */
  onCancel: () => void;
}

const S: Record<string, CSSProperties> = {
  wrap: {
    border: `1px solid ${PANEL_COLORS.border}`,
    borderRadius: 6,
    background: PANEL_COLORS.subtleBg,
    padding: 10,
    marginBottom: 8,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    fontSize: 13,
    padding: "6px 8px",
    border: `1px solid ${PANEL_COLORS.border}`,
    borderRadius: 4,
    color: PANEL_COLORS.text,
    background: PANEL_COLORS.surface,
  },
  btn: {
    cursor: "pointer",
    fontSize: 12,
    padding: "4px 12px",
    borderRadius: 4,
    border: `1px solid ${PANEL_COLORS.border}`,
    background: PANEL_COLORS.surface,
    color: PANEL_COLORS.text,
  },
};

/** 把端口抛出的错误翻译成可读中文（409 用后端 error 码判定，不猜状态码文案）。 */
function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("alias_already_claimed")) return "这个人已经被认领过了";
  return message;
}

/** 认领面板：三 testid 固定，提交中禁用输入与按钮。 */
export function GraphClaimPanel({
  claimPort,
  nodeLabel,
  senderRef,
  onDone,
  onCancel,
}: GraphClaimPanelProps): ReactElement {
  const [name, setName] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("请输入这个人的名字");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await claimPort.claimPerson({ sender_ref: senderRef, display_name: trimmed });
      onDone();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form data-testid="graph-claim-panel" onSubmit={(event) => void onSubmit(event)} style={S.wrap}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, ...WRAP_TEXT }}>
        {/* senderRef 含完整 wechat:uid，canvas 2D 无 per-node DOM，用原生 title 兜底上屏。 */}
        认领：<span title={senderRef}>{nodeLabel}</span>
      </div>
      <p style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: "0 0 8px", ...WRAP_TEXT }}>
        输入真名后，这个人会出现在图谱与人物档案里。
      </p>
      <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
        名字
        <input
          data-testid="claim-person-input"
          type="text"
          value={name}
          disabled={submitting}
          onChange={(event) => setName(event.currentTarget.value)}
          style={{ ...S.input, marginTop: 4 }}
        />
      </label>
      {error !== null && (
        <p
          role="alert"
          data-testid="claim-person-error"
          style={{ fontSize: 12, color: PANEL_COLORS.dangerText, ...WRAP_TEXT }}
        >
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="submit"
          data-testid="claim-person-submit"
          disabled={submitting}
          style={{
            ...S.btn,
            cursor: submitting ? "default" : "pointer",
            border: `1px solid ${PANEL_COLORS.accent}`,
            background: PANEL_COLORS.accentBg,
            color: PANEL_COLORS.accentText,
          }}
        >
          {submitting ? "认领中…" : "认领"}
        </button>
        <button type="button" disabled={submitting} onClick={onCancel} style={S.btn}>
          取消
        </button>
      </div>
    </form>
  );
}
