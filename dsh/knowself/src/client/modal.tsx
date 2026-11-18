/**
 * 共享的遮罩弹窗与二次确认对话框。
 *
 * 为什么不用 `window.confirm`：Electron / dsh web 里原生对话框样式不可控、无法承载
 * 合并搜索这类复杂内容，也无法被 UI 测试驱动。这里用固定定位的遮罩 + `role="dialog"`，
 * 所有面板复用同一套交互（Esc 关闭、点遮罩关闭、取消/确认按钮）。
 *
 * 注意：不引入 portal，直接渲染在面板内；`position: fixed` 相对视口定位，
 * 在 jsdom 与真实浏览器里都能工作。
 */
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ReactElement } from "react";
import { COLORS, RADIUS, SPACE, TYPE } from "./ui-tokens.js";

/** 弹窗基础 props。 */
export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区（通常是取消/确认按钮）。 */
  footer?: ReactNode;
  /** 弹窗最大宽度（px）。 */
  width?: number;
  testId?: string;
}

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  background: "rgba(17, 24, 39, 0.46)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: SPACE.xl,
};

const DIALOG: CSSProperties = {
  width: "100%",
  maxHeight: "calc(100vh - 48px)",
  overflowY: "auto",
  background: COLORS.surface,
  border: `1px solid ${COLORS.border}`,
  borderRadius: RADIUS.card,
  boxShadow: "0 24px 64px rgba(15, 23, 42, 0.28)",
  padding: SPACE.xl,
  boxSizing: "border-box",
};

const CLOSE_BUTTON: CSSProperties = {
  border: "none",
  background: "transparent",
  color: COLORS.subtle,
  cursor: "pointer",
  fontSize: 20,
  lineHeight: 1,
  padding: 0,
  width: 28,
  height: 28,
  borderRadius: RADIUS.control,
};

const CANCEL_BUTTON: CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  padding: `5px ${SPACE.md}px`,
  border: `1px solid ${COLORS.border}`,
  background: COLORS.surface,
  color: COLORS.text,
  borderRadius: RADIUS.control,
};

const CONFIRM_BUTTON: CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  padding: `5px ${SPACE.md}px`,
  border: `1px solid ${COLORS.accent}`,
  background: COLORS.accent,
  color: "#fff",
  borderRadius: RADIUS.control,
};

const DANGER_BUTTON: CSSProperties = {
  ...CONFIRM_BUTTON,
  borderColor: COLORS.danger,
  background: COLORS.danger,
};

/**
 * 通用遮罩弹窗。
 * Esc 或点击遮罩关闭；点击弹窗内容不会关闭。
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 560,
  testId,
}: ModalProps): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid={testId}
      style={OVERLAY}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ ...DIALOG, maxWidth: width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACE.md, marginBottom: SPACE.md }}>
          <h2 style={{ ...TYPE.panelTitle, fontSize: 16, margin: 0 }}>{title}</h2>
          <button type="button" aria-label="关闭" onClick={onClose} style={CLOSE_BUTTON}>
            ×
          </button>
        </div>
        {children}
        {footer ?? null}
      </div>
    </div>
  );
}

/** 二次确认对话框 props。 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 后果说明（可含重点）。 */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
  confirmTestId?: string;
}

/**
 * 二次确认：只负责“问一句”，不执行写操作本身。
 * 确认按钮在 `busy` 时禁用，避免连点。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  testId,
  confirmTestId,
}: ConfirmDialogProps): ReactElement | null {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={440}
      {...(testId === undefined ? {} : { testId })}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: SPACE.sm, marginTop: SPACE.lg }}>
          <button type="button" onClick={onCancel} disabled={busy} style={CANCEL_BUTTON}>
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={busy}
            style={danger ? { ...DANGER_BUTTON, cursor: busy ? "default" : "pointer" } : { ...CONFIRM_BUTTON, cursor: busy ? "default" : "pointer" }}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div style={{ fontSize: 13, lineHeight: 1.7, color: COLORS.muted }}>{message}</div>
    </Modal>
  );
}
