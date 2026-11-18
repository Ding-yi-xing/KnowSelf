// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WechatAssistSection } from "../src/client/wechat-assist-section.js";
import type { WechatAssistDraft, WechatAssistPort, WechatReplyTask } from "../src/client/wechat-assist-port.js";

function draft(): WechatAssistDraft {
  return { id: "legacy-draft", contact_id: "alice", body: "legacy", status: "draft", created_at: "2026-11-14T08:00:00.000Z", sent_at: null, external_id: null };
}

function task(overrides: Partial<WechatReplyTask> = {}): WechatReplyTask {
  return {
    id: "task-1", conversation_id: "wechat:alice", contact_id: "alice", objective: "哄好她",
    provider_id: "provider-1", model_id: "model-1", history_authorized: false,
    status: "paused", stop_reason: "等待下一条消息", turn_count: 0, send_count: 0,
    updated_at: "2026-11-16T00:00:00.000Z", ...overrides,
  };
}

function capability(available = false) {
  return available
    ? { available: true, can_inspect_conversation: true, can_list_unread: true, can_send: true, can_lookup_send_result: true, transport_version: "test" }
    : { available: false, can_inspect_conversation: false, can_list_unread: false, can_send: false, can_lookup_send_result: false, transport_version: "test", reason: "UIA controls are unsupported" };
}

function makePort(overrides: Partial<WechatAssistPort> = {}): WechatAssistPort {
  return {
    // Legacy endpoints remain compatible on the server, but the section no longer uses them.
    listDrafts: vi.fn(async () => [draft()]),
    createDraft: vi.fn(async () => draft()),
    discardDraft: vi.fn(async () => draft()),
    sendDraft: vi.fn(async () => draft()),
    listReplyContacts: vi.fn(async () => [{ conversation_id: "wechat:alice", contact_id: "alice", title: "宝宝", last_msg_ts_ms: 1, index_state: "ready" }]),
    listReplyTasks: vi.fn(async () => []),
    getReplyPersona: vi.fn(async () => null),
    getTransportCapabilities: vi.fn(async () => capability()),
    getReplyModels: vi.fn(async () => ({
      models: [{ provider: "deepseek-official", model: "deepseek-flash", label: "DeepSeek · deepseek-flash" }],
      current: { provider: "deepseek-official", model: "deepseek-flash" },
    })),
    startReplyTask: vi.fn(async () => task()),
    stopReplyTask: vi.fn(async (id) => task({ id, status: "stopped", stop_reason: "user_stopped" })),
    revokeReplyTaskHistory: vi.fn(async (id) => task({ id, history_authorized: false, status: "paused", stop_reason: "history_revoked" })),
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

describe("微信协助自动回复", () => {
  it("展示自动回复流程与 dsh 模型选择器，且不出现旧草稿控件", async () => {
    const port = makePort();
    render(<WechatAssistSection port={port} />);

    expect(await screen.findByLabelText("自动回复好友")).toBeDefined();
    expect(screen.getByLabelText("自动回复聊天目标")).toBeDefined();
    const selector = await screen.findByLabelText("回复模型") as HTMLSelectElement;
    expect(selector.value).toBe("deepseek-official::deepseek-flash");
    expect(selector.options).toHaveLength(1);
    expect(selector.options[0]?.textContent).toBe("DeepSeek · deepseek-flash");
    expect(screen.getByText(/只列出 dsh 已配置的模型/)).toBeDefined();
    expect(screen.queryByLabelText("消息正文")).toBeNull();
    expect(screen.queryByTestId("wechat-create-draft")).toBeNull();
    expect(screen.queryByText("生成草稿")).toBeNull();
    expect(screen.queryByText("Provider")).toBeNull();
    expect(port.listDrafts).not.toHaveBeenCalled();
    expect(port.createDraft).not.toHaveBeenCalled();
  });

  it("微信桌面能力不完整时明确阻止启动", async () => {
    const startReplyTask = vi.fn();
    render(<WechatAssistSection port={makePort({ startReplyTask })} />);

    expect((await screen.findByTestId("wechat-transport-blocked")).textContent).toContain("UIA controls are unsupported");
    expect(screen.getByTestId("wechat-start-auto-reply").hasAttribute("disabled")).toBe(true);
    expect(startReplyTask).not.toHaveBeenCalled();
  });

  it("启动任务提交好友、目标、历史授权与所选 dsh 模型", async () => {
    const startReplyTask = vi.fn(async () => task());
    const port = makePort({ getTransportCapabilities: vi.fn(async () => capability(true)), startReplyTask });
    render(<WechatAssistSection port={port} />);

    await screen.findByLabelText("自动回复好友");
    fireEvent.change(screen.getByLabelText("自动回复聊天目标"), { target: { value: "哄好她，真诚简短" } });
    fireEvent.click(screen.getByLabelText("允许将所选好友的相关历史发送给模型"));
    fireEvent.click(screen.getByTestId("wechat-start-auto-reply"));

    await waitFor(() => expect(startReplyTask).toHaveBeenCalledWith({
      conversation_id: "wechat:alice", contact_id: "alice", objective: "哄好她，真诚简短", history_authorized: true,
      provider_id: "deepseek-official", model_id: "deepseek-flash",
    }));
  });

  it("展示任务并可停止自动回复", async () => {
    const stopReplyTask = vi.fn(async (id: string) => task({ id, status: "stopped", stop_reason: "user_stopped" }));
    render(<WechatAssistSection port={makePort({ listReplyTasks: vi.fn(async () => [task()]), stopReplyTask })} />);

    expect(await screen.findByText(/已暂停：等待下一条消息/)).toBeDefined();
    fireEvent.click(screen.getByTestId("wechat-stop-auto-reply-task-1"));
    fireEvent.click(screen.getByTestId("wechat-task-confirm"));
    await waitFor(() => expect(stopReplyTask).toHaveBeenCalledWith("task-1"));
    expect(await screen.findByText(/已停止：user_stopped/)).toBeDefined();
  });
});
