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
  const personStore = { replyHistory: { listDirectConversations: vi.fn(() => [
    { conversation_id: "wechat:alice", contact_id: "alice", title: "Alice", last_msg_ts_ms: 1 },
  ]) } };
  const settings = { providers: [{ id: "provider-1", model: "model-1", purposes: ["chat"] }] };
  return { services: { wechatAssist, personStore, settings } as unknown as KnowselfServices, wechatAssist };
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
