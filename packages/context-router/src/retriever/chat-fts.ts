/**
 * chat-fts.ts — 聊天索引的 FTS5 召回（消息级）
 *
 * 索引列是**预分词列** `seg_text`（jieba `cutForSearch` 空格连接，见 chat-index.ts）：
 * 直接用 unicode61 索引原始正文会把连续汉字切成单字 token，中文查询几乎必然漏召回。
 */

import { cutForSearch } from "@node-rs/jieba";
import type { RetrievalDb } from "../db";

export interface ChatFtsHit {
  chunkId: number;
  score: number;
  lane: "fts5";
}

export function createChatFtsRetriever(db: RetrievalDb): {
  search(query: string, recall: number): Promise<ChatFtsHit[]>;
} {
  const stmt = db.prepare(
    `SELECT rowid, bm25(chat_chunks_fts) AS rank
     FROM chat_chunks_fts
     WHERE chat_chunks_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
  );

  return {
    search(query: string, recall: number): Promise<ChatFtsHit[]> {
      if (query.trim() === "" || recall <= 0) return Promise.resolve([]);

      const words = cutForSearch(query)
        .map((w) => w.trim())
        .filter((w) => w.length >= 1);

      if (words.length === 0) return Promise.resolve([]);

      // 索引侧 seg_text 已用空格分隔（见 chat-index.ts）。unicode61 把「连续 CJK」当一个 token，
      // 因此未登录词（如人名「张三」被 jieba 切成 张/三）在查询侧也必须拆到字级才能命中；
      // 这里对每个词同时给出整词与单字两个候选，用 OR 连接——整词命中由 bm25 排序靠前，
      // 单字只作为兜底保证召回（随后由 RRF + rerank 收敛）。
      const terms = new Set<string>();
      for (const w of words) {
        terms.add(w);
        if (w.length >= 2) for (const ch of w) terms.add(ch);
      }

      const matchStr = [...terms].map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");

      try {
        const rows = stmt.all(matchStr, recall) as { rowid: number; rank: number }[];
        return Promise.resolve(
          rows.map((row) => ({
            chunkId: row.rowid,
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
