/**
 * fts5.ts — FTS5 关键词检索
 *
 * 真实算法：@node-rs/jieba 分词 + FTS5 MATCH 查询。
 */

import { cut } from "@node-rs/jieba";
import type { RetrievalDb } from "../db";

// ─── 内部类型 ─────────────────────────────────────────────────────────

/** 召回路原始命中项（FTS5 路）。 */
export interface Fts5Hit {
  chunkId: number;
  score: number;
  lane: "fts5";
}

// ─── 召回器创建 ──────────────────────────────────────────────────────

export function createFts5Retriever(db: RetrievalDb): {
  search(query: string, recall: number): Promise<Fts5Hit[]>;
} {
  const stmt = db.prepare(
    "SELECT rowid, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
  );

  return {
    search(query: string, recall: number): Promise<Fts5Hit[]> {
      if (query.trim() === "") return Promise.resolve([]);
      if (recall <= 0) return Promise.resolve([]);

      const words = cut(query, true)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2);

      if (words.length === 0) return Promise.resolve([]);

      const matchStr = words.map((w) => `"${w}"`).join(" OR ");

      try {
        const rows = stmt.all(matchStr, recall) as {
          rowid: number;
          rank: number;
        }[];
        return Promise.resolve(
          rows.map((row) => ({
            chunkId: row.rowid,
            // FTS5 bm25() 返回 ∈ (-∞, 0]，越小（越负）表示匹配越好。
            // |rank|/(1+|rank|) 将越负映射为越高的 score，使排序语义一致。
            score: Math.abs(row.rank) / (1 + Math.abs(row.rank)),
            lane: "fts5" as const,
          })),
        );
      } catch {
        return Promise.resolve([]);
      }
    },
  };
}
