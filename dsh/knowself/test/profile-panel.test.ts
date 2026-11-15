// @vitest-environment jsdom
/**
 * M3 面板渲染测试：`ProfilePanelView` / `JournalPanelView` 的**三种态**必须可区分
 * （05 §14 约束 4），用 jsdom + @testing-library/react（与既有 panel 测试同一套设施，
 * 文件仍用 `.ts` + `createElement`，与 `person-panel-degraded.test.ts` 保持一致）。
 *
 *   ① 正常态：L1 核心（显示名 / 语言 / 分区标签 / 正文 / 更新时间）+ L2 卡片可切换；
 *      日志面板：日期列表 + 选中日期的记录；
 *   ② 降级 503：显示「数据层未就绪：<reason>」+ 重试按钮重新触发取数；
 *   ③ 会话失效 401：显示「会话已失效，请重新打开 dsh web」，且**不给重试按钮**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CardSummary, CardWithSections, JournalEntryStored } from "@knowself/contracts";
import { ProfilePanelView } from "../src/client/profile-panel.js";
import { JournalPanelView } from "../src/client/journal-panel.js";
import {
  DegradedError,
  SessionExpiredError,
  type KnowselfProfilePort,
} from "../src/client/profile-port.js";

const CORE = {
  display_name: "测试用户",
  locale: "zh-CN",
  section_tags: ["基本情况", "长期目标"],
  body: "软件工程本科在读，长期目标是做后端架构。",
  updated_at: "2026-05-30T08:00:00.000Z",
  schema_version: 1 as const,
};

const CARD: CardSummary = {
  key: "skills",
  title: "技能",
  summary: "后端开发",
  section_tags: ["职业"],
  updated_at: "2026-05-30T08:00:00.000Z",
};

const CARD_DETAIL: CardWithSections = {
  card: { ...CARD, schema_version: 1 },
  sections: [
    {
      id: 1,
      card_key: "skills",
      title: "Java 后端",
      body: "Spring Boot / MyBatis-Plus / Redis",
      ord: 0,
      updated_at: "2026-05-30T08:00:00.000Z",
    },
  ],
};

const JOURNAL_DATES = [
  { date: "2026-05-30", record_count: 1, updated_at: "2026-05-30T08:00:00.000Z" },
  { date: "2026-05-01", record_count: 0, updated_at: "2026-05-01T08:00:00.000Z" },
];

const JOURNAL_ENTRY: JournalEntryStored = {
  date: "2026-05-30",
  records: [
    {
      id: 1,
      date: "2026-05-30",
      ordinal: 1,
      recorded_at: "2026-05-30T08:00:00.000Z",
      provenance: "ui",
      tags: ["晨间"],
      body: "今天完成了 REST 路由拆分。",
    },
  ],
};

/** 构造端口桩：默认全部成功，单测按需覆盖个别方法制造错误态。 */
function makePort(overrides: Partial<KnowselfProfilePort> = {}): KnowselfProfilePort {
  return {
    getProfileCore: async () => CORE,
    listCards: async () => [CARD],
    getCard: async () => CARD_DETAIL,
    listJournalDates: async () => JOURNAL_DATES,
    getJournal: async () => JOURNAL_ENTRY,
    acceptProposal: () => Promise.reject(new Error("not used")),
    rejectProposal: () => Promise.reject(new Error("not used")),
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("M3 画像面板：正常态", () => {
  it("渲染 L1 核心（显示名 / 语言 / 分区标签 / 正文 / 更新时间）与 L2 卡片目录", async () => {
    render(createElement(ProfilePanelView, { port: makePort() }));

    await waitFor(() => expect(screen.getByTestId("profile-core-body")).toBeDefined());
    expect(screen.getByTestId("profile-core-body").textContent).toContain("后端架构");
    expect(screen.getByText("zh-CN")).toBeDefined();
    expect(screen.getByText("基本情况")).toBeDefined();
    expect(screen.getByText("2026-05-30T08:00:00.000Z")).toBeDefined();
    // 左列分组标题
    expect(screen.getByText(/L1 · 核心画像/)).toBeDefined();
    expect(screen.getByText(/L2 · 卡片（1）/)).toBeDefined();
  });

  it("点击 L2 卡片 → 右侧显示卡片摘要与 sections 正文", async () => {
    render(createElement(ProfilePanelView, { port: makePort() }));

    const cardButton = await screen.findByRole("button", { name: /技能/ });
    fireEvent.click(cardButton);

    await waitFor(() => expect(screen.getByText("Java 后端")).toBeDefined());
    expect(screen.getByText(/Spring Boot \/ MyBatis-Plus \/ Redis/)).toBeDefined();
    expect(screen.getByText("后端开发")).toBeDefined();
  });
});

describe("M3 画像面板：降级（503）", () => {
  it("显示「数据层未就绪：<reason>」+ 重试按钮，点击重试重新取数", async () => {
    const getProfileCore = vi.fn(async () => {
      throw new DegradedError("核心层未就绪", "core");
    });
    render(createElement(ProfilePanelView, { port: makePort({ getProfileCore }) }));

    await waitFor(() => expect(screen.getByTestId("profile-panel-degraded")).toBeDefined());
    const banner = screen.getByTestId("profile-panel-degraded");
    expect(banner.textContent).toContain("数据层未就绪：核心层未就绪");
    expect(banner.textContent).not.toContain("数据读取失败");
    expect(getProfileCore).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(getProfileCore).toHaveBeenCalledTimes(2));
    // 桩始终 503 → 降级态与重试按钮仍在
    expect(screen.getByTestId("profile-panel-degraded")).toBeDefined();
  });
});

describe("M3 画像面板：会话失效（401）", () => {
  it("显示「会话已失效，请重新打开 dsh web」，且没有重试按钮", async () => {
    const getProfileCore = vi.fn(async () => {
      throw new SessionExpiredError();
    });
    render(createElement(ProfilePanelView, { port: makePort({ getProfileCore }) }));

    await waitFor(() =>
      expect(screen.getByTestId("profile-panel-session-expired")).toBeDefined(),
    );
    expect(screen.getByTestId("profile-panel-session-expired").textContent).toContain(
      "会话已失效，请重新打开 dsh web",
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByTestId("profile-panel-degraded")).toBeNull();
  });

  it("其它错误（500）→ 通用「数据读取失败：...」，既不是降级也不是会话失效", async () => {
    const getProfileCore = vi.fn(async () => {
      throw new Error("GET /knowself-api/profile/core → 500");
    });
    render(createElement(ProfilePanelView, { port: makePort({ getProfileCore }) }));

    await waitFor(() => expect(screen.getByTestId("profile-panel-error")).toBeDefined());
    expect(screen.getByTestId("profile-panel-error").textContent).toContain(
      "数据读取失败：GET /knowself-api/profile/core → 500",
    );
    expect(screen.queryByTestId("profile-panel-degraded")).toBeNull();
    expect(screen.queryByTestId("profile-panel-session-expired")).toBeNull();
  });
});

describe("M3 日志面板：正常态", () => {
  it("默认选中最新日期并显示其记录（ordinal / recorded_at / provenance / 标签 / 正文）", async () => {
    const getJournal = vi.fn(async (date: string) =>
      date === "2026-05-30" ? JOURNAL_ENTRY : { date, records: [] },
    );
    render(createElement(JournalPanelView, { port: makePort({ getJournal }) }));

    await waitFor(() => expect(screen.getByText(/REST 路由拆分/)).toBeDefined());
    expect(getJournal).toHaveBeenCalledWith("2026-05-30");
    expect(screen.getByText(/#1 · 2026-05-30T08:00:00.000Z · ui/)).toBeDefined();
    expect(screen.getByText("晨间")).toBeDefined();
    expect(screen.getByText("共 1 条记录")).toBeDefined();
  });

  it("点击更早的日期 → 换成该日期的记录（空日期显示空态）", async () => {
    const getJournal = vi.fn(async (date: string) =>
      date === "2026-05-30" ? JOURNAL_ENTRY : { date, records: [] },
    );
    render(createElement(JournalPanelView, { port: makePort({ getJournal }) }));

    const older = await screen.findByRole("button", { name: /2026-05-01/ });
    fireEvent.click(older);

    await waitFor(() => expect(getJournal).toHaveBeenCalledWith("2026-05-01"));
    await waitFor(() => expect(screen.getByText("这一天没有日志记录。")).toBeDefined());
  });
});

describe("M3 日志面板：降级 / 会话失效", () => {
  it("503 → 「数据层未就绪：<reason>」+ 重试", async () => {
    const listJournalDates = vi.fn(async () => {
      throw new DegradedError("日志层未就绪", "core");
    });
    render(createElement(JournalPanelView, { port: makePort({ listJournalDates }) }));

    await waitFor(() => expect(screen.getByTestId("journal-panel-degraded")).toBeDefined());
    expect(screen.getByTestId("journal-panel-degraded").textContent).toContain(
      "数据层未就绪：日志层未就绪",
    );

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(listJournalDates).toHaveBeenCalledTimes(2));
  });

  it("401 → 「会话已失效，请重新打开 dsh web」且无重试按钮", async () => {
    const listJournalDates = vi.fn(async () => {
      throw new SessionExpiredError();
    });
    render(createElement(JournalPanelView, { port: makePort({ listJournalDates }) }));

    await waitFor(() =>
      expect(screen.getByTestId("journal-panel-session-expired")).toBeDefined(),
    );
    expect(screen.getByTestId("journal-panel-session-expired").textContent).toContain(
      "会话已失效，请重新打开 dsh web",
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
