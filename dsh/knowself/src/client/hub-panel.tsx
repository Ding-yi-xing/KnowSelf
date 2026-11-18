/**
 * KnowSelf 统一入口（人物 / 画像 / 待整理 / 日志 / 资料）。
 *
 * 改造前这五个功能各占一个侧栏图标；现在收进一个「KnowSelf」主面板，用顶部
 * tab 切换。图谱不在这里（仍保留独立侧栏入口），因为它是画布型视图，和
 * 「档案类」面板的操作节奏不同。
 *
 * ## 结构
 * ```
 * ┌──────────────────────────────────────────────┐
 * │ K  KnowSelf            [人物][画像][待整理]… │  ← 固定头部
 * ├──────────────────────────────────────────────┤
 * │ 当前 tab 的面板（自带 PanelHeading）          │
 * └──────────────────────────────────────────────┘
 * ```
 *
 * tab 点击只改模块级状态（见 `hub-tab.ts`），不触发 `selectPanel`，所以侧栏
 * 「KnowSelf」始终是选中态，切 tab 也不会重建主面板。
 */
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { PanelShell } from "./ui-kit.js";
import { COLORS, RADIUS, SPACE, TYPE } from "./ui-tokens.js";
import { currentHubTab, openHubTab, subscribeHubTab, type HubTabId } from "./hub-tab.js";

/** 一个 tab 的展示定义（内容由调用方通过 `renderTab` 提供）。 */
export interface HubTabDefinition {
  /** tab 标识 */
  id: HubTabId;
  /** 中文标签 */
  label: string;
  /** 稳定 testid（e2e/单测定位用） */
  testId: string;
}

/** 统一入口组件 props。 */
export interface KnowselfHubPanelProps {
  /** tab 列表（顺序即展示顺序） */
  tabs: readonly HubTabDefinition[];
  /** 按 tab 渲染对应面板内容（只渲染当前 tab） */
  renderTab: (tab: HubTabId) => ReactNode;
  /**
   * 初始 tab；缺省沿用模块级当前 tab。
   * 仅供测试 / 未来深链使用，正常导航走 `openHubTab`。
   */
  initialTab?: HubTabId;
}

/**
 * KnowSelf 统一入口面板。
 *
 * @param props tabs / renderTab / initialTab
 * @returns 带 tab 导航的面板外壳
 */
export function KnowselfHubPanel({
  tabs,
  renderTab,
  initialTab,
}: KnowselfHubPanelProps): ReactElement {
  const [active, setActive] = useState<HubTabId>(() => initialTab ?? currentHubTab());

  // 其它面板（图谱点人、人物空态去导入）通过 openHubTab 跳进来时，已挂载的
  // hub 要原地响应；未挂载的情况由 useState 初始值兜住。
  useEffect(() => subscribeHubTab(setActive), []);

  const activeTab = tabs.find((tab) => tab.id === active) ?? tabs[0];

  const select = (tab: HubTabId): void => {
    openHubTab(tab);
    // 显式 set 一次，不依赖订阅回调的触发顺序（openHubTab 也会通知本组件）。
    setActive(tab);
  };

  return (
    <PanelShell
      testId="knowself-hub"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontFamily: "system-ui, sans-serif",
        color: COLORS.text,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.lg,
          flexWrap: "wrap",
          flexShrink: 0,
          padding: `${SPACE.md}px ${SPACE.xl}px`,
          borderBottom: `1px solid ${COLORS.border}`,
          background: COLORS.surface,
          boxShadow: "0 1px 0 rgba(23, 32, 51, 0.02)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              width: 28,
              height: 28,
              borderRadius: RADIUS.control,
              background: COLORS.accent,
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              fontWeight: 700,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            K
          </span>
          <h2 style={{ ...TYPE.panelTitle, margin: 0 }}>KnowSelf</h2>
        </div>

        <nav
          role="tablist"
          aria-label="KnowSelf 功能切换"
          style={{
            display: "flex",
            gap: 2,
            padding: 2,
            marginLeft: "auto",
            maxWidth: "100%",
            overflowX: "auto",
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.pill,
            background: COLORS.surfaceAlt,
          }}
        >
          {tabs.map((tab) => {
            const selected = activeTab?.id === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={tab.testId}
                onClick={() => select(tab.id)}
                style={{
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 13,
                  fontWeight: selected ? 600 : 500,
                  whiteSpace: "nowrap",
                  padding: `${SPACE.xs}px ${SPACE.md}px`,
                  border: "none",
                  borderRadius: RADIUS.pill,
                  background: selected ? COLORS.surface : "transparent",
                  color: selected ? COLORS.text : COLORS.subtle,
                  boxShadow: selected ? "0 1px 3px rgba(23, 32, 51, 0.08)" : "none",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      <div
        role="tabpanel"
        aria-label={activeTab?.label ?? "KnowSelf"}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {renderTab(activeTab?.id ?? currentHubTab())}
      </div>
    </PanelShell>
  );
}
