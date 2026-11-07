/**
 * retriever-vector.test.ts — 向量检索真实算法测试
 *
 * Mock embedFn 返回固定向量，禁止真起 transformers 管线。
 * V2 新增 sqlite-vec ANN 路径测试（vec_embeddings + vec_chunk_map）。
 */

import { describe, it, expect, vi } from "vitest";
import { openRetrievalDb } from "../src/db";
import { createVectorRetriever } from "../src/retriever/vector";
import type { RetrievalDb } from "../src/db";
import type { EmbedFn } from "../src/embedding";

const NOW = "2026-05-28T00:00:00.000Z";

function insertChunk(db: RetrievalDb, id: number): void {
  db.prepare(
    `INSERT INTO chunks (id, doc_id, doc_source, doc_ref, parent_index, child_index,
       parent_text, child_text, tokens, tags, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "card_test",
    "card",
    "card_test",
    0,
    0,
    `chunk ${id}`,
    `chunk ${id} body`,
    10,
    "[]",
    NOW,
    NOW,
  );
}

function insertEmbedding(db: RetrievalDb, chunkId: number, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  db.prepare(
    "INSERT INTO embeddings (chunk_id, model_id, dim, vector, indexed_at) VALUES (?, ?, ?, ?, ?)",
  ).run(chunkId, "test-model", vec.length, buf, NOW);
  // 同步写入 sqlite-vec ANN 虚拟表 + 映射表
  const info = db.prepare("INSERT INTO vec_embeddings(embedding) VALUES (?)").run(buf);
  db.prepare("INSERT INTO vec_chunk_map(vec_rowid, chunk_id) VALUES (?, ?)").run(
    Number(info.lastInsertRowid),
    chunkId,
  );
}

function makeVec(...values: number[]): Float32Array {
  const arr = new Float32Array(1024);
  for (let i = 0; i < Math.min(values.length, 1024); i++) arr[i] = values[i]!;
  return arr;
}

describe("createVectorRetriever", () => {
  it("embedFn 为 null 返回空数组", async () => {
    const db = openRetrievalDb(":memory:");
    const retriever = createVectorRetriever(db, null);
    const hits = await retriever.search("测试", 30);
    expect(hits).toHaveLength(0);
  });

  it("embedFn 抛错时返回空数组不冒泡", async () => {
    const db = openRetrievalDb(":memory:");
    const embedFn = vi.fn<EmbedFn>(async () => {
      throw new Error("embed fail");
    });
    const retriever = createVectorRetriever(db, embedFn);

    await expect(retriever.search("测试", 30)).resolves.toHaveLength(0);
  });

  it("query 命中（vec0 ANN 路径）：手工插 3 条 chunk + 3 条 embedding + vec 映射，mock embedFn 返回与第 1 条最近的向量，断言 top-1 是第 1 条 chunk", async () => {
    const db = openRetrievalDb(":memory:");
    insertChunk(db, 1);
    insertChunk(db, 2);
    insertChunk(db, 3);
    insertEmbedding(db, 1, makeVec(1, 0, 0));
    insertEmbedding(db, 2, makeVec(0, 1, 0));
    insertEmbedding(db, 3, makeVec(0, 0, 1));

    const embedFn = vi.fn<EmbedFn>(async () => [makeVec(1, 0, 0)]);
    const retriever = createVectorRetriever(db, embedFn);

    const hits = await retriever.search("query", 3);

    expect(hits).toHaveLength(3);
    expect(hits[0]!.chunkId).toBe(1);
    expect(hits[0]!.score).toBeCloseTo(1, 4);
    expect(hits[0]!.lane).toBe("vector");
  });

  it("score 排序正确：返回数组按 score 降序", async () => {
    const db = openRetrievalDb(":memory:");
    insertChunk(db, 10);
    insertChunk(db, 20);
    insertChunk(db, 30);
    insertEmbedding(db, 10, makeVec(1, 0, 0));
    insertEmbedding(db, 20, makeVec(0, 1, 0));
    insertEmbedding(db, 30, makeVec(0, 0, 1));

    const embedFn = vi.fn<EmbedFn>(async () => [makeVec(0.5, 0.5, 0)]);
    const retriever = createVectorRetriever(db, embedFn);

    const hits = await retriever.search("query", 3);

    expect(hits).toHaveLength(3);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
  });

  it("recall 限制生效", async () => {
    const db = openRetrievalDb(":memory:");
    insertChunk(db, 1);
    insertChunk(db, 2);
    insertChunk(db, 3);
    insertEmbedding(db, 1, makeVec(1, 0, 0));
    insertEmbedding(db, 2, makeVec(0, 1, 0));
    insertEmbedding(db, 3, makeVec(0, 0, 1));

    const embedFn = vi.fn<EmbedFn>(async () => [makeVec(1, 0, 0)]);
    const retriever = createVectorRetriever(db, embedFn);

    const hits = await retriever.search("query", 1);

    expect(hits).toHaveLength(1);
  });

  it("vec_embeddings 空时降级到 embeddings 全表扫描仍能返回结果", async () => {
    // 只写 embeddings 表，不写 vec_embeddings → 触发降级路径
    const db = openRetrievalDb(":memory:");
    insertChunk(db, 1);
    insertChunk(db, 2);

    const buf = Buffer.from(makeVec(1, 0, 0).buffer);
    db.prepare(
      "INSERT INTO embeddings (chunk_id, model_id, dim, vector, indexed_at) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "test-model", 1024, buf, NOW);

    const embedFn = vi.fn<EmbedFn>(async () => [makeVec(1, 0, 0)]);
    const retriever = createVectorRetriever(db, embedFn);

    const hits = await retriever.search("query", 2);

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.chunkId).toBe(1);
  });
});
