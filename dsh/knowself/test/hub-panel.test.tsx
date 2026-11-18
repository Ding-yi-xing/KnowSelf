// @vitest-environment jsdom
/**
 * KnowSelf 统一入口（hub）单测。
 *
 * 覆盖：
 *   1. 标题 / 五个 tab 渲染，默认停在「人物」；
 *   2. 点击 tab 原地切换内容（不触发 selectPanel / 不重挂主面板）；
 *   3. `initialTab` 与模块级当前 tab 的优先级；
 *   4. 其它面板通过 `openHubTab` 跳进来时，已挂载的 hub 原地响应。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  KnowselfHubPanel,
  type HubTabDefinition,
} from "../src/client/hub-panel.js";
import {
  currentHubTab,
  openHubTab,
  resetHubTabForTest,
  type HubTabId,
} from "../src/client/hub-tab.js";

const TABS: readonly HubTabDefinition[] = [
  { id: "person", label: "人物", testId: "knowself-hub-tab-person" },
  { id: "profile", label: "画像", testId: "knowself-hub-tab-profile" },
  { id: "inbox", label: "待整理", testId: "knowself-hub-tab-inbox" },
  { id: "journal", label: "日志", testId: "knowself-hub-tab-journal" },
  { id: "sources", label: "资料", testId: "knowself-hub-tab-sources" },
];

/** 每个 tab 渲染一句可断言的内容，不带任何数据依赖。 */
function renderTab(tab: HubTabId) {
  return <div data-testid={`content-${tab}`}>内容-{tab}</div>;
}

beforeEach(() => {
  // React 18 act() 需要该标志，避免 "not configured to support act" 噪声。
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetHubTabForTest();
});

afterEach(() => {
  cleanup();
});

describe("KnowSelf 统一入口布局", () => {
  it("渲染标题与五个 tab，默认停在人物", () => {
    render(<KnowselfHubPanel tabs={TABS} renderTab={renderTab} />);

    expect(screen.getByRole("heading", { name: "KnowSelf" })).toBeTruthy();
    const tablist = screen.getByRole("tablist", { name: "KnowSelf 功能切换" });
    expect(tablist).toBeTruthy();

    for (const tab of TABS) {
      expect(screen.getByTestId(tab.testId).textContent).toBe(tab.label);
    }
    expect(screen.getByTestId("knowself-hub-tab-person").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("content-person")).toBeTruthy();
    expect(screen.queryByTestId("content-sources")).toBeNull();
  });

  it("点击 tab 原地切换内容并把状态写回模块级", () => {
    render(<KnowselfHubPanel tabs={TABS} renderTab={renderTab} />);

    fireEvent.click(screen.getByTestId("knowself-hub-tab-inbox"));

    expect(screen.getByTestId("knowself-hub-tab-inbox").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("knowself-hub-tab-person").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("content-inbox")).toBeTruthy();
    expect(screen.queryByTestId("content-person")).toBeNull();
    expect(currentHubTab()).toBe("inbox");
  });

  it("initialTab 优先于模块级当前 tab（兼容旧面板 id 的 main 别名）", () => {
    openHubTab("sources");
    render(<KnowselfHubPanel tabs={TABS} renderTab={renderTab} initialTab="journal" />);

    expect(screen.getByTestId("knowself-hub-tab-journal").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("content-journal")).toBeTruthy();
    // 只读初始值：initialTab 不反写模块级状态，避免别名挂载污染「上次停留」。
    expect(currentHubTab()).toBe("sources");
  });

  it("其它面板调用 openHubTab 时，已挂载的 hub 原地响应", () => {
    render(<KnowselfHubPanel tabs={TABS} renderTab={renderTab} />);

    act(() => {
      openHubTab("profile");
    });

    expect(screen.getByTestId("knowself-hub-tab-profile").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("content-profile")).toBeTruthy();
  });
});
