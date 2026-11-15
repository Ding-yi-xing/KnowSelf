// @vitest-environment jsdom
/**
 * §13.4 客户端配套：`PersonPanelView` 遇 503 人物层降级时的真实渲染补测。
 *
 * 用 jsdom + @testing-library/react（与 `client-panel-boundary.test.ts` 同一套设施）：
 *   - 显示「数据层未就绪：<reason>」而非通用「数据读取失败」；
 *   - 面板顶部保留重试按钮，点击后重新触发 `port.listPersons`；
 *   - 通用错误仍保持既有「数据读取失败：...」且不出现重试按钮（零回退）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PersonPanelView } from "../src/client/person-panel.js";
import { PersonLayerDegradedError } from "../src/client/rest-data-port.js";
import type { PersonPanelDataPort } from "../src/client/data-port.js";

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("§13.4 面板：503 人物层降级", () => {
  it("显示「数据层未就绪：<reason>」+ 重试按钮；点击重试重新触发 listPersons", async () => {
    const listPersons = vi.fn(async () => {
      throw new PersonLayerDegradedError("密钥未配置");
    });
    const port = {
      listPersons,
      getPerson: async () => null,
      timeline: async () => [],
    } as unknown as PersonPanelDataPort;

    render(createElement(PersonPanelView, { port, bridgeReady: true }));
    await waitFor(() =>
      expect(screen.getByTestId("person-layer-degraded")).toBeDefined(),
    );

    const banner = screen.getByTestId("person-layer-degraded");
    expect(banner.textContent).toContain("数据层未就绪：密钥未配置");
    expect(banner.textContent).not.toContain("数据读取失败");
    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry).toBeDefined();
    expect(listPersons).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => expect(listPersons).toHaveBeenCalledTimes(2));
    // 重试后仍是降级态（桩始终抛 503），提示与按钮仍在
    expect(screen.getByTestId("person-layer-degraded")).toBeDefined();
  });

  it("REST 端口抛 PersonLayerDegradedError 时面板不显示通用错误态", async () => {
    const port = {
      listPersons: async () => {
        throw new PersonLayerDegradedError("原生模块 ABI 不匹配");
      },
      getPerson: async () => null,
      timeline: async () => [],
    } as unknown as PersonPanelDataPort;

    render(createElement(PersonPanelView, { port, bridgeReady: true }));
    await waitFor(() =>
      expect(screen.getByTestId("person-layer-degraded")).toBeDefined(),
    );
    expect(screen.getByTestId("person-layer-degraded").textContent).toContain(
      "原生模块 ABI 不匹配",
    );
    expect(screen.queryByText(/数据读取失败/)).toBeNull();
  });

  it("通用错误仍显示「数据读取失败：...」且没有重试按钮（零回退）", async () => {
    const port = {
      listPersons: async () => {
        throw new Error("GET /knowself-api/persons → 500");
      },
      getPerson: async () => null,
      timeline: async () => [],
    } as unknown as PersonPanelDataPort;

    render(createElement(PersonPanelView, { port, bridgeReady: true }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain(
      "数据读取失败：GET /knowself-api/persons → 500",
    );
    expect(screen.queryByTestId("person-layer-degraded")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
