/**
 * retriever-chat-vector.test.ts — 聊天向量召回（窗口级）
 *
 * Mock embedFn 返回固定向量，禁止真起 Ollama。
 */

import { describe, it, expect, vi } from "vitest";
import { openRetrievalDb, EMBEDDING_DIM, type RetrievalDb } from "../src/db";
import { createChatVectorRetriever } from "../src/retriever/chat-vector";
import type { EmbedFn } from "../src/embedding";

const NOW = "2026-09-01T00:00:00.000Z";

function insertChatChunk(db: RetrievalDb, id: number, text = `msg ${id}`): void {
  db.prepare(
    `INSERT INTO chat_chunks
      (id, doc_ref, conversation_id, person_id, parent_index, child_index,
       parent_text, child_text, seg_text, ts_ms, msg_date, message_ids, tokens, indexed_at)
     VALUES (?, ?, 'c1', 'p1', 0, 0, ?, ?, ?, 0, '2026-09-01', ?, 5, ?)`,
  ).run(id, `chat:c1:m${id}`, text, text, text, JSON.stringify([`m${id}`]), NOW);
}

function insertEmbedding(db: RetrievalDb, chunkId: number, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  db.prepare(
    "INSERT INTO chat_embeddings (chunk_id, model_id, dim, vector, indexed_at) VALUES (?, ?, ?, ?, ?)",
  ).run(chunkId, "test-model", vec.length, buf, NOW);
  const info = db.prepare("INSERT INTO chat_vec_embeddings(embedding) VALUES (?)").run(buf);
  db.prepare("INSERT INTO chat_vec_chunk_map(vec_rowid, chunk_id) VALUES (?, ?)").run(
    Number(info.lastInsertRowid),
    chunkId,
  );
}

function makeVec(value: number): Float32Array {
  return new Float32Array(EMBEDDING_DIM).fill(value);
}

describe("createChatVectorRetriever", () => {
  it("embedFn 为 null 返回空数组", async () => {
    const db = openRetrievalDb(":memory:");
    const retriever = createChatVectorRetriever(db, null);
    expect(await retriever.search("q", 10)).toHaveLength(0);
    db.raw.close();
  });

  it("embedFn 抛错时返回空数组不冒泡", async () => {
    const db = openRetrievalDb(":memory:");
    const embedFn = vi.fn<EmbedFn>(async () => {
      throw new Error("embed fail");
    });
    const retriever = createChatVectorRetriever(db, embedFn);
    expect(await retriever.search("q", 10)).toHaveLength(0);
    db.raw.close();
  });

  it("vec0 ANN 路径命中最近的 chat chunk", async () => {
    const db = openRetrievalDb(":memory:");
    insertChatChunk(db, 1);
    insertChatChunk(db, 2);
    insertEmbedding(db, 1, makeVec(1));
    insertEmbedding(db, 2, makeVec(0.1));

    const embedFn = vi.fn<EmbedFn>(async () => [makeVec(1)]);
    const retriever = createChatVectorRetriever(db, embedFn);
    const hits = await retriever.search("q", 5);

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.chunkId).toBe(1);
    expect(hits[0]!.lane).toBe("vector");
    db.raw.close();
  });

  it("vec 表为空时降级为全表余弦扫描", async () => {
    const db = openRetrievalDb(":memory:");
    insertChatChunk(db, 1);
    insertChatChunk(db, 2);
    // 只写 chat_embeddings，不写 vec0（模拟 ANN 不可用 / 重建中）
    const buf = Buffer.from(makeVec(1).buffer);
    db.prepare(
      "INSERT INTO chat_embeddings (chunk_id, model_id, dim, vector, indexed_at) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "test-model", EMBEDDING_DIM, buf, NOW);

    const embedFn = vi.fn<EmbedFn>(async () => [makeVec(1)]);
    const retriever = createChatVectorRetriever(db, embedFn);
    const hits = await retriever.search("q", 5);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunkId).toBe(1);
    db.raw.close();
  });

  it("recall <= 0 或空查询直接返回空", async () => {
    const db = openRetrievalDb(":memory:");
    const embedFn = vi.fn<EmbedFn>(async () => [makeVec(1)]);
    const retriever = createChatVectorRetriever(db, embedFn);

    expect(await retriever.search("q", 0)).toHaveLength(0);
    expect(await retriever.search("   ", 5)).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
    db.raw.close();
  });
});
