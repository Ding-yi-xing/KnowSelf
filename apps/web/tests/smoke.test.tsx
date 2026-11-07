// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { pageFromLocation, pathForPage } from "../src/routes";
import { InboxPage } from "../src/features/inbox/InboxPage";
import type { DecideResult, Proposal, SystemStatus } from "../src/transport/types";
import type { KnowSelfApi } from "../src/transport/http";

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    source_id: "s1",
    status: "pending",
    proposed_body: "建议内容",
    reasoning: "tier=review; rule_version=chat-tier-v2",
    source_excerpts: ["原文摘录"],
    produced_by_provider: "test",
    created_at: "2026-11-07T10:00:00.000Z",
    decided_at: null,
    user_edited_body: null,
    target: { kind: "chat_message" },
    ...over,
  };
}

function stubApi(over: Partial<KnowSelfApi> = {}): KnowSelfApi {
  return {
    listPending: vi.fn(async () => [] as Proposal[]),
    decide: vi.fn(async (): Promise<DecideResult> => ({ id: "p1", status: "accepted" })),
    systemStatus: vi.fn(async (): Promise<SystemStatus> => ({ ok: true })),
    ...over,
  };
}

describe("路由表（迁移前 URL 契约）", () => {
  it("9 条路径与别名 /chat 保持一致", () => {
    expect(pageFromLocation("/")).toBe("chat");
    expect(pageFromLocation("/chat")).toBe("chat");
    expect(pageFromLocation("/inbox")).toBe("inbox");
    expect(pageFromLocation("/profile")).toBe("profile");
    expect(pageFromLocation("/cards")).toBe("cards");
    expect(pageFromLocation("/journal")).toBe("journal");
    expect(pageFromLocation("/settings")).toBe("settings");
    expect(pageFromLocation("/system")).toBe("system");
    expect(pageFromLocation("/sources")).toBe("sources");
    expect(pageFromLocation("/templates")).toBe("templates");
    expect(pageFromLocation("/unknown")).toBe("chat");
  });

  it("页面到路径可逆", () => {
    expect(pathForPage("chat")).toBe("/");
    expect(pathForPage("inbox")).toBe("/inbox");
  });
});

describe("InboxPage（试点页）", () => {
  it("加载态后显示空态", async () => {
    const client = stubApi();
    render(<InboxPage client={client} />);
    await waitFor(() => expect(screen.getByText("暂无待整理内容")).toBeDefined());
    expect(client.listPending).toHaveBeenCalledOnce();
  });

  it("拉取失败显示错误横幅，不静默", async () => {
    const client = stubApi({ listPending: vi.fn(async () => { throw new Error("后端不可用"); }) });
    render(<InboxPage client={client} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("后端不可用"));
  });

  it("接受提案后从列表移除并提示成功", async () => {
    const client = stubApi({ listPending: vi.fn(async () => [proposal()]) });
    render(<InboxPage client={client} />);
    await waitFor(() => expect(screen.getByText("建议内容")).toBeDefined());

    fireEvent.click(screen.getByText("接受"));

    await waitFor(() => expect(client.decide).toHaveBeenCalledWith("p1", { decision: "accept" }));
    await waitFor(() => expect(screen.queryByText("建议内容")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("已处理");
  });

  it("编辑后提交 edit 决策并带上正文", async () => {
    const client = stubApi({ listPending: vi.fn(async () => [proposal()]) });
    render(<InboxPage client={client} />);
    await waitFor(() => expect(screen.getByText("建议内容")).toBeDefined());

    fireEvent.click(screen.getByText("编辑"));
    const textarea = screen.getByLabelText("编辑建议内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "改过的正文" } });
    fireEvent.click(screen.getByText("保存并接受"));

    await waitFor(() =>
      expect(client.decide).toHaveBeenCalledWith("p1", {
        decision: "edit",
        body: "改过的正文",
      }),
    );
  });

  it("拒绝决策透传到后端", async () => {
    const client = stubApi({ listPending: vi.fn(async () => [proposal()]) });
    render(<InboxPage client={client} />);
    await waitFor(() => expect(screen.getByText("建议内容")).toBeDefined());

    fireEvent.click(screen.getByText("拒绝"));
    await waitFor(() =>
      expect(client.decide).toHaveBeenCalledWith("p1", { decision: "reject" }),
    );
  });
});
