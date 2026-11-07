/**
 * retriever-chat-hybrid.test.ts — 4 路召回融合（K-36）
 *
 * 重点验证：chunks.id 与 chat_chunks.id 是两个独立 id 空间，
 * 融合键必须带空间前缀，否则 profile chunk #1 与 chat chunk #1 会互相覆盖。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRetrievalDb, type RetrievalDb } from "../src/db";
import { hybridQuery } from "../src/retriever/hybrid";
import { buildChatIndex, type ChatIndexSource } from "../src/chat-index";

let dir: string;
let db: RetrievalDb;

const NOW = "2026-09-01T00:00:00.000Z";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-hybrid-"));
  db = openRetrievalDb(join(dir, "retrieval.sqlite"));
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertProfileChunk(id: number, text: string): void {
  db.prepare(
    `INSERT INTO chunks (id, doc_id, doc_source, doc_ref, parent_index, child_index,
                         parent_text, child_text, tokens, tags, updated_at, indexed_at)
     VALUES (?, 'card_work', 'card', 'cards/work.md', 0, 0, ?, ?, 5, '["work"]', ?, ?)`,
  ).run(id, text, text, NOW, NOW);
}

async function seedChat(): Promise<void> {
  const source: ChatIndexSource = {
    listConversations: () => [
      { conversation_id: "c1", title: "张三", kind: "direct", owner_person_id: "me" },
    ],
    listMessages: () => [
      {
        message_id: "m1",
        conversation_id: "c1",
        sender_id: "p1",
        sender_name: "张三",
        role: "assistant",
        ts_ms: 1_700_000_000_000,
        msg_date: "2026-09-01",
        content: "alpha 项目下周上线",
        content_type: "text",
      },
    ],
  };
  await buildChatIndex({ db, embedFn: null, modelId: "test" }, source);
}

describe("hybridQuery（4 路）", () => {
  it("profile 与 chat 的相同自增 id 不会互相覆盖", async () => {
    insertProfileChunk(1, "alpha beta gamma");
    await seedChat();

    const docs = await hybridQuery(
      { db, embedFn: null },
      {
        text: "alpha",
        top_k: 8,
        recall_per_lane: 30,
        filter_sources: [],
        date_range: null,
        exclude_doc_ids: [],
        include_score: true,
      },
    );

    expect(docs.length).toBeGreaterThanOrEqual(2);
    const sources = docs.map((d) => d.doc_source);
    expect(sources).toContain("card");
    expect(sources).toContain("message");

    // chunk_id 前缀区分空间
    const chatDoc = docs.find((d) => d.doc_source === "message")!;
    expect(chatDoc.chunk_id.startsWith("chat:")).toBe(true);
    const profileDoc = docs.find((d) => d.doc_source === "card")!;
    expect(profileDoc.chunk_id).toBe("1");
  });

  it("filter_sources=['message'] 只返回聊天结果", async () => {
    insertProfileChunk(1, "alpha beta gamma");
    await seedChat();

    const docs = await hybridQuery(
      { db, embedFn: null },
      {
        text: "alpha",
        top_k: 8,
        recall_per_lane: 30,
        filter_sources: ["message"],
        date_range: null,
        exclude_doc_ids: [],
        include_score: true,
      },
    );

    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs.every((d) => d.doc_source === "message")).toBe(true);
  });

  it("includeChat=false 时退回 V2 行为（只有 profile 召回）", async () => {
    insertProfileChunk(1, "alpha beta gamma");
    await seedChat();

    const docs = await hybridQuery(
      { db, embedFn: null, includeChat: false },
      {
        text: "alpha",
        top_k: 8,
        recall_per_lane: 30,
        filter_sources: [],
        date_range: null,
        exclude_doc_ids: [],
        include_score: true,
      },
    );

    expect(docs).toHaveLength(1);
    expect(docs[0]!.doc_source).toBe("card");
  });

  it("聊天结果的 doc_id 是窗口级且含 chat_ 前缀", async () => {
    await seedChat();

    const docs = await hybridQuery(
      { db, embedFn: null },
      {
        text: "alpha",
        top_k: 8,
        recall_per_lane: 30,
        filter_sources: [],
        date_range: null,
        exclude_doc_ids: [],
        include_score: true,
      },
    );

    expect(docs).toHaveLength(1);
    expect(docs[0]!.doc_id).toBe("chat_c1_0");
    expect(docs[0]!.doc_path).toBe("chat:c1:m1");
    expect(docs[0]!.parent_text).toContain("alpha 项目下周上线");
  });
});
