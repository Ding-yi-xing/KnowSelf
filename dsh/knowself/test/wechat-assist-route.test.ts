import { describe, expect, it, vi } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { dispatch } from "../src/routes/index.js";

function makeServices() {
  const draft = {
    id: "draft-1",
    contact_id: "alice",
    body: "你好",
    status: "draft",
    created_at: "2026-11-14T00:00:00.000Z",
    sent_at: null,
    external_id: null,
  };
  const wechatAssist = {
    listDrafts: vi.fn(() => [draft]),
    createDraft: vi.fn(async () => draft),
    discardDraft: vi.fn(async () => ({ ...draft, status: "discarded" })),
    sendDraft: vi.fn(async () => ({ ...draft, status: "sent" })),
    listReplyTasks: vi.fn(() => []),
    startReplyTask: vi.fn(async (input: Record<string, unknown>) => ({ id: "task-1", ...input, status: "paused" })),
    stopReplyTask: vi.fn(async (id: string) => ({ id, status: "stopped" })),
  };
  const wechatTransport = { probeCapabilities: vi.fn(async () => ({ available: true, can_inspect_conversation: true, can_list_unread: true, can_send: true, can_lookup_send_result: true, transport_version: "test" })) };
  const personStore = { replyHistory: { listDirectConversations: vi.fn(() => [
    { conversation_id: "wechat:alice", contact_id: "alice", title: "Alice", last_msg_ts_ms: 1 },
  ]) } };
  const settings = {
    conversation: { default_provider_id: "provider-1" },
    providers: [{ id: "provider-1", model: "model-1", purposes: ["chat"] }],
  };
  return { services: { wechatAssist, wechatTransport, personStore, settings } as unknown as KnowselfServices, wechatAssist, wechatTransport };
}

describe("wechat assist REST routes", () => {
  it("lists drafts through the read channel", async () => {
    const { services, wechatAssist } = makeServices();
    const result = await dispatch(new URL("http://dsh/knowself-api/wechat-assist/drafts"), services);
    expect(result).toEqual({ status: 200, body: expect.any(Array) });
    expect(wechatAssist.listDrafts).toHaveBeenCalledTimes(1);
  });

  it("requires the write channel and explicit confirmation to send", async () => {
    const { services, wechatAssist } = makeServices();
    await expect(dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/drafts/draft-1/send"),
      services,
      "POST",
      {},
    )).rejects.toThrow("explicit=true");
    expect(wechatAssist.sendDraft).not.toHaveBeenCalled();

    const sent = await dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/drafts/draft-1/send"),
      services,
      "POST",
      { explicit: true },
    );
    expect(sent.status).toBe(200);
    expect(wechatAssist.sendDraft).toHaveBeenCalledWith("draft-1", { explicit: true });
  });

  it("discards only through the write channel", async () => {
    const { services, wechatAssist } = makeServices();
    const result = await dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/drafts/draft-1"),
      services,
      "DELETE",
    );
    expect(result.status).toBe(200);
    expect(wechatAssist.discardDraft).toHaveBeenCalledWith("draft-1");
  });

  it("exposes transport capability status and blocks task creation when unsupported", async () => {
    const { services, wechatAssist, wechatTransport } = makeServices();
    wechatTransport.probeCapabilities.mockResolvedValue({ available: true, can_inspect_conversation: false, can_list_unread: false, can_send: false, can_lookup_send_result: false, transport_version: "test", reason: "controls unsupported" });
    const status = await dispatch(new URL("http://dsh/knowself-api/wechat-assist/transport"), services);
    expect(status).toMatchObject({ status: 200, body: { can_list_unread: false, reason: "controls unsupported" } });
    const result = await dispatch(new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"), services, "POST", { conversation_id: "wechat:alice", contact_id: "alice", objective: "test" });
    expect(result).toMatchObject({ status: 503, body: { error: "transport_unavailable" } });
    expect(wechatAssist.startReplyTask).not.toHaveBeenCalled();
  });

  it("only creates reply tasks for an unlocked direct conversation", async () => {
    const { services, wechatAssist } = makeServices();
    const result = await dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"),
      services,
      "POST",
      {
        conversation_id: "wechat:alice",
        contact_id: "alice",
        objective: "哄好她",
        history_authorized: true,
        provider_id: "browser-forged-provider",
        model_id: "browser-forged-model",
      },
    );
    expect(result).toMatchObject({ status: 201, body: { id: "task-1", status: "paused" } });
    expect(wechatAssist.startReplyTask).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "wechat:alice", contact_id: "alice", provider_id: "provider-1", model_id: "model-1",
    }));

    await expect(dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"),
      services,
      "POST",
      { conversation_id: "wechat:group", contact_id: "alice", objective: "test" },
    )).rejects.toThrow("不是已解锁的好友直聊");
  });

  it("lists dsh models and only accepts configured models", async () => {
    const { services, wechatAssist } = makeServices();
    (services as unknown as { listDshModels: () => Promise<Array<{ provider: string; model: string; label: string }>> }).listDshModels =
      vi.fn(async () => [{ provider: "deepseek-official", model: "deepseek-flash", label: "DeepSeek · deepseek-flash" }]);

    const catalog = await dispatch(new URL("http://dsh/knowself-api/wechat-assist/models"), services);
    expect(catalog).toMatchObject({
      status: 200,
      body: { models: [{ provider: "deepseek-official", model: "deepseek-flash" }], current: null },
    });

    const accepted = await dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"),
      services,
      "POST",
      { conversation_id: "wechat:alice", contact_id: "alice", objective: "t", provider_id: "deepseek-official", model_id: "deepseek-flash" },
    );
    expect(accepted.status).toBe(201);
    expect(wechatAssist.startReplyTask).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: "deepseek-official", model_id: "deepseek-flash",
    }));

    await expect(dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"),
      services,
      "POST",
      { conversation_id: "wechat:alice", contact_id: "alice", objective: "t", provider_id: "forged", model_id: "forged-model" },
    )).rejects.toThrow("不在 dsh 已配置模型中");
  });

  it("uses dsh's default chat provider rather than an arbitrary chat-capable provider", async () => {
    const { services, wechatAssist } = makeServices();
    services.settings = {
      conversation: { default_provider_id: "selected-chat" },
      providers: [
        { id: "other-chat", model: "wrong-model", purposes: ["chat"], default_for: ["chat"] },
        { id: "selected-chat", model: "selected-model", purposes: ["chat"] },
      ],
    } as never;

    const result = await dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"),
      services,
      "POST",
      { conversation_id: "wechat:alice", contact_id: "alice", objective: "test" },
    );

    expect(result.status).toBe(201);
    expect(wechatAssist.startReplyTask).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: "selected-chat", model_id: "selected-model",
    }));
  });

  it("uses only dsh's default_for chat provider when no explicit default is set", async () => {
    const { services, wechatAssist } = makeServices();
    services.settings = {
      conversation: { default_provider_id: "" },
      providers: [
        { id: "non-chat", model: "wrong-model", purposes: ["distill"] },
        { id: "default-chat", model: "chat-model", purposes: ["chat"], default_for: ["chat"] },
      ],
    } as never;

    await dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"),
      services,
      "POST",
      { conversation_id: "wechat:alice", contact_id: "alice", objective: "test" },
    );

    expect(wechatAssist.startReplyTask).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: "default-chat", model_id: "chat-model",
    }));
  });

  it("does not silently substitute another provider for an invalid dsh default", async () => {
    const { services, wechatAssist } = makeServices();
    services.settings = {
      conversation: { default_provider_id: "missing-provider" },
      providers: [{ id: "fallback", model: "fallback-model", default_for: ["chat"] }],
    } as never;

    await expect(dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks"),
      services,
      "POST",
      { conversation_id: "wechat:alice", contact_id: "alice", objective: "test" },
    )).rejects.toThrow("dsh 当前聊天模型未配置");
    expect(wechatAssist.startReplyTask).not.toHaveBeenCalled();
  });

  it("routes the stop button to the idempotent task stop service", async () => {
    const { services, wechatAssist } = makeServices();
    const result = await dispatch(
      new URL("http://dsh/knowself-api/write/wechat-assist/reply-tasks/task-1/stop"),
      services,
      "POST",
      {},
    );
    expect(result).toEqual({ status: 200, body: { id: "task-1", status: "stopped" } });
    expect(wechatAssist.stopReplyTask).toHaveBeenCalledWith("task-1");
  });
});
