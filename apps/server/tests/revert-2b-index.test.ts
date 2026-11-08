/**
 * 批 2b —— 回滚四步 ③：按受影响会话重建检索索引后，已撤内容不再命中（验收基线 4）。
 *
 * 走真实 retrieval.sqlite + buildChatIndex + adaptChatStore + createChatFtsRetriever，
 * 不用 mock 充数：`messages.list` 是 context-router 的索引读口，buildFilter 守卫
 * 修好后重建才会 heal（旧 chunk 残留 ⇒ 按会话全量先删后建）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { adaptChatStore } from "@knowself/context-router";
import { openRetrievalDb, type RetrievalDb } from "../../../packages/context-router/src/db";
import { buildChatIndex } from "../../../packages/context-router/src/chat-index";
import { createChatFtsRetriever } from "../../../packages/context-router/src/retriever/chat-fts";

const NOW = "2026-11-07T08:00:00.000Z";
const REVERT_AT = "2026-11-07T09:00:00.000Z";
const CONV = "wechat:conv-1";
const KEEP_BATCH = "keep-batch";
const REVERT_BATCH = "revert-batch";
// 纯 ASCII 单 token，避开 jieba 中文切词的召回噪声
const REVERTED_TOKEN = "revertedtoken";
const KEPT_TOKEN = "kepttoken";

let dir: string;
let store: PersonStore;
let retrieval: RetrievalDb;

function seedBatch(batchId: string, messageId: string, token: string, tsMs: number): void {
  const staging = store.staging;
  staging.beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "test",
    tool_version: "v1",
    now: NOW,
  });
  staging.stageMessages({
    batch_id: batchId,
    conversation_id: CONV,
    rows: [
      {
        message_id: messageId,
        platform: "wechat",
        sender_id: "wxid_a",
        sender_name: "张三",
        role: "other",
        ts_ms: tsMs,
        msg_date: "2026-11-07",
        content: token,
        content_type: "text",
        reply_to: null,
        meta: "{}",
      },
    ],
    now: NOW,
  });
  staging.finishBatch({
    batch_id: batchId,
    status: "succeeded",
    conversation_count: 1,
    message_count: 1,
    now: NOW,
  });
  store.messages.insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: "wxid_a",
      sender_name: "张三",
      role: "other",
      ts_ms: tsMs,
      msg_date: "2026-11-07",
      content: token,
      content_type: "text",
      batch_id: batchId,
      ingested_at: NOW,
    },
  ]);
}

/**
 * 造「整会话全部消息来自同一个批次」的场景（QA 取证的真实缺陷边界）。
 * 与 seedBatch 分开，避免改动既有「同会话含保留批次」用例的造数。
 */
function seedSoleBatchConversation(
  conv: string,
  batchId: string,
  messageId: string,
  token: string,
): void {
  store.conversations.upsertFromCommit(
    { conversation_id: conv, platform: "wechat", kind: "direct", title: "李四" },
    NOW,
  );
  store.staging.beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "test",
    tool_version: "v1",
    now: NOW,
  });
  store.staging.stageMessages({
    batch_id: batchId,
    conversation_id: conv,
    rows: [
      {
        message_id: messageId,
        platform: "wechat",
        sender_id: "wxid_b",
        sender_name: "李四",
        role: "other",
        ts_ms: 3000,
        msg_date: "2026-11-07",
        content: token,
        content_type: "text",
        reply_to: null,
        meta: "{}",
      },
    ],
    now: NOW,
  });
  store.staging.finishBatch({
    batch_id: batchId,
    status: "succeeded",
    conversation_count: 1,
    message_count: 1,
    now: NOW,
  });
  store.messages.insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: conv,
      platform: "wechat",
      sender_id: "wxid_b",
      sender_name: "李四",
      role: "other",
      ts_ms: 3000,
      msg_date: "2026-11-07",
      content: token,
      content_type: "text",
      batch_id: batchId,
      ingested_at: NOW,
    },
  ]);
}

function chunkCountOf(conv: string): number {
  return (
    retrieval
      .prepare("SELECT COUNT(*) AS n FROM chat_chunks WHERE conversation_id = ?")
      .get(conv) as { n: number }
  ).n;
}

const chatIndexDeps = () => ({ db: retrieval, embedFn: null, modelId: "test-model" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-revert2b-index-"));
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
  store.conversations.upsertFromCommit(
    { conversation_id: CONV, platform: "wechat", kind: "direct", title: "张三" },
    NOW,
  );
  retrieval = openRetrievalDb(join(dir, "retrieval.sqlite"));
  seedBatch(KEEP_BATCH, "m-keep", KEPT_TOKEN, 1000);
  seedBatch(REVERT_BATCH, "m-revert", REVERTED_TOKEN, 2000);
});

afterEach(() => {
  retrieval.raw.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("回滚后按会话重建聊天索引（验收基线 4）", () => {
  it("撤销后 count 下降、searchContent 搜不到；重建索引后 FTS 检索不命中", async () => {
    const source = adaptChatStore(store);
    const fts = createChatFtsRetriever(retrieval);

    // 0) 撤销前：两条消息都在索引里，两个 token 都能检索到
    const built = await buildChatIndex(chatIndexDeps(), source);
    expect(built.chunkCount).toBe(2);
    expect((await fts.search(REVERTED_TOKEN, 10)).length).toBeGreaterThan(0);
    expect((await fts.search(KEPT_TOKEN, 10)).length).toBeGreaterThan(0);
    expect(store.messages.count({ conversation_id: CONV })).toBe(2);
    expect(store.messages.searchContent({ keyword: REVERTED_TOKEN })).toHaveLength(1);

    // 1) 回滚：批次置 reverted（不物理删）
    store.revertBatch({ batch_id: REVERT_BATCH, now: REVERT_AT });
    expect(store.messages.count({ conversation_id: CONV })).toBe(1);
    expect(store.messages.searchContent({ keyword: REVERTED_TOKEN })).toEqual([]);
    // 索引是派生缓存，未重建前旧 chunk 仍在（这正是需要步骤 ③ 的原因）
    expect((await fts.search(REVERTED_TOKEN, 10)).length).toBeGreaterThan(0);

    // 2) 调用方按受影响会话重建（CLI 的 buildChatIndex({conversationIds})）
    const rebuilt = await buildChatIndex(chatIndexDeps(), source, { conversationIds: [CONV] });
    expect(rebuilt.conversationCount).toBe(1);
    expect(rebuilt.chunkCount).toBe(1);

    // 3) 已撤内容不再命中；保留内容仍可检索（不是「把索引全删了」的假绿）
    expect((await fts.search(REVERTED_TOKEN, 10)).length).toBe(0);
    expect((await fts.search(KEPT_TOKEN, 10)).length).toBeGreaterThan(0);
    // 索引读口本身也不再读到已撤消息
    expect(source.listMessages(CONV, 500, 0).map((m) => m.message_id)).toEqual(["m-keep"]);
  });

  it("边界：整会话全部消息来自被撤批次时，空会话旧 chunk 也被清掉（QA 确认的假撤销缺陷）", async () => {
    const ALL_CONV = "wechat:all-reverted";
    const ALL_BATCH = "all-reverted-batch";
    const ALL_TOKEN = "allrevertedtoken";
    seedSoleBatchConversation(ALL_CONV, ALL_BATCH, "m-all", ALL_TOKEN);

    const source = adaptChatStore(store);
    const fts = createChatFtsRetriever(retrieval);
    await buildChatIndex(chatIndexDeps(), source);
    expect(chunkCountOf(ALL_CONV)).toBe(1);
    expect((await fts.search(ALL_TOKEN, 10)).length).toBeGreaterThan(0);

    // 回滚：该会话唯一批次被撤 ⇒ messages.list 返回 0（buildFilter 守卫），
    // 但 chat_conversations 仍在（append-only）⇒ 会话仍进重建循环
    store.revertBatch({ batch_id: ALL_BATCH, now: REVERT_AT });
    expect(store.messages.count({ conversation_id: ALL_CONV })).toBe(0);
    expect(source.listMessages(ALL_CONV, 500, 0)).toEqual([]);
    expect(store.conversations.get(ALL_CONV)).not.toBeNull();
    expect((await fts.search(ALL_TOKEN, 10)).length).toBeGreaterThan(0); // 重建前旧 chunk 仍在

    // 调用方按受影响会话重建（CLI 的 buildChatIndex({conversationIds})）
    const rebuilt = await buildChatIndex(chatIndexDeps(), source, { conversationIds: [ALL_CONV] });

    // 结果计数如实：不是只报 skippedConversations 让调用方以为没做事
    expect(rebuilt.skippedConversations).toBe(1);
    expect(rebuilt.cleanedEmptyConversations).toBe(1);
    expect(rebuilt.conversationCount).toBe(0);
    expect(rebuilt.chunkCount).toBe(0);

    // 旧 chunk / FTS / 向量映射全部清零，被撤 token 不再被召回
    expect(chunkCountOf(ALL_CONV)).toBe(0);
    expect((await fts.search(ALL_TOKEN, 10)).length).toBe(0);
    // 直接查 FTS 影子表（外部内容表）：被撤 token 不得再有可匹配的倒排项
    expect(
      (
        retrieval
          .prepare("SELECT COUNT(*) AS n FROM chat_chunks_fts WHERE chat_chunks_fts MATCH ?")
          .get(ALL_TOKEN) as { n: number }
      ).n,
    ).toBe(0);
    // 无关会话（含保留批次）不被误删
    expect(chunkCountOf(CONV)).toBe(2);
    expect((await fts.search(KEPT_TOKEN, 10)).length).toBeGreaterThan(0);

    // 幂等：再重建一次不虚报清理
    const again = await buildChatIndex(chatIndexDeps(), source, { conversationIds: [ALL_CONV] });
    expect(again.cleanedEmptyConversations).toBe(0);
    expect(chunkCountOf(ALL_CONV)).toBe(0);
  });
});
