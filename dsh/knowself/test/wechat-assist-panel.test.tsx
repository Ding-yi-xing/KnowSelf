// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WechatAssistSection } from "../src/client/wechat-assist-section.js";
import type { WechatAssistDraft, WechatAssistPort, WechatReplyTask } from "../src/client/wechat-assist-port.js";

function draft(overrides: Partial<WechatAssistDraft> = {}): WechatAssistDraft {
  return {
    id: "draft-1",
    contact_id: "contact-1",
    body: "你好，这是草稿。",
    status: "draft",
    created_at: "2026-11-14T08:00:00.000Z",
    sent_at: null,
    external_id: null,
    ...overrides,
  };
}

function makePort(overrides: Partial<WechatAssistPort> = {}): WechatAssistPort {
  return {
    listDrafts: vi.fn(async () => []),
    createDraft: vi.fn(async (input) => draft({ contact_id: input.contact_id, body: input.body })),
    discardDraft: vi.fn(async (id) => draft({ id, status: "discarded" })),
    sendDraft: vi.fn(async (id) => draft({ id, status: "sent", sent_at: "2026-11-14T08:01:00.000Z", external_id: "external-1" })),
    listReplyContacts: vi.fn(async () => [{ conversation_id: "wechat:alice", contact_id: "alice", title: "Alice", last_msg_ts_ms: 1, index_state: "ready" }]),
    listReplyProviders: vi.fn(async () => [{ id: "provider-1", label: "Provider", model: "model-1" }]),
    listReplyTasks: vi.fn(async () => []),
    startReplyTask: vi.fn(async () => ({ ...replyTask(), status: "paused" })),
    stopReplyTask: vi.fn(async (id) => ({ ...replyTask({ id }), status: "stopped" })),
    ...overrides,
  };
}

function replyTask(overrides: Partial<WechatReplyTask> = {}): WechatReplyTask {
  return {
    id: "task-1",
    conversation_id: "wechat:alice",
    contact_id: "alice",
    objective: "哄好她",
    provider_id: "provider-1",
    model_id: "model-1",
    history_authorized: false,
    status: "paused",
    stop_reason: "自动回复 worker 尚未装配",
    turn_count: 0,
    send_count: 0,
    updated_at: "2026-11-15T00:00:00.000Z",
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

describe("微信协助区", () => {
  it("初始加载并显示草稿列表", async () => {
    const port = makePort({ listDrafts: vi.fn(async () => [draft()]) });
    render(<WechatAssistSection port={port} />);

    expect(await screen.findByTestId("wechat-draft-draft-1")).toBeDefined();
    expect(screen.getByText("contact-1")).toBeDefined();
    expect(screen.getByText("草稿")).toBeDefined();
    expect(port.listDrafts).toHaveBeenCalledTimes(1);
  });

  it("填写目标和正文后生成草稿，并清空正文输入", async () => {
    const createDraft = vi.fn(async (input: { contact_id: string; body: string }) => draft(input));
    const port = makePort({ createDraft });
    render(<WechatAssistSection port={port} />);

    await screen.findByTestId("wechat-assist-empty");
    fireEvent.change(screen.getByPlaceholderText("contact_id"), { target: { value: "contact-2" } });
    fireEvent.change(screen.getByLabelText("消息正文"), { target: { value: "一条新消息" } });
    fireEvent.click(screen.getByTestId("wechat-create-draft"));

    await waitFor(() => expect(createDraft).toHaveBeenCalledWith({ contact_id: "contact-2", body: "一条新消息" }));
    expect((screen.getByLabelText("消息正文") as HTMLTextAreaElement).value).toBe("");
    expect(await screen.findByText("一条新消息")).toBeDefined();
  });

  it("发送前要求显式确认，取消时不调用发送端口", async () => {
    const sendDraft = vi.fn(async (id: string) => draft({ id, status: "sent" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const port = makePort({ listDrafts: vi.fn(async () => [draft()]), sendDraft });
    render(<WechatAssistSection port={port} />);

    fireEvent.click(await screen.findByTestId("wechat-send-draft-1"));

    expect(confirm).toHaveBeenCalledWith("确认发送给「contact-1」吗？");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("确认发送、丢弃草稿，并把失败原因显示在协助区", async () => {
    const sendDraft = vi.fn(async () => {
      throw new Error("真实微信 transport 尚未配置");
    });
    const discardDraft = vi.fn(async (id: string) => draft({ id, status: "discarded" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const port = makePort({ listDrafts: vi.fn(async () => [draft()]), sendDraft, discardDraft });
    render(<WechatAssistSection port={port} />);

    fireEvent.click(await screen.findByTestId("wechat-send-draft-1"));
    await waitFor(() => expect(sendDraft).toHaveBeenCalledWith("draft-1"));
    expect((await screen.findByTestId("wechat-assist-error")).textContent).toContain("真实微信 transport 尚未配置");

    fireEvent.click(screen.getByTestId("wechat-discard-draft-1"));
    await waitFor(() => expect(discardDraft).toHaveBeenCalledWith("draft-1"));
    expect(await screen.findByText("已丢弃")).toBeDefined();
  });

  it("shows paused auto-reply tasks and stops them through the port", async () => {
    const stopReplyTask = vi.fn(async (id: string) => replyTask({ id, status: "stopped", stop_reason: "user_stopped" }));
    const port = makePort({ listReplyTasks: vi.fn(async () => [replyTask()]), stopReplyTask });
    render(<WechatAssistSection port={port} />);

    expect(await screen.findByText(/已暂停：自动回复 worker 尚未装配/)).toBeDefined();
    fireEvent.click(screen.getByTestId("wechat-stop-auto-reply-task-1"));

    await waitFor(() => expect(stopReplyTask).toHaveBeenCalledWith("task-1"));
    expect(await screen.findByText(/已停止：user_stopped/)).toBeDefined();
  });
});
