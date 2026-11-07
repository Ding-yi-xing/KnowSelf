/**
 * vector.ts — 句向量语义检索
 *
 * V2 算法（sqlite-vec）：vec_embeddings 虚拟表 ANN query → JOIN vec_chunk_map → top-k。
 * 降级：若 vec_embeddings 为空，回退到 embeddings 表全表余弦扫描。
 */

import type { RetrievalDb } from "../db";
import type { EmbedFn } from "../embedding";

interface EmbeddingRow {
  chunk_id: number;
  vector: Buffer;
}

interface Vec0Row {
  vec_rowid: number;
  distance: number;
}

export interface VectorHit {
  chunkId: number;
  score: number;
  lane: "vector";
}

function cosineSimilarity(qv: Float32Array, ev: Float32Array): number {
  const dim = qv.length;
  let s = 0;
  for (let i = 0; i < dim; i++) s += (qv[i] ?? 0) * (ev[i] ?? 0);
  return s;
}

export function createVectorRetriever(
  db: RetrievalDb,
  embedFn: EmbedFn | null,
): {
  search(query: string, recall: number): Promise<VectorHit[]>;
} {
  if (!embedFn) {
    return { search: () => Promise.resolve([]) };
  }

  const vecQuery = db.prepare(`
    SELECT v.rowid AS vec_rowid, v.distance
    FROM vec_embeddings v
    WHERE v.embedding MATCH ?
    ORDER BY v.distance
    LIMIT ?
  `);
  const mapQuery = db.prepare("SELECT chunk_id FROM vec_chunk_map WHERE vec_rowid = ?");
  const fullScanStmt = db.prepare("SELECT chunk_id, vector FROM embeddings");

  return {
    async search(query: string, recall: number): Promise<VectorHit[]> {
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
        // 首选 sqlite-vec ANN
        const jsonArray = JSON.stringify(Array.from(qv));
        const vecRows = vecQuery.all(jsonArray, recall) as Vec0Row[];

        if (vecRows.length > 0) {
          return vecRows.map((r) => {
            const row = mapQuery.get(r.vec_rowid) as { chunk_id: number } | undefined;
            return {
              chunkId: row?.chunk_id ?? r.vec_rowid,
              score: 1 - r.distance,
              lane: "vector" as const,
            };
          });
        }

        // 降级：全表余弦扫描
        const rows = fullScanStmt.all() as EmbeddingRow[];
        const hits: VectorHit[] = [];

        for (const row of rows) {
          const buf = row.vector;
          const ev = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          if (ev.length !== qv.length) continue;
          hits.push({
            chunkId: row.chunk_id,
            score: cosineSimilarity(qv, ev),
            lane: "vector",
          });
        }

        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, recall);
      } catch {
        return [];
      }
    },
  };
}
