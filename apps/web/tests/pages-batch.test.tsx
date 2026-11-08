// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SystemPage } from "../src/features/system/SystemPage";
import { TemplatesPage } from "../src/features/templates/TemplatesPage";
import { CardsPage } from "../src/features/cards/CardsPage";
import { JournalPage } from "../src/features/journal/JournalPage";
import type { ProfileApi } from "../src/transport/profileApi";
import type {
  CardSummary,
  CardWithSections,
  JournalDateSummary,
  JournalEntryStored,
  SystemStatus,
  TemplateRecord,
} from "../src/transport/types";

const status: SystemStatus = {
  ready: { profile_store: true, provider_adapter: false, overall: false },
  uptime_seconds: 3661,
  app_version: "0.0.0",
  collected_at: "2026-11-08T10:00:00.000Z",
  providers: [{ id: "p1" }],
};

const template = (over: Partial<TemplateRecord> = {}): TemplateRecord => ({
  id: "t1",
  name: "自定义模板",
  description: "描述",
  system_prompt_inject: "注入内容",
  variables: [],
  created_at: "2026-11-08T10:00:00.000Z",
  ...over,
});

const card = (over: Partial<CardSummary> = {}): CardSummary => ({
  key: "work",
  title: "工作",
  summary: "关于工作",
  section_tags: [],
  updated_at: "2026-11-08T10:00:00.000Z",
  ...over,
});

const journalDate = (date: string, count: number): JournalDateSummary => ({
  date,
  record_count: count,
  updated_at: "2026-11-08T10:00:00.000Z",
});

// vitest 配置 globals:false，@testing-library 不会自动 cleanup；显式清理避免跨用例 DOM 串扰。
afterEach(cleanup);

function stub(over: Partial<ProfileApi> = {}): ProfileApi {
  return {
    systemStatus: vi.fn(async () => status),
    listTemplates: vi.fn(async () => [] as TemplateRecord[]),
    createTemplate: vi.fn(async (body) => ({ ...body, created_at: "now" }) as TemplateRecord),
    deleteTemplate: vi.fn(async () => undefined),
    listCards: vi.fn(async () => [] as CardSummary[]),
    getCard: vi.fn(async (): Promise<CardWithSections> => ({ card: card(), sections: [] })),
    saveCard: vi.fn(async () => undefined),
    deleteCard: vi.fn(async () => undefined),
    listJournalDates: vi.fn(async () => [] as JournalDateSummary[]),
    getJournal: vi.fn(async (): Promise<JournalEntryStored> => ({ date: "2026-11-08", records: [] })),
    appendJournal: vi.fn(async () => undefined),
    ...over,
  };
}

describe("SystemPage", () => {
  it("展示 ready 各项与运行时长，错误时给出重试", async () => {
    const client = stub();
    render(<SystemPage client={client} />);
    await waitFor(() => expect(screen.getByText("profile_store")).toBeDefined());
    expect(screen.getByText(/已运行 1小时 1分 1秒/)).toBeDefined();
    expect(screen.getByText("就绪")).toBeDefined();
    expect(screen.getByText("未就绪")).toBeDefined();
    fireEvent.click(screen.getByText("刷新"));
    await waitFor(() => expect(client.systemStatus).toHaveBeenCalledTimes(2));
  });

  it("加载失败显示错误与重试入口", async () => {
    const client = stub({ systemStatus: vi.fn(async () => { throw new Error("后端离线"); }) });
    render(<SystemPage client={client} />);
    await waitFor(() => expect(screen.getByText("系统状态加载失败")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain("后端离线");
  });
});

describe("TemplatesPage", () => {
  it("内置与自定义分组展示，内置不可删", async () => {
    const client = stub({
      listTemplates: vi.fn(async () => [
        template({ id: "builtin-a", name: "内置" }),
        template({ id: "custom-a", name: "自定义" }),
      ]),
    });
    render(<TemplatesPage client={client} />);
    await waitFor(() => expect(screen.getByText("内置模板")).toBeDefined());
    expect(screen.getByText("自定义模板")).toBeDefined();

    const deleteButtons = screen.getAllByText("删除");
    fireEvent.click(deleteButtons[0]!);
    fireEvent.click(screen.getByText("确认删除"));
    await waitFor(() => expect(screen.getByText("内置模板不可删除")).toBeDefined());
    expect(client.deleteTemplate).not.toHaveBeenCalled();
  });

  it("自定义模板可删除，新建走 POST 并带上契约字段", async () => {
    const client = stub({ listTemplates: vi.fn(async () => [template({ name: "我的模板" })]) });
    render(<TemplatesPage client={client} />);
    await waitFor(() => expect(screen.getByText("我的模板")).toBeDefined());

    fireEvent.click(screen.getAllByText("删除")[0]!);
    fireEvent.click(screen.getByText("确认删除"));
    await waitFor(() => expect(client.deleteTemplate).toHaveBeenCalledWith("t1"));

    fireEvent.click(screen.getByText("新建模板"));
    fireEvent.change(screen.getByLabelText("模板 ID"), { target: { value: "t2" } });
    fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "新模板" } });
    fireEvent.change(screen.getByLabelText("提示词注入"), { target: { value: "请回答" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(client.createTemplate).toHaveBeenCalledWith({
      id: "t2",
      name: "新模板",
      description: "",
      system_prompt_inject: "请回答",
      variables: [],
    }));
  });
});

describe("CardsPage", () => {
  it("列表 → 选中读详情 → 删除", async () => {
    const client = stub({
      listCards: vi.fn(async () => [card()]),
      getCard: vi.fn(async (): Promise<CardWithSections> => ({
        card: card(),
        sections: [{ id: 1, title: "职责", body: "开发" }],
      })),
    });
    render(<CardsPage client={client} />);
    await waitFor(() => expect(screen.getByText("工作")).toBeDefined());
    fireEvent.click(screen.getByText("工作"));
    await waitFor(() => expect(client.getCard).toHaveBeenCalledWith("work"));
    await waitFor(() => expect(screen.getByText(/职责/)).toBeDefined());
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(client.deleteCard).toHaveBeenCalledWith("work"));
  });

  it("新建卡片提交 WriteRequest 的 card 分支形状", async () => {
    const client = stub();
    render(<CardsPage client={client} />);
    fireEvent.click(screen.getByText("新建卡片"));
    fireEvent.change(screen.getByLabelText("卡片标题"), { target: { value: "My Card" } });
    fireEvent.change(screen.getByLabelText("卡片摘要"), { target: { value: "摘要" } });
    fireEvent.change(screen.getByLabelText("小节标题 1"), { target: { value: "小节" } });
    fireEvent.change(screen.getByLabelText("小节正文 1"), { target: { value: "正文" } });
    fireEvent.click(screen.getByText("保存卡片"));
    await waitFor(() => expect(client.saveCard).toHaveBeenCalledWith("my_card", {
      title: "My Card",
      summary: "摘要",
      section_tags: [],
      sections: [{ title: "小节", body: "正文" }],
    }));
  });
});

describe("JournalPage", () => {
  it("日期倒序、选中读详情、追加带标签", async () => {
    const client = stub({
      listJournalDates: vi.fn(async () => [journalDate("2026-11-06", 1), journalDate("2026-11-08", 2)]),
      getJournal: vi.fn(async (): Promise<JournalEntryStored> => ({
        date: "2026-11-08",
        records: [{
          id: 1,
          ordinal: 1,
          body: "今天做了迁移",
          tags: ["work"],
          recorded_at: "2026-11-08T10:00:00.000Z",
        }],
      })),
    });
    render(<JournalPage client={client} />);
    await waitFor(() => expect(screen.getByText("2026-11-08")).toBeDefined());
    const items = document.querySelectorAll(".master-item");
    expect(items[0]?.textContent).toContain("2026-11-08");

    fireEvent.click(screen.getByText("2026-11-08"));
    await waitFor(() => expect(client.getJournal).toHaveBeenCalledWith("2026-11-08"));
    await waitFor(() => expect(screen.getByText(/今天做了迁移/)).toBeDefined());

    fireEvent.change(screen.getByLabelText("日志正文"), { target: { value: "追加一条" } });
    fireEvent.change(screen.getByLabelText("日志标签"), { target: { value: "a, b" } });
    fireEvent.click(screen.getByText("追加"));
    await waitFor(() => expect(client.appendJournal).toHaveBeenCalledWith("2026-11-08", "追加一条", ["a", "b"]));
  });

  it("无日期时显示空态，不假装可用", async () => {
    render(<JournalPage client={stub()} />);
    await waitFor(() => expect(screen.getByText("暂无日志")).toBeDefined());
  });
});
