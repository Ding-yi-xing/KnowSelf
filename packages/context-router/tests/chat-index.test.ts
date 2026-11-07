/**
 * chat-index.test.ts — 聊天索引构建（K-33 / K-36 写入侧）
 *
 * 覆盖：窗口切分 / 预分词列 / message_ids 回溯 / 幂等重建 / 向量只写窗口代表行 /
 *       schema_version 2→3 迁移 / doc_id 长度约束。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRetrievalDb, EMBEDDING_DIM, type RetrievalDb } from "../src/db";
import {
  buildChatIndex,
  splitIntoWindows,
  segmentText,
  SESSION_GAP_MS,
  MAX_WINDOW_MESSAGES,
  type ChatIndexMessage,
  type ChatIndexSource,
} from "../src/chat-index";
import { chatDocId } from "../src/retriever/hybrid";
import { createChatFtsRetriever } from "../src/retriever/chat-fts";

let dir: string;
let dbPath: string;
let db: RetrievalDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-chatidx-"));
  dbPath = join(dir, "retrieval.sqlite");
  db = openRetrievalDb(dbPath);
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

function msg(
  id: string,
  conv: string,
  ts: number,
  content: string,
  sender = "p1",
): ChatIndexMessage {
  return {
    message_id: id,
    conversation_id: conv,
    sender_id: sender,
    sender_name: sender === "me" ? "我" : "张三",
    role: sender === "me" ? "user" : "assistant",
    ts_ms: ts,
    msg_date: "2026-09-01",
    content,
    content_type: "text",
  };
}

function makeSource(convs: Record<string, ChatIndexMessage[]>): ChatIndexSource {
  return {
    listConversations: (limit, offset) =>
      Object.keys(convs)
        .slice(offset, offset + limit)
        .map((id) => ({
          conversation_id: id,
          title: id,
          kind: "direct",
          owner_person_id: "me",
        })),
    listMessages: (conv, limit, offset) => (convs[conv] ?? []).slice(offset, offset + limit),
  };
}

describe("splitIntoWindows", () => {
  it("间隔 ≤ 30 分钟且 ≤ 20 条归同一窗口", () => {
    const messages = [
      msg("m1", "c1", 0, "a"),
      msg("m2", "c1", 60_000, "b"),
      msg("m3", "c1", 120_000, "c"),
    ];
    const windows = splitIntoWindows(messages);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.messages).toHaveLength(3);
  });

  it("超过 30 分钟切新窗口", () => {
    const messages = [
      msg("m1", "c1", 0, "a"),
      msg("m2", "c1", SESSION_GAP_MS + 1, "b"),
    ];
    const windows = splitIntoWindows(messages);
    expect(windows).toHaveLength(2);
    expect(windows[1]!.parent_index).toBe(1);
  });

  it("单窗口不超过 20 条", () => {
    const messages = Array.from({ length: MAX_WINDOW_MESSAGES + 5 }, (_, i) =>
      msg(`m${i}`, "c1", i * 1000, `x${i}`),
    );
    const windows = splitIntoWindows(messages);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.messages).toHaveLength(MAX_WINDOW_MESSAGES);
  });
});

describe("segmentText", () => {
  it("多词句的 seg_text 被空格分隔（单 token 句保持原样）", () => {
    const seg = segmentText("张三今天去北京出差");
    expect(seg).toContain(" ");
    expect(seg).toContain("北京");
    // 「你好」在 jieba 里是单词，不产生空格——这是正常结果，不是缺陷
    expect(segmentText("你好")).toBe("你好");
  });
});

describe("buildChatIndex", () => {
  it("每个会话按消息建行，窗口数与 message_ids 正确", async () => {
    const source = makeSource({
      c1: [msg("m1", "c1", 0, "你好"), msg("m2", "c1", 1000, "最近怎么样")],
    });

    const result = await buildChatIndex({ db, embedFn: null, modelId: "test" }, source);

    expect(result).toMatchObject({ conversationCount: 1, windowCount: 1, chunkCount: 2 });
    const rows = db
      .prepare("SELECT parent_index, child_index, seg_text, message_ids FROM chat_chunks ORDER BY id")
      .all() as { parent_index: number; child_index: number; seg_text: string; message_ids: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.parent_index).toBe(0);
    expect(rows[0]!.child_index).toBe(0);
    expect(rows[1]!.child_index).toBe(1);
    expect(JSON.parse(rows[0]!.message_ids)).toEqual(["m1", "m2"]);
    // m2「最近怎么样」是多词句，分词后应含空格
    expect(rows[1]!.seg_text).toContain(" ");
  });

  it("FTS 召回生效：未登录词（人名）也能命中（预分词 + 字级兜底）", async () => {
    const source = makeSource({
      c1: [msg("m1", "c1", 0, "张三今天去北京出差"), msg("m2", "c1", 1000, "收到")],
    });
    await buildChatIndex({ db, embedFn: null, modelId: "test" }, source);

    const retriever = createChatFtsRetriever(db);
    const hits = await retriever.search("张三", 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.lane).toBe("fts5");
  });

  it("幂等：重复构建不产生重复行", async () => {
    const source = makeSource({ c1: [msg("m1", "c1", 0, "a"), msg("m2", "c1", 1000, "b")] });
    await buildChatIndex({ db, embedFn: null, modelId: "test" }, source);
    await buildChatIndex({ db, embedFn: null, modelId: "test" }, source);

    const count = db.prepare("SELECT COUNT(*) AS n FROM chat_chunks").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("向量只写窗口代表行（窗口级粒度）", async () => {
    const source = makeSource({
      c1: [
        msg("m1", "c1", 0, "a"),
        msg("m2", "c1", 1000, "b"),
        msg("m3", "c1", SESSION_GAP_MS + 5000, "c"),
      ],
    });
    const embedFn = async (texts: string[]) =>
      texts.map(() => new Float32Array(EMBEDDING_DIM).fill(0.1));

    const result = await buildChatIndex({ db, embedFn, modelId: "test" }, source);

    expect(result.windowCount).toBe(2);
    expect(result.embeddedCount).toBe(2);
    const emb = db.prepare("SELECT COUNT(*) AS n FROM chat_embeddings").get() as { n: number };
    const map = db.prepare("SELECT COUNT(*) AS n FROM chat_vec_chunk_map").get() as { n: number };
    expect(emb.n).toBe(2);
    expect(map.n).toBe(2);
  });

  it("只索引 owner 为 me 的会话", async () => {
    const source: ChatIndexSource = {
      listConversations: () => [
        { conversation_id: "mine", title: "", kind: "direct", owner_person_id: "me" },
        { conversation_id: "other", title: "", kind: "direct", owner_person_id: "someone" },
      ],
      listMessages: (conv) => (conv === "mine" ? [msg("m1", "mine", 0, "a")] : [msg("m2", "other", 0, "b")]),
    };
    await buildChatIndex({ db, embedFn: null, modelId: "test" }, source);

    const rows = db.prepare("SELECT conversation_id FROM chat_chunks").all() as {
      conversation_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_id).toBe("mine");
  });
});

describe("schema 迁移", () => {
  it("新库 schema_version = 3，且 chat 表与 1024 维向量表就绪", () => {
    const version = db
      .prepare("SELECT value FROM index_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("3");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_%'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "chat_chunks",
        "chat_embeddings",
        "chat_vec_chunk_map",
        "chat_chunks_fts",
      ]),
    );

    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_vec_embeddings'")
      .get() as { sql: string };
    expect(sql.sql).toContain(`float[${EMBEDDING_DIM}]`);
  });

  it("旧库（schema_version=2）打开后升到 3", () => {
    db.raw.close();

    // 造一个 v2 库：只留基线表 + 版本 2
    const legacyPath = join(dir, "legacy.sqlite");
    const legacy = openRetrievalDb(legacyPath);
    legacy.prepare("UPDATE index_meta SET value = '2' WHERE key = 'schema_version'").run();
    legacy.raw.exec("DROP TABLE chat_chunks_fts");
    legacy.raw.exec("DROP TABLE chat_chunks");
    legacy.raw.close();

    const reopened = openRetrievalDb(legacyPath);
    const version = reopened
      .prepare("SELECT value FROM index_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("3");
    reopened.raw.close();

    // 还原当前 db 句柄，供 afterEach 关闭
    db = openRetrievalDb(dbPath);
  });
});

describe("chatDocId", () => {
  it("窗口级唯一且 ≤ 64 字符（长会话 id 被压缩）", () => {
    const longConv = `wechat_${"x".repeat(80)}@chatroom`;
    const a = chatDocId(longConv, 0);
    const b = chatDocId(longConv, 1);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(a.startsWith("chat_")).toBe(true);
  });
});
