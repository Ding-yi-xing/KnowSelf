/**
 * 四个面板共用的**表现层积木**（Phase B）。
 *
 * 只做展示，不含业务：空态、加载骨架、头像、面板外壳（带焦点样式）。
 * 不引入依赖、不用 CSS-in-JS 库 —— 全部是内联样式 + 一段 `<style>`。
 *
 * ## 为什么空态要单独抽
 * 清单第 4 条要求「图标 + 一句话 + 一个主按钮」，四个面板若各写一遍，
 * 迟早又退化成"一行灰字"。抽出来之后，**空态只有一种长相**，谁想改都得改这里。
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode, RefObject } from "react";
import {
  COLORS,
  FOCUS_CSS,
  RADIUS,
  SPACE,
  TABULAR,
  TYPE,
  avatarStyle,
  initialOf,
} from "./ui-tokens.js";

/**
 * 面板外壳：挂 `data-ks-panel` 并注入焦点样式。
 *
 * @param props.children 面板内容
 * @param props.style 额外样式（如 flex 布局）
 * @returns 外壳元素
 */
export function PanelShell({
  children,
  style,
  testId,
}: {
  children: ReactNode;
  style?: CSSProperties;
  /** 面板根节点的既有 `data-testid`（**必须原样保留**，测试靠它定位） */
  testId?: string;
}): ReactElement {
  return (
    <div
      {...(testId === undefined ? {} : { "data-testid": testId })}
      data-ks-panel=""
      className="ks-panel-shell"
      style={{ position: "relative", minHeight: 0, ...style }}
    >
      <style>{FOCUS_CSS}</style>
      {children}
    </div>
  );
}

/** 面板标题区：只保留标题与右侧操作，不放英文眉题和说明性副标题。 */
export function PanelHeading({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <header
      className="ks-panel-heading"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: SPACE.lg,
        padding: `${SPACE.lg}px ${SPACE.xl}px`,
        borderBottom: `1px solid ${COLORS.border}`,
        flexShrink: 0,
        background: COLORS.surface,
        boxShadow: "0 1px 0 rgba(23, 32, 51, 0.02)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h2 style={{ ...TYPE.panelTitle, margin: 0 }}>{title}</h2>
      </div>
      {action ?? null}
    </header>
  );
}

/**
 * 首字母圆形头像（同名字恒同色）。
 *
 * @param props.name 用来取首字与配色
 * @param props.size 直径（默认 36）
 */
export function Avatar({ name, size = 36 }: { name: string; size?: number }): ReactElement {
  const base = avatarStyle(name);
  return (
    <span
      aria-hidden="true"
      style={{ ...base, width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initialOf(name)}
    </span>
  );
}

/**
 * 空态：图标 + 一句话 + 主按钮（清单第 4 条，**禁止一行灰字**）。
 *
 * `text` 会原样渲染 —— 既有测试断言 `暂无人物数据` / `还没有资料。` 这些原文，
 * 所以这个组件**不加工文案**，只负责排版。
 *
 * @param props.icon 顶部图形（emoji 或传入的图标元素）
 * @param props.text 一句话说明（保留既有原文）
 * @param props.hint 补充说明（可选，弱化色）
 * @param props.action 主按钮
 */
export function EmptyState({
  icon,
  text,
  hint,
  action,
  testId,
}: {
  icon: string;
  text: string;
  hint?: string;
  action?: ReactNode;
  testId?: string;
}): ReactElement {
  return (
    <div
      {...(testId === undefined ? {} : { "data-testid": testId })}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: SPACE.md,
        padding: `${SPACE.xl}px ${SPACE.lg}px`,
        border: `1px dashed ${COLORS.borderStrong}`,
        borderRadius: RADIUS.card,
        background: COLORS.surfaceAlt,
        textAlign: "center",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 28, lineHeight: 1, opacity: 0.75 }}>
        {icon}
      </span>
      <span style={{ ...TYPE.body, color: COLORS.muted }}>{text}</span>
      {hint === undefined ? null : (
        <span style={{ ...TYPE.meta, color: COLORS.subtle }}>{hint}</span>
      )}
      {action ?? null}
    </div>
  );
}

/**
 * 加载骨架（清单第 5 条：**不许空白**）。
 *
 * 用 3 行灰块模拟卡片骨架，同时保留 `加载中…` 文案给读屏与既有断言
 * （放在视觉隐藏但可读的位置，不破坏版式）。
 */
export function SkeletonList({ rows = 3, testId }: { rows?: number; testId?: string }): ReactElement {
  return (
    <div
      {...(testId === undefined ? {} : { "data-testid": testId })}
      aria-busy="true"
      style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}
    >
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        加载中…
      </span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            alignItems: "center",
            gap: SPACE.md,
            padding: SPACE.md,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.card,
            background: COLORS.surface,
          }}
        >
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: RADIUS.pill,
              background: COLORS.hover,
              flexShrink: 0,
            }}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, flex: 1 }}>
            <span style={{ height: 10, width: "55%", borderRadius: RADIUS.control, background: COLORS.hover }} />
            <span style={{ height: 8, width: "35%", borderRadius: RADIUS.control, background: COLORS.hover }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 卡片里的两行文本（名字 + 次级信息）。
 *
 * @param props.title 主文本（超长截断 + title 提示）
 * @param props.meta 次级信息（等宽数字）
 */
export function CardText({
  title,
  meta,
}: {
  title: string;
  meta: ReactNode;
}): ReactElement {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: SPACE.xs, minWidth: 0, flex: 1 }}>
      <span
        title={title}
        style={{
          ...TYPE.body,
          fontWeight: 600,
          color: COLORS.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {title}
      </span>
      <span style={{ ...TYPE.meta, color: COLORS.subtle, ...TABULAR }}>{meta}</span>
    </span>
  );
}

/**
 * 监听容器宽度，供窄屏折叠（响应式）使用。
 *
 * ## 为什么选 ResizeObserver 而不是 container query
 * `@container` 是纯 CSS、但**依赖布局引擎**，jsdom 不计算容器尺寸，也不支持 container query；
 * 本仓库的面板全在 jsdom 里跑单测。ResizeObserver 可以用 `typeof` 守卫在 jsdom 里直接跳过，
 * 初始宽度取 `Infinity`（= 宽屏），单测仍走宽屏路径、不改变既有断言；真实浏览器里才真正
 * 切换到窄屏。可控、可测、零 CSS 魔法。
 *
 * @param ref 要监听的容器元素（通常就是面板根节点）
 * @returns 容器宽度（px）；环境不支持时为 `Infinity`（视为宽屏）
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState<number>(Infinity);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const node = ref.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect !== undefined && typeof rect.width === "number") setWidth(rect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * 三态状态 pill：`ok`（绿，已采纳）/ `pending`（黄，待整理）/ `fail`（红，失败）。
 *
 * 颜色全部取 `ui-tokens`，不写字面值；高度由 `lineHeight` 撑出，不写垂直 padding
 * （垂直 2px 这类"随手值"正是 `SPACE` 档位要消灭的东西）。
 */
export function Pill({
  kind,
  children,
}: {
  kind: "ok" | "pending" | "fail";
  children: ReactNode;
}): ReactElement {
  const tone =
    kind === "ok"
      ? { background: COLORS.okBg, color: COLORS.okText }
      : kind === "fail"
        ? { background: COLORS.dangerSoft, color: COLORS.danger }
        : { background: COLORS.warnBg, color: COLORS.warnText };
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.6,
        padding: `0 ${SPACE.sm}px`,
        borderRadius: RADIUS.pill,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...tone,
      }}
    >
      {children}
    </span>
  );
}
