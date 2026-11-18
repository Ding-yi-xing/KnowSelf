import { describe, expect, it, vi } from "vitest";
import type { ReplyContextMessage } from "@knowself/context-router";
import { createWechatReplyContextService, ReplyContextError } from "../src/wechat-reply-context.js";

function message(id: string, conversationId = "conv-a", content = id): ReplyContextMessage {
  return {
    message_id: id,
    conversation_id: conversationId,
    sender_id: "alice",
    role: "other",
    ts_ms: 1_700_000_000_000,
    content,
    content_type: "text",
    indexed_at: "2026-11-15T00:00:00.000Z",
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const recent = [message("old", "conv-a", "older"), message("new", "conv-a", "latest")];
  const relevant = [message("new", "conv-a", "latest"), message("match", "conv-a", "relevant")];
  const syncConversation = vi.fn(() => 0);
  const search = vi.fn(() => relevant);
  const audit = vi.fn();
  const service = createWechatReplyContextService({
    history: {
      listDirectConversations: () => [{
        conversation_id: "conv-a", contact_id: "alice", title: "Alice", last_msg_ts_ms: null,
      }],
      listMessages: () => ({ rows: [], next_cursor: null }),
    } as never,
    index: {
      state: () => ({ state: "ready", last_ts_ms: 1, last_message_id: "new" }),
      syncConversation,
      recent: () => recent,
      search,
    } as never,
    source: { listMessages: () => ({ rows: [], next_cursor: null }) },
    audit,
    ...overrides,
  });
  return { service, recent, relevant, syncConversation, search, audit };
}

const baseInput = {
  task_id: "task-1",
  contact_id: "alice",
  conversation_id: "conv-a",
  query: "hello",
  history_authorized: true,
  authorization_version: 1,
};

describe("wechat reply context", () => {
  it("requires explicit history authorization before touching the source", async () => {
    const h = setup();
    await expect(h.service.build({ ...baseInput, history_authorized: false })).rejects.toMatchObject<
      Partial<ReplyContextError>
    >({ code: "HISTORY_NOT_AUTHORIZED" });
    expect(h.syncConversation).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("revalidates direct-contact mapping and rejects a cross-contact conversation", async () => {
    const h = setup();
    await expect(h.service.build({ ...baseInput, conversation_id: "conv-other" })).rejects.toMatchObject({
      code: "CONTACT_CONVERSATION_MISMATCH",
    });
    expect(h.syncConversation).not.toHaveBeenCalled();
  });

  it("rejects the transport username as contact_id (callers must resolve person_id first)", async () => {
    // 2026-11-17 真实事故：任务上的 contact_id 是微信 username，
    // 直接喂进来会每轮都 mismatch，三轮后任务被「连续 3 次失败」暂停。
    const h = setup();
    await expect(h.service.build({ ...baseInput, contact_id: "wxid_alice" })).rejects.toMatchObject({
      code: "CONTACT_CONVERSATION_MISMATCH",
    });
    expect(h.syncConversation).not.toHaveBeenCalled();
  });

  it("incrementally refreshes only the selected conversation and deduplicates results", async () => {
    const h = setup();
    const result = await h.service.build(baseInput);
    expect(h.syncConversation).toHaveBeenCalledWith(
      { conversation_id: "conv-a", contact_id: "alice", title: "Alice" },
      { listMessages: expect.any(Function) },
      { batchSize: 500, maxMessages: 1000 },
    );
    expect(h.search).toHaveBeenCalledWith("conv-a", "hello", 8);
    expect(result.recent.map((item) => item.message_id)).toEqual(["old", "new"]);
    expect(result.relevant.map((item) => item.message_id)).toEqual(["match"]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      task_id: "task-1",
      source_count: 3,
      authorization_version: 1,
    }));
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({
      contact_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      conversation_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      source_message_ids_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(h.audit.mock.calls[0]?.[0])).not.toContain("latest");
  });

  it("applies hard caps to history counts and token budget", async () => {
    const h = setup();
    const result = await h.service.build({ ...baseInput, recent_limit: 999, top_k: 999, token_budget: 99_999 });
    expect(h.search).toHaveBeenCalledWith("conv-a", "hello", 12);
    expect(h.recent.length).toBeLessThanOrEqual(60);
    expect(result.estimated_tokens).toBeLessThanOrEqual(6000);
  });

  it("fails closed when the index is unavailable", async () => {
    const h = setup();
    const failing = createWechatReplyContextService({
      history: {
        listDirectConversations: () => [{
          conversation_id: "conv-a", contact_id: "alice", title: "Alice", last_msg_ts_ms: null,
        }],
      } as never,
      index: { state: () => ({ state: "failed", last_ts_ms: null, last_message_id: null }) } as never,
      source: { listMessages: () => ({ rows: [], next_cursor: null }) },
    });
    await expect(failing.build(baseInput)).rejects.toMatchObject({ code: "REPLY_INDEX_UNAVAILABLE" });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("compacts XML, long messages and duplicates before injecting", async () => {
    const longText = "很长很长的一段话".repeat(20);
    const service = createWechatReplyContextService({
      history: {
        listDirectConversations: () => [{
          conversation_id: "conv-a", contact_id: "alice", title: "Alice", last_msg_ts_ms: null,
        }],
      } as never,
      index: {
        state: () => ({ state: "ready", last_ts_ms: 1, last_message_id: "x" }),
        syncConversation: () => 0,
        recent: () => [
          message("xml", "conv-a", "<msg><img aeskey=\"x\"/></msg>"),
          message("long", "conv-a", longText),
          message("dup1", "conv-a", "楼下"),
          message("dup2", "conv-a", "楼下"),
        ],
        search: () => [],
      } as never,
      source: { listMessages: () => ({ rows: [], next_cursor: null }) },
    });
    const result = await service.build(baseInput);
    const contents = result.recent.map((item) => item.content);
    expect(contents.some((content) => content.startsWith("<"))).toBe(false);
    expect(contents.every((content) => content.length <= 61)).toBe(true);
    expect(contents.filter((content) => content === "楼下")).toHaveLength(1);
  });
});
