import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { createPersonStore, type PersonStore } from "../src/store";
import { makeTempDir, removeTempDir } from "./helpers";

const NOW = "2026-11-15T10:00:00.000Z";

let dir: string;
let store: PersonStore;

beforeEach(() => {
  dir = makeTempDir();
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function commitConversation(input: {
  batchId: string;
  conversationId: string;
  kind: "direct" | "group";
  title: string;
  rows: Array<{
    id: string;
    senderId: string;
    senderName: string;
    role: "me" | "other" | "system";
    tsMs: number;
    content: string;
  }>;
}): void {
  store.staging.beginBatch({ batch_id: input.batchId, platform: "wechat", extractor: "test", tool_version: "test", now: NOW });
  store.staging.stageMessages({
    batch_id: input.batchId,
    conversation_id: input.conversationId,
    now: NOW,
    rows: input.rows.map((row) => ({
      message_id: row.id,
      platform: "wechat" as const,
      sender_id: row.senderId,
      sender_name: row.senderName,
      role: row.role,
      ts_ms: row.tsMs,
      msg_date: "2026-11-15",
      content: row.content,
      content_type: "text" as const,
      reply_to: null,
      meta: "{}",
    })),
  });
  store.commitStaged({
    batch_id: input.batchId,
    conversation_id: input.conversationId,
    proposal_id: `proposal-${input.batchId}`,
    now: NOW,
    conversation: { conversation_id: input.conversationId, platform: "wechat", kind: input.kind, title: input.title },
  });
}

describe("replyHistory", () => {
  it("lists only an eligible direct conversation and uses a stable keyset cursor", () => {
    commitConversation({
      batchId: "direct-batch",
      conversationId: "wechat:direct-a",
      kind: "direct",
      title: "contact-a",
      rows: [
        { id: "a1", senderId: "me", senderName: "me", role: "me", tsMs: 1000, content: "one" },
        { id: "a2", senderId: "wxid-a", senderName: "contact-a", role: "other", tsMs: 1000, content: "two" },
        { id: "a3", senderId: "me", senderName: "me", role: "me", tsMs: 2000, content: "three" },
        { id: "a4", senderId: "wxid-a", senderName: "contact-a", role: "other", tsMs: 3000, content: "four" },
      ],
    });
    commitConversation({
      batchId: "group-batch",
      conversationId: "wechat:group-a",
      kind: "group",
      title: "group-a",
      rows: [
        { id: "g1", senderId: "me", senderName: "me", role: "me", tsMs: 1000, content: "group" },
        { id: "g2", senderId: "wxid-a", senderName: "contact-a", role: "other", tsMs: 2000, content: "not allowed" },
        { id: "g3", senderId: "wxid-b", senderName: "contact-b", role: "other", tsMs: 3000, content: "also not allowed" },
      ],
    });

    expect(store.replyHistory.listDirectConversations()).toEqual([
      expect.objectContaining({ conversation_id: "wechat:direct-a", title: "contact-a" }),
    ]);

    const first = store.replyHistory.listMessages({ conversation_id: "wechat:direct-a", limit: 2 });
    expect(first.rows.map((row) => row.message_id)).toEqual(["a1", "a2"]);
    expect(first.next_cursor).toEqual({ ts_ms: 1000, message_id: "a2" });

    const second = store.replyHistory.listMessages({
      conversation_id: "wechat:direct-a",
      after: first.next_cursor ?? undefined,
      limit: 2,
    });
    expect(second.rows.map((row) => row.message_id)).toEqual(["a3", "a4"]);
    expect(second.next_cursor).toBeNull();
    expect(store.replyHistory.listMessages({ conversation_id: "wechat:group-a" }).rows).toEqual([]);
  });

  it("rejects a direct conversation without an active self member", () => {
    commitConversation({
      batchId: "other-batch",
      conversationId: "wechat:direct-other",
      kind: "direct",
      title: "other",
      rows: [{ id: "o1", senderId: "wxid-a", senderName: "contact-a", role: "other", tsMs: 1000, content: "private" }],
    });
    expect(store.replyHistory.listDirectConversations()).toEqual([]);
    expect(store.replyHistory.listMessages({ conversation_id: "wechat:direct-other" }).rows).toEqual([]);
  });
});
