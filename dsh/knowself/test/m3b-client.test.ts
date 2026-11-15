// @vitest-environment jsdom
/**
 * M3 波 2 客户端测试：端口错误语义三分 + 两个新面板（待整理 / 资料）的三种态。
 *
 * 沿用既有做法（`test/profile-panel.test.ts` / `test/profile-port.test.ts`）：
 *   - 文件是 `.ts`（不是 `.tsx`），组件用 `createElement` 构造；
 *   - 端口用 `vi.stubGlobal('fetch')` 桩，不触网；
 *   - 面板用 jsdom + @testing-library/react 真实渲染，三种态（降级 503 / 会话失效 401 /
 *     通用错误）必须可区分（05 §14 约束 4）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IngestionProposal, SourceStored } from "@knowself/contracts";
import {
  createRestProfilePort,
  DegradedError,
  SessionExpiredError,
  type KnowselfProfilePort,
} from "../src/client/profile-port.js";
import { InboxPanelView } from "../src/client/inbox-panel.js";
import { SourcesPanelView } from "../src/client/sources-panel.js";

/** 待整理提案夹具（`target` 走 card_section 分支，覆盖「目标」文案拼接）。 */
const PROPOSAL: IngestionProposal = {
  id: "11111111-1111-4111-8111-111111111111",
  source_id: "22222222-2222-4222-8222-222222222222",
  target: { kind: "card_section", card_key: "skills", section: "职业" },
  proposed_body: "新增：Go 后端经验（两年）",
  reasoning: "资料中提到 Go 项目",
  source_excerpts: [{ start: 0, end: 120 }],
  produced_by_provider: "deepseek-chat",
  status: "pending",
  user_edited_body: null,
  created_at: "2026-05-30T08:00:00.000Z",
  decided_at: null,
};

/** 资料夹具（字段与领域库 `SourceStored` 一致）。 */
const SOURCE: SourceStored = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "file",
  original_name: "简历.pdf",
  mime_type: "application/pdf",
  file_path: "sources/22222222.pdf",
  url: null,
  extracted_text: "一段很长的简历文本",
  truncated: false,
  char_count: 1200,
  user_note: "",
  user_tags: ["简历"],
  status: "pending_review",
  metadata: {},
  created_at: "2026-05-30T08:00:00.000Z",
  last_ingested_at: "2026-05-30T09:00:00.000Z",
  last_error: null,
};

/** 桩 fetch：返回可控的 { ok, status, json() }，记录调用参数（不依赖 jsdom 的 Response）。 */
function stubFetch(body: unknown = null, status = 200) {
  const fn = vi.fn(async (_input: string, _init?: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/**
 * 构造七方法齐全的端口桩（未覆盖的方法给安全默认值）。
 * @param overrides 需要定制的端口方法
 */
function makePort(overrides: Partial<KnowselfProfilePort> = {}): KnowselfProfilePort {
  return {
    getProfileCore: () => Promise.reject(new Error("not used")),
    listCards: () => Promise.resolve([]),
    getCard: () => Promise.reject(new Error("not used")),
    listJournalDates: () => Promise.resolve([]),
    getJournal: () => Promise.resolve({ date: "2026-05-30", records: [] }),
    listProposals: () => Promise.resolve([]),
    listSources: () => Promise.resolve([]),
    acceptProposal: () => Promise.resolve(PROPOSAL),
    rejectProposal: () => Promise.resolve(PROPOSAL),
    ...overrides,
  };
}

beforeEach(() => {
  // React 18 act() 需要该标志，避免 "not configured to support act" 噪声。
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── A. 端口：URL 拼接 + 错误语义三分 ───────────────────────────────────────

describe("M3B 端口：新增只读方法的 URL 拼接", () => {
  it("listProposals 省略 status → 无 query；带 status → ?status=…", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestProfilePort();

    await port.listProposals();
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/proposals");

    await port.listProposals("pending");
    expect(fetchStub.mock.calls[1]![0]).toBe("/knowself-api/proposals?status=pending");
  });

  it("listSources 无参 → 无 query；带 limit/offset/status → 三个参数都拼上", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestProfilePort();

    await port.listSources();
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/sources");

    await port.listSources({ limit: 2, offset: 1, status: "completed" });
    expect(fetchStub.mock.calls[1]![0]).toBe(
      "/knowself-api/sources?status=completed&limit=2&offset=1",
    );

    // 只带 status 时不应出现空的 limit/offset 参数
    await port.listSources({ status: "raw" });
    expect(fetchStub.mock.calls[2]![0]).toBe("/knowself-api/sources?status=raw");
  });

  it("200 → 原样透传数组", async () => {
    stubFetch([PROPOSAL]);
    const port = createRestProfilePort();
    await expect(port.listProposals("pending")).resolves.toEqual([PROPOSAL]);

    stubFetch([SOURCE]);
    await expect(createRestProfilePort().listSources()).resolves.toEqual([SOURCE]);
  });
});

describe("M3B 端口：错误语义三分（401 / 503 / 其它）", () => {
  it("401 → SessionExpiredError（两个新方法都适用）", async () => {
    stubFetch("dsh web authentication required", 401);
    const port = createRestProfilePort();

    await expect(port.listProposals()).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(port.listSources()).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(port.listProposals()).rejects.toThrow("会话已失效，请重新打开 dsh web");
  });

  it("503 + 降级体 → DegradedError（携带 reason / layer）", async () => {
    stubFetch({ status: "degraded", reason: "核心层未就绪", layer: "core" }, 503);
    const port = createRestProfilePort();

    const err = await port.listSources().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect((err as DegradedError).reason).toBe("核心层未就绪");
    expect((err as DegradedError).layer).toBe("core");
    expect((err as DegradedError).message).toBe("数据层未就绪：核心层未就绪");
  });

  it("503 但响应体不是降级体 → 通用 Error（不误报降级）", async () => {
    stubFetch({ nope: true }, 503);
    const port = createRestProfilePort();

    const err = await port.listProposals().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DegradedError);
    expect((err as Error).message).toBe("GET /knowself-api/proposals → 503");
  });

  it("400 / 500 → 通用 Error（含 URL 与状态码）", async () => {
    stubFetch({ error: "bad_request" }, 400);
    await expect(createRestProfilePort().listProposals("pending")).rejects.toThrow(
      "GET /knowself-api/proposals?status=pending → 400",
    );

    stubFetch({ error: "boom" }, 500);
    await expect(createRestProfilePort().listSources()).rejects.toThrow(
      "GET /knowself-api/sources → 500",
    );
  });
});

// ── B. 待整理面板三种态（+ 无写按钮 + 固定提示语） ────────────────────────

describe("M3B 待整理面板", () => {
  it("正常态：渲染类别 / 目标 / 来源 / 摘要 / 时间 + 系统建议 + 采纳/拒绝按钮", async () => {
    const listProposals = vi.fn(() => Promise.resolve([PROPOSAL]));
    const { container } = render(
      createElement(InboxPanelView, { port: makePort({ listProposals }) }),
    );

    await waitFor(() => expect(container.textContent).toContain("新增：Go 后端经验（两年）"));
    expect(listProposals).toHaveBeenCalledWith("pending");
    expect(container.textContent).toContain("待整理");
    expect(container.textContent).toContain("卡片分节");
    expect(container.textContent).toContain("画像卡片 skills · 职业");
    expect(container.textContent).toContain(PROPOSAL.source_id);
    expect(container.textContent).toContain(PROPOSAL.created_at);
    expect(container.textContent).toContain("理由");
    // 本轮 UI 重设计：待整理不再只读，每条都有「采纳 / 拒绝」按钮
    expect(screen.getByRole("button", { name: "采纳" })).toBeDefined();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDefined();
    // 底部「在对话里让助手处理」提示语随只读形态一并移除
    expect(screen.queryByTestId("inbox-panel-hint")).toBeNull();
  });

  it("空态：暂无待整理提案时给出明确空态，不是错误", async () => {
    const { container } = render(createElement(InboxPanelView, { port: makePort() }));
    await waitFor(() => expect(container.textContent).toContain("没有待整理的提案。"));
    expect(container.textContent).not.toContain("数据读取失败");
  });

  it("降级态（503）：显示原因 + 重试按钮，点击后重新取数并恢复", async () => {
    let attempt = 0;
    const listProposals = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new DegradedError("核心层装配失败", "core"));
      return Promise.resolve([PROPOSAL]);
    });
    const { container } = render(
      createElement(InboxPanelView, { port: makePort({ listProposals }) }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("inbox-panel-degraded").textContent).toContain(
        "数据层未就绪：核心层装配失败",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(container.textContent).toContain("新增：Go 后端经验（两年）"),
    );
    expect(listProposals).toHaveBeenCalledTimes(2);
  });

  it("会话失效（401）：提示重开 dsh web，且**不给**重试按钮", async () => {
    const listProposals = vi.fn(() => Promise.reject(new SessionExpiredError()));
    render(createElement(InboxPanelView, { port: makePort({ listProposals }) }));

    await waitFor(() =>
      expect(screen.getByTestId("inbox-panel-session-expired").textContent).toContain(
        "会话已失效，请重新打开 dsh web",
      ),
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("通用错误：显示「数据读取失败：<message>」", async () => {
    const listProposals = vi.fn(() => Promise.reject(new Error("boom-inbox")));
    render(createElement(InboxPanelView, { port: makePort({ listProposals }) }));

    await waitFor(() =>
      expect(screen.getByTestId("inbox-panel-error").textContent).toContain(
        "数据读取失败：boom-inbox",
      ),
    );
  });
});

// ── C. 资料面板三种态（+ 条目数聚合） ─────────────────────────────────────

describe("M3B 资料面板", () => {
  it("正常态：名称 / 类型 / 状态 / 条目数 / 更新时间按真实字段展示", async () => {
    const listSources = vi.fn(() => Promise.resolve([SOURCE]));
    // 同一 source 的两条待整理提案 → 条目数 = 2
    const listProposals = vi.fn(() =>
      Promise.resolve([
        { ...PROPOSAL, id: "a" },
        { ...PROPOSAL, id: "b" },
      ] as IngestionProposal[]),
    );
    const { container } = render(
      createElement(SourcesPanelView, { port: makePort({ listSources, listProposals }) }),
    );

    await waitFor(() => expect(container.textContent).toContain("简历.pdf"));
    expect(listSources).toHaveBeenCalledWith({ limit: 200 });
    expect(container.textContent).toContain("文件 · application/pdf");
    expect(container.textContent).toContain("待审核");
    expect(container.textContent).toContain("待整理提案");
    expect(container.textContent).toContain("2 条待整理");
    expect(container.textContent).toContain(SOURCE.last_ingested_at ?? "");
    expect(container.textContent).toContain("1200");
    expect(container.textContent).toContain("简历");
  });

  it("待整理提案列聚合失败时显示「—」（不用 0 冒充没有条目），主列表仍正常", async () => {
    const listSources = vi.fn(() => Promise.resolve([SOURCE]));
    const listProposals = vi.fn(() => Promise.reject(new Error("boom-pending")));
    const { container } = render(
      createElement(SourcesPanelView, { port: makePort({ listSources, listProposals }) }),
    );

    await waitFor(() => expect(container.textContent).toContain("简历.pdf"));
    // 表头「待整理提案」+ 数值「N 条待整理」语义一致（M3 波 3 文案修正：原表头为「条目数」）
    expect(container.textContent).toContain("待整理提案");
    expect(container.textContent).not.toContain("条目数");
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("数据读取失败");
  });

  it("空态：暂无资料", async () => {
    const { container } = render(createElement(SourcesPanelView, { port: makePort() }));
    await waitFor(() => expect(container.textContent).toContain("还没有资料。"));
    expect(container.textContent).not.toContain("数据读取失败");
  });

  it("降级态（503）：显示原因 + 重试按钮可重新取数", async () => {
    let attempt = 0;
    const listSources = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new DegradedError("磁盘不可读", "core"));
      return Promise.resolve([SOURCE]);
    });
    const { container } = render(
      createElement(SourcesPanelView, { port: makePort({ listSources }) }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("sources-panel-degraded").textContent).toContain(
        "数据层未就绪：磁盘不可读",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(container.textContent).toContain("简历.pdf"));
    expect(listSources).toHaveBeenCalledTimes(2);
  });

  it("会话失效（401）：提示重开 dsh web，无重试按钮", async () => {
    const listSources = vi.fn(() => Promise.reject(new SessionExpiredError()));
    render(createElement(SourcesPanelView, { port: makePort({ listSources }) }));

    await waitFor(() =>
      expect(screen.getByTestId("sources-panel-session-expired").textContent).toContain(
        "会话已失效，请重新打开 dsh web",
      ),
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("通用错误：显示「数据读取失败：<message>」", async () => {
    const listSources = vi.fn(() => Promise.reject(new Error("boom-sources")));
    render(createElement(SourcesPanelView, { port: makePort({ listSources }) }));

    await waitFor(() =>
      expect(screen.getByTestId("sources-panel-error").textContent).toContain(
        "数据读取失败：boom-sources",
      ),
    );
  });
});
