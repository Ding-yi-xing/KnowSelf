/**
 * chat-vector.ts — 聊天索引的向量召回（窗口级）
 *
 * 向量只写在窗口代表行（窗口首条消息）上，见 chat-index.ts：
 *   chat_vec_embeddings（vec0, float[1024]）→ chat_vec_chunk_map → chat_chunks.id
 *
 * 降级：vec0 不可用或向量为空时回退到 chat_embeddings 全表余弦扫描。
 */

import type { RetrievalDb } from "../db";
import type { EmbedFn } from "../embedding";

interface ChatEmbeddingRow {
  chunk_id: number;
  vector: Buffer;
}

export interface ChatVectorHit {
  chunkId: number;
  score: number;
  lane: "vector";
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const dim = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < dim; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function createChatVectorRetriever(
  db: RetrievalDb,
  embedFn: EmbedFn | null,
): {
  search(query: string, recall: number): Promise<ChatVectorHit[]>;
} {
  if (!embedFn) {
    return { search: () => Promise.resolve([]) };
  }

  const vecQuery = db.prepare(
    `SELECT v.rowid AS vec_rowid, v.distance
     FROM chat_vec_embeddings v
     WHERE v.embedding MATCH ?
     ORDER BY v.distance
     LIMIT ?`,
  );
  const mapQuery = db.prepare("SELECT chunk_id FROM chat_vec_chunk_map WHERE vec_rowid = ?");
  const fullScanStmt = db.prepare("SELECT chunk_id, vector FROM chat_embeddings");

  return {
    async search(query: string, recall: number): Promise<ChatVectorHit[]> {
      if (query.trim() === "" || recall <= 0) return [];

      let qv: Float32Array;
      try {
        const result = await embedFn([query]);
        if (result.length === 0) return [];
        qv = result[0]!;
      } catch {
        return [];
      }

      try {
        const vecRows = vecQuery.all(JSON.stringify(Array.from(qv)), recall) as {
          vec_rowid: number;
          distance: number;
        }[];

        if (vecRows.length > 0) {
          const hits: ChatVectorHit[] = [];
          for (const r of vecRows) {
            const row = mapQuery.get(r.vec_rowid) as { chunk_id: number } | undefined;
            if (!row) continue;
            hits.push({ chunkId: row.chunk_id, score: 1 - r.distance, lane: "vector" });
          }
          return hits;
        }

        // 降级：全表余弦扫描
        const rows = fullScanStmt.all() as ChatEmbeddingRow[];
        const hits: ChatVectorHit[] = [];
        for (const row of rows) {
          const ev = new Float32Array(
            row.vector.buffer,
            row.vector.byteOffset,
            row.vector.byteLength / 4,
          );
          if (ev.length !== qv.length) continue;
          hits.push({ chunkId: row.chunk_id, score: cosineSimilarity(qv, ev), lane: "vector" });
        }
        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, recall);
      } catch {
        return [];
      }
    },
  };
}
