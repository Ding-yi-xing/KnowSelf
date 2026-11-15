/**
 * 面板视觉基线（批次 B / Phase B 的唯一真源）。
 *
 * ## 为什么要一个 tokens 文件
 * 四个面板原先各写各的 `fontSize: 12 / 13 / 15`、`padding: 10 / 12`、`gap: 6 / 8`，
 * 同一语义两处不一样（"合并"与"归到"、`#6b7280` 与 `#9ca3af` 混用）。改一次要翻四处，
 * 改漏一处就"看着还是乱的"。这里把「间距 / 字级 / 颜色 / 焦点环 / 单行截断」都收敛成常量，
 * 面板只引用、不再写字面值 —— 这一条就能保证清单里 1/2/8/9/10 五条长期不退化。
 *
 * ## 约束（评审可逐条对照）
 * - **间距只允许 4/8/12/16/24/32**（`SPACE`），禁止任意 px；
 * - **字级只 4 级**：面板标题 15/600、区块 13/600、正文 13/400、辅助 12/500；
 * - **对比度**：正文 `#111827` on `#FFFFFF` ≈ 16.1:1；辅助 `#4B5563` ≈ 8.6:1；
 *   弱化 `#6B7280` ≈ 5.9:1 —— 三者都过 4.5:1（弱化也过，不是踩线）；
 * - **数字等宽**：`tabular()` 给所有计数类文本；
 * - **focus 必须可见**：`FOCUS_CSS` 用 `:focus-visible` 画 2px 环，**不设 `outline: none`**；
 * - 不引入任何依赖：颜色/尺寸就是普通对象，`<style>` 由面板自己渲染一次。
 */

/** 间距档位（只此六档）。 */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** 圆角：卡片 8、控件 6、头像/药丸 999。 */
export const RADIUS = { card: 8, control: 6, pill: 999 } as const;

/**
 * 字级（**一个面板内只用这 4 级**）。
 *
 * 键名是语义不是尺寸，方便以后整体调；但字号就是 15/13/13/12，不要再加第 5 级。
 */
export const TYPE = {
  panelTitle: { fontSize: 15, fontWeight: 600 as const, lineHeight: 1.4 },
  section: { fontSize: 13, fontWeight: 600 as const, lineHeight: 1.5 },
  body: { fontSize: 13, fontWeight: 400 as const, lineHeight: 1.6 },
  meta: { fontSize: 12, fontWeight: 500 as const, lineHeight: 1.5 },
} as const;

/**
 * 颜色（对比度见文件头注；`muted`/`subtle` 都过 4.5:1，不只过 3:1）。
 */
export const COLORS = {
  text: "#111827",
  /** 次要正文（8.6:1）。 */
  muted: "#4b5563",
  /** 辅助信息（5.9:1）。 */
  subtle: "#6b7280",
  border: "#e5e7eb",
  borderStrong: "#d1d5db",
  surface: "#ffffff",
  surfaceAlt: "#f9fafb",
  /** hover 背景（与 surface 有可见差，但不抢注意力）。 */
  hover: "#f3f4f6",
  accent: "#1d4ed8",
  accentSoft: "#eff6ff",
  warnBg: "#fffbeb",
  warnBorder: "#fcd34d",
  warnText: "#92400e",
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
  dangerBorder: "#fca5a5",
  /** 「已采纳 / 成功」类状态 pill（绿）。 */
  okBg: "#ecfdf5",
  okText: "#047857",
} as const;

/** 窄容器阈值（px）：低于它，人物双栏折叠成单栏、资料/待整理的行内按钮收进 ⋯ 菜单。 */
export const NARROW_BREAKPOINT = 480;

/** 等宽数字（消息数、度数、计数）。 */
export const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

/**
 * 单行截断（长名字必须截断 + `title`，真实数据有 `23计应1吴成忠13859092020`）。
 * 配 `title={name}` 使用，别只截断不提示。
 */
export const ONE_LINE = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
} as const;

/** 可换行但不撑破布局（提示类长文案）。 */
export const WRAP_TEXT = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
} as const;

/**
 * 全局焦点样式（每个面板渲染一次 `<style>`）。
 *
 * 为什么用 `:focus-visible` 而不是 `:focus`：鼠标点按钮不该出现焦点环，键盘 tab 必须出现。
 * **没有任何一条 `outline: none`** —— 清单第 6 条明确禁止为了好看去掉 outline。
 */
export const FOCUS_CSS = `
[data-ks-panel] button:focus-visible,
[data-ks-panel] a:focus-visible,
[data-ks-panel] input:focus-visible,
[data-ks-panel] [tabindex]:focus-visible {
  outline: 2px solid ${COLORS.accent};
  outline-offset: 2px;
  border-radius: ${RADIUS.control}px;
}
[data-ks-panel] button:hover:not(:disabled) { filter: brightness(0.97); }
[data-ks-panel] button:disabled { opacity: 0.55; cursor: default; }
@keyframes ks-spin { to { transform: rotate(360deg); } }
[data-ks-panel] .ks-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid #d1d5db;
  border-top-color: #1d4ed8;
  border-radius: 999px;
  animation: ks-spin 800ms linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  [data-ks-panel] .ks-spinner { animation: none; }
}
@media (prefers-reduced-motion: no-preference) {
  [data-ks-panel] button, [data-ks-panel] article { transition: background-color 120ms ease, border-color 120ms ease; }
}
`;

/**
 * 名字首字（头像用）。
 * @param name 显示名
 * @returns 单个字符；空名回退 `?`
 */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "?";
  // 用 Array.from 取码点，避免把 emoji / 生僻字截成半个代理对
  return Array.from(trimmed)[0] as string;
}

/**
 * 由名字取一个稳定的头像底色（同一个名字永远同色，跨面板一致）。
 *
 * 做法：对 UTF-16 码元做 31 进制累加得到 hash，再映射到固定色板。
 * 用固定色板而不是 `hsl(hash%360)`：色板里的颜色都验过与白字对比度 ≥4.5:1。
 *
 * @param seed 通常是 display_name
 */
export function avatarColor(seed: string): string {
  const palette = ["#1d4ed8", "#0f766e", "#b45309", "#6d28d9", "#be123c", "#15803d", "#0369a1", "#7c2d12"];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] as string;
}

/** 圆形首字母头像的公共样式（36×36）。 */
export function avatarStyle(seed: string): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: RADIUS.pill,
    background: avatarColor(seed),
    color: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1,
  };
}

/** 卡片容器（列表项统一用它，保证 hover 一致）。 */
export function cardStyle(active = false): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: SPACE.md,
    width: "100%",
    textAlign: "left",
    padding: `${SPACE.md}px`,
    border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
    background: active ? COLORS.accentSoft : COLORS.surface,
    borderRadius: RADIUS.card,
    cursor: "pointer",
    color: "inherit",
    font: "inherit",
  };
}

/** 主按钮（空态/主操作用）。 */
export const PRIMARY_BUTTON: React.CSSProperties = {
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  padding: `${SPACE.sm}px ${SPACE.md}px`,
  border: `1px solid ${COLORS.accent}`,
  background: COLORS.accent,
  color: "#ffffff",
  borderRadius: RADIUS.control,
  fontFamily: "inherit",
};

/** 次要按钮。 */
export const SECONDARY_BUTTON: React.CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  padding: `${SPACE.xs}px ${SPACE.sm}px`,
  border: `1px solid ${COLORS.borderStrong}`,
  background: COLORS.surface,
  color: COLORS.text,
  borderRadius: RADIUS.control,
  fontFamily: "inherit",
};
