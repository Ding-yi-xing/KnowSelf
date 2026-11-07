/**
 * hybrid.ts — RRF 混合检索融合（V3：4 路召回）
 *
 * 召回源（DESIGN-10 §7.4）：
 *   profile 侧：`chunks_fts` + `vec_embeddings`
 *   chat 侧   ：`chat_chunks_fts` + `chat_vec_embeddings`
 *
 * 两个 id 空间独立（chunks.id / chat_chunks.id 会重号），融合键必须带空间前缀。
 * rrf_k 默认 60（官方推荐值）。
 */

import type { RetrievedDoc, RetrieveQuery, DocSourceType, RecallLane } from "@knowself/contracts";
import type { RetrievalDb } from "../db";
import type { EmbedFn } from "../embedding";
import { createFts5Retriever } from "./fts5";
import { createVectorRetriever } from "./vector";
import { createChatFtsRetriever } from "./chat-fts";
import { createChatVectorRetriever } from "./chat-vector";

// ─── 统一命中（带 id 空间） ────────────────────────────────────────────

type Space = "profile" | "chat";

interface UnifiedHit {
  space: Space;
  id: number;
  lane: RecallLane;
}

function hitKey(space: Space, id: number): string {
  return `${space === "chat" ? "c" : "p"}:${id}`;
}

// ─── SQLite 行 ────────────────────────────────────────────────────────

interface ChunkRow {
  id: number;
  doc_id: string;
  doc_source: string;
  doc_ref: string;
  parent_text: string;
  tokens: number;
  tags: string;
  updated_at: string;
}

interface ChatChunkRow {
  id: number;
  conversation_id: string;
  parent_index: number;
  doc_ref: string;
  parent_text: string;
  tokens: number;
  indexed_at: string;
}

// ─── deps ─────────────────────────────────────────────────────────────

interface HybridDeps {
  db: RetrievalDb;
  embedFn: EmbedFn | null;
  /** 是否启用聊天索引召回（默认 true；传 false 退回 V2 行为）。 */
  includeChat?: boolean;
}

// ─── RRF 融合 ─────────────────────────────────────────────────────────

function rrfFuse(
  hitsList: { hits: UnifiedHit[] }[],
  k: number,
): Map<string, { score: number; lanes: Set<RecallLane> }> {
  const scoreMap = new Map<string, { score: number; lanes: Set<RecallLane> }>();

  for (const { hits } of hitsList) {
    for (let rank = 0; rank < hits.length; rank++) {
      const hit = hits[rank]!;
      const key = hitKey(hit.space, hit.id);
      const entry = scoreMap.get(key) ?? { score: 0, lanes: new Set<RecallLane>() };
      entry.score += 1 / (k + rank + 1);
      entry.lanes.add(hit.lane);
      scoreMap.set(key, entry);
    }
  }

  return scoreMap;
}

// ─── 行 → RetrievedDoc ────────────────────────────────────────────────

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function chunkToDoc(row: ChunkRow, score: number, lanes: Set<RecallLane>): RetrievedDoc {
  return {
    chunk_id: String(row.id),
    doc_id: row.doc_id,
    doc_source: row.doc_source as DocSourceType,
    doc_path: row.doc_ref,
    parent_text: row.parent_text,
    tokens: row.tokens,
    score: Math.min(score, 1),
    lanes: [...lanes],
    rerank_rank: null,
    tags: parseTags(row.tags),
    updated_at: row.updated_at,
  };
}

/** djb2 短哈希：会话 id 过长时用于压缩 doc_id（保持 ≤ 64 字符）。 */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(8, "0").slice(0, 8);
}

/**
 * 聊天文档的 `doc_id`：窗口级唯一（`chat_<conv>_<parentIndex>`），≤ 64 字符。
 *
 * 必须是**窗口级**而非会话级——`expandToParents` 按 doc_id 去重，
 * 若用会话级会把同会话的不同时间窗口合并成一条。
 */
export function chatDocId(conversationId: string, parentIndex: number): string {
  const suffix = `_${parentIndex}`;
  const budget = 63 - "chat_".length - suffix.length;
  const base =
    conversationId.length > budget
      ? `${conversationId.slice(0, Math.max(1, budget - 9))}${shortHash(conversationId)}`
      : conversationId;
  return `chat_${base}${suffix}`;
}

function chatRowToDoc(row: ChatChunkRow, score: number, lanes: Set<RecallLane>): RetrievedDoc {
  return {
    chunk_id: `chat:${row.id}`,
    doc_id: chatDocId(row.conversation_id, row.parent_index),
    doc_source: "message",
    doc_path: row.doc_ref,
    parent_text: row.parent_text,
    tokens: row.tokens,
    score: Math.min(score, 1),
    lanes: [...lanes],
    rerank_rank: null,
    tags: [],
    updated_at: row.indexed_at,
  };
}

// ─── 主函数 ───────────────────────────────────────────────────────────

export async function hybridQuery(deps: HybridDeps, query: RetrieveQuery): Promise<RetrievedDoc[]> {
  const includeChat = deps.includeChat !== false;

  const fts5 = createFts5Retriever(deps.db);
  const vector = createVectorRetriever(deps.db, deps.embedFn);
  const chatFts = createChatFtsRetriever(deps.db);
  const chatVector = createChatVectorRetriever(deps.db, deps.embedFn);

  // 并行召回（profile 两路必跑；chat 两路由 filter_sources 控制）
  const wantChat = includeChat && (query.filter_sources.length === 0 || query.filter_sources.includes("message"));
  const [fts5Hits, vectorHits, chatFtsHits, chatVectorHits] = await Promise.all([
    fts5.search(query.text, query.recall_per_lane),
    vector.search(query.text, query.recall_per_lane),
    wantChat ? chatFts.search(query.text, query.recall_per_lane) : Promise.resolve([]),
    wantChat ? chatVector.search(query.text, query.recall_per_lane) : Promise.resolve([]),
  ]);

  const rrfK = 60;
  const scoreMap = rrfFuse(
    [
      { hits: fts5Hits.map((h) => ({ space: "profile" as const, id: h.chunkId, lane: h.lane })) },
      { hits: vectorHits.map((h) => ({ space: "profile" as const, id: h.chunkId, lane: h.lane })) },
      { hits: chatFtsHits.map((h) => ({ space: "chat" as const, id: h.chunkId, lane: h.lane })) },
      {
        hits: chatVectorHits.map((h) => ({
          space: "chat" as const,
          id: h.chunkId,
          lane: h.lane,
        })),
      },
    ],
    rrfK,
  );

  if (scoreMap.size === 0) return [];

  const kept = [...scoreMap.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, query.recall_per_lane * 2);

  const profileIds = kept
    .filter(([key]) => key.startsWith("p:"))
    .map(([key]) => Number(key.slice(2)));
  const chatIds = kept.filter(([key]) => key.startsWith("c:")).map(([key]) => Number(key.slice(2)));

  const results: RetrievedDoc[] = [];

  if (profileIds.length > 0) {
    const placeholders = profileIds.map(() => "?").join(",");
    const rows = deps.db
      .prepare(
        `SELECT id, doc_id, doc_source, doc_ref, parent_text, tokens, tags, updated_at
         FROM chunks WHERE id IN (${placeholders})`,
      )
      .all(...profileIds) as ChunkRow[];
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const id of profileIds) {
      const row = rowMap.get(id);
      const entry = scoreMap.get(hitKey("profile", id));
      if (row && entry) results.push(chunkToDoc(row, entry.score, entry.lanes));
    }
  }

  if (chatIds.length > 0) {
    const placeholders = chatIds.map(() => "?").join(",");
    const rows = deps.db
      .prepare(
        `SELECT id, conversation_id, parent_index, doc_ref, parent_text, tokens, indexed_at
         FROM chat_chunks WHERE id IN (${placeholders})`,
      )
      .all(...chatIds) as ChatChunkRow[];
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const id of chatIds) {
      const row = rowMap.get(id);
      const entry = scoreMap.get(hitKey("chat", id));
      if (row && entry) results.push(chatRowToDoc(row, entry.score, entry.lanes));
    }
  }

  // 来源过滤（拿到 doc_source 后）+ RRF 降序
  const filtered =
    query.filter_sources.length === 0
      ? results
      : results.filter((doc) => query.filter_sources.includes(doc.doc_source));

  return filtered.sort((a, b) => b.score - a.score);
}
