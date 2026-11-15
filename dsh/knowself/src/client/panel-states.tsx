/**
 * 面板通用状态块与字段行（M3）——画像面板 / 日志面板共用。
 *
 * 三种**必须区分**的态（05 §14 共同约束 4）：
 *   ① 降级（503）→ 「数据层未就绪：<reason>」+ 重试按钮；
 *   ② 会话失效（401）→ 「会话已失效，请重新打开 dsh web」（无重试按钮，重试没有意义）；
 *   ③ 其它错误 → 「数据读取失败：<message>」（无重试按钮）。
 *
 * 视觉沿用 `person-panel.tsx` 的样式与留白：原生元素 + 内联样式，零 UI 库依赖；
 * 文字一律深色（light 主题下 #111827 正文 / #6b7280 次要信息），长文本一律
 * `overflow-wrap: anywhere`，绝不撑破面板。
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";

/** 面板通用配色（与 person-panel 保持一致，集中一处便于将来换主题）。 */
export const PANEL_COLORS = {
  text: "#111827",
  muted: "#6b7280",
  border: "#e5e7eb",
  surface: "#fff",
  accent: "#2563eb",
  accentBg: "#eff6ff",
  accentText: "#1d4ed8",
  warnBorder: "#fcd34d",
  warnBg: "#fffbeb",
  warnText: "#92400e",
  dangerText: "#b91c1c",
  subtleBg: "#f9fafb",
} as const;

/** 长文本安全样式：换行 + 允许任意位置断行，避免撑破面板。 */
export const WRAP_TEXT: CSSProperties = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  whiteSpace: "pre-wrap",
  margin: 0,
};

/** 「加载中…」提示。 */
export function LoadingNotice({ text = "加载中…" }: { text?: string }): ReactElement {
  // 清单第 5 条：加载态**不许空白**。spinner 的关键帧在 `ui-tokens.ts` 的 FOCUS_CSS 里，
  // 由各面板的 `PanelShell` 注入一次；这里只负责长相与读屏文案。
  return (
    <p
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        fontWeight: 500,
        color: PANEL_COLORS.muted,
        margin: "4px 0",
      }}
    >
      <span className="ks-spinner" aria-hidden="true" />
      {text}
    </p>
  );
}

/**
 * 空态提示（清单第 4 条：**图标 + 一句话 + 可选主按钮**，不许一行灰字）。
 *
 * `text` 原样渲染 —— 既有测试断言 `还没有资料。` / `没有待整理的提案。` 等原文。
 *
 * @param props.text 一句话说明（保留既有原文）
 * @param props.icon 顶部图标（emoji；缺省给一个中性图标）
 * @param props.action 主按钮（可选）
 */
export function EmptyNotice({
  text,
  icon = "📭",
  action,
}: {
  text: string;
  icon?: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "24px 16px",
        border: `1px dashed ${PANEL_COLORS.border}`,
        borderRadius: 8,
        background: PANEL_COLORS.subtleBg,
        textAlign: "center",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 28, lineHeight: 1, opacity: 0.75 }}>
        {icon}
      </span>
      <span style={{ fontSize: 13, color: PANEL_COLORS.muted }}>{text}</span>
      {action ?? null}
    </div>
  );
}

/**
 * 降级（503）提示：可读原因 + 重试按钮。
 * @param reason 已脱敏的降级原因（来自 `DegradedError.reason`）
 * @param onRetry 点击重试回调
 * @param testId 供测试定位的 data-testid
 */
export function DegradedNotice({
  reason,
  onRetry,
  testId,
}: {
  reason: string;
  onRetry: () => void;
  testId: string;
}): ReactElement {
  return (
    <div
      role="alert"
      data-testid={testId}
      style={{
        fontSize: 12,
        lineHeight: 1.6,
        color: PANEL_COLORS.warnText,
        background: PANEL_COLORS.warnBg,
        border: `1px solid ${PANEL_COLORS.warnBorder}`,
        borderRadius: 6,
        padding: 8,
        marginBottom: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, ...WRAP_TEXT }}>
        数据层未就绪：{reason}
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          cursor: "pointer",
          fontSize: 12,
          border: "1px solid #d97706",
          background: PANEL_COLORS.surface,
          color: PANEL_COLORS.warnText,
          borderRadius: 4,
          padding: "3px 10px",
        }}
      >
        重试
      </button>
    </div>
  );
}

/**
 * 会话失效（401）提示：**不给重试按钮**——重新 fetch 不可能自愈，必须重开 dsh web。
 * @param testId 供测试定位的 data-testid
 */
export function SessionExpiredNotice({ testId }: { testId: string }): ReactElement {
  return (
    <div
      role="alert"
      data-testid={testId}
      style={{
        fontSize: 12,
        lineHeight: 1.6,
        color: PANEL_COLORS.warnText,
        background: PANEL_COLORS.warnBg,
        border: `1px solid ${PANEL_COLORS.warnBorder}`,
        borderRadius: 6,
        padding: 8,
        marginBottom: 12,
        ...WRAP_TEXT,
      }}
    >
      会话已失效，请重新打开 dsh web
    </div>
  );
}

/** 通用错误提示（非 401 / 非 503）。 */
export function ErrorNotice({
  message,
  testId,
}: {
  message: string;
  testId: string;
}): ReactElement {
  return (
    <p
      role="alert"
      data-testid={testId}
      style={{ fontSize: 12, color: PANEL_COLORS.dangerText, ...WRAP_TEXT }}
    >
      数据读取失败：{message}
    </p>
  );
}

/** 一行「标签 + 值」（值与 person-panel 的 Field 同形，长值自动换行）。 */
export function InfoField({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}): ReactElement {
  const isEmpty = value === null || value === undefined || value === "";
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "4px 0",
        fontSize: 13,
        // 计数类字段（字符数/提案数）用等宽数字，竖排时能对齐
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ color: PANEL_COLORS.muted, minWidth: 92, flexShrink: 0 }}>{label}</span>
      <span style={{ ...WRAP_TEXT, whiteSpace: "pre-wrap", color: PANEL_COLORS.text }}>
        {isEmpty ? "—" : value}
      </span>
    </div>
  );
}

/** 标签芯片行（section_tags / journal tags）。 */
export function TagChips({ tags }: { tags: readonly string[] }): ReactElement {
  if (tags.length === 0) {
    return <span style={{ fontSize: 13, color: PANEL_COLORS.muted }}>—</span>;
  }
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {tags.map((tag) => (
        <span
          key={tag}
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            color: PANEL_COLORS.accentText,
            background: PANEL_COLORS.accentBg,
            border: `1px solid #bfdbfe`,
            borderRadius: 10,
            padding: "0 8px",
          }}
        >
          {tag}
        </span>
      ))}
    </span>
  );
}
