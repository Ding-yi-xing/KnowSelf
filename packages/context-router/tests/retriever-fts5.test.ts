/**
 * retriever-fts5.test.ts — FTS5 全文检索真实算法测试
 *
 * 用例准备：用 `:memory:` SQLite + 手工 INSERT INTO chunks（触发 chunks_ai 自动写入 chunks_fts）。
 */

import { describe, it, expect } from "vitest";
import { openRetrievalDb } from "../src/db";
import { createFts5Retriever } from "../src/retriever/fts5";
import type { RetrievalDb } from "../src/db";

function insertChunk(
  db: RetrievalDb,
  overrides: Partial<{
    doc_id: string;
    doc_source: string;
    doc_ref: string;
    child_text: string;
  }>,
): void {
  const now = "2026-05-28T00:00:00.000Z";
  db.prepare(
    `INSERT INTO chunks (doc_id, doc_source, doc_ref, parent_index, child_index,
       parent_text, child_text, tokens, tags, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.doc_id ?? "card_test",
    overrides.doc_source ?? "card",
    overrides.doc_ref ?? "card_test",
    0,
    0,
    overrides.child_text ?? "",
    overrides.child_text ?? "",
    10,
    "[]",
    now,
    now,
  );
}

describe("createFts5Retriever", () => {
  it("空 query 返回空数组", async () => {
    const db = openRetrievalDb(":memory:");
    const retriever = createFts5Retriever(db);
    const hits = await retriever.search("", 30);
    expect(hits).toHaveLength(0);
  });

  it("recall=0 返回空数组", async () => {
    const db = openRetrievalDb(":memory:");
    const retriever = createFts5Retriever(db);
    await expect(retriever.search("anything", 0)).resolves.toHaveLength(0);
  });

  it("中文 query TypeScript 用法 命中含 TypeScript 的 chunk", async () => {
    const db = openRetrievalDb(":memory:");
    insertChunk(db, { doc_ref: "card_a", child_text: "TypeScript is a typed language" });
    insertChunk(db, { doc_ref: "card_b", child_text: "Python is dynamically typed" });
    insertChunk(db, { doc_ref: "card_c", child_text: "Java is statically typed" });
    const retriever = createFts5Retriever(db);

    const hits = await retriever.search("TypeScript 用法", 30);

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.chunkId > 0)).toBe(true);
    expect(hits[0]!.lane).toBe("fts5");
  });

  it("score 单调递减且 ∈ (0, 1]", async () => {
    const db = openRetrievalDb(":memory:");
    insertChunk(db, { doc_ref: "card_x", child_text: "TypeScript TypeScript TypeScript" });
    insertChunk(db, { doc_ref: "card_y", child_text: "TypeScript" });
    insertChunk(db, {
      doc_ref: "card_z",
      child_text: "Python is dynamically typed interpreted language",
    });
    insertChunk(db, { doc_ref: "card_w", child_text: "Rust is a systems programming language" });
    insertChunk(db, { doc_ref: "card_v", child_text: "Java virtual machine platform independent" });
    const retriever = createFts5Retriever(db);

    const hits = await retriever.search("TypeScript", 30);

    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
  });

  it("query 全是单字被分词过滤返回空数组", async () => {
    const db = openRetrievalDb(":memory:");
    insertChunk(db, { doc_ref: "card_d", child_text: "Some meaningful content" });
    const retriever = createFts5Retriever(db);

    const hits = await retriever.search("的 了 是", 30);

    expect(hits).toHaveLength(0);
  });

  it("recall 限制生效：6 条命中但 recall=2 只返回 2 条", async () => {
    const db = openRetrievalDb(":memory:");
    for (let i = 0; i < 6; i++) {
      insertChunk(db, { doc_ref: `card_${i}`, child_text: `TypeScript usage example ${i}` });
    }
    const retriever = createFts5Retriever(db);

    const hits = await retriever.search("TypeScript", 2);

    expect(hits).toHaveLength(2);
  });
});
