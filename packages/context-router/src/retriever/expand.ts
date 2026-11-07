/**
 * expand.ts — 子级→父级扩展 + 去重
 *
 * 同一 doc_id 的所有子级命中合并为一个结果（取最高分），
 * 返回的 RetrievedDoc 包含 parent_text（父级整段文本）。
 */

import type { RetrievedDoc } from "@knowself/contracts";
import type { RetrievalDb } from "../db";

// ─── deps ─────────────────────────────────────────────────────────────

interface ExpandDeps {
  db: RetrievalDb;
}

// ─── 主函数 ───────────────────────────────────────────────────────────

/**
 * 将子级命中扩展为父级文档并去重。
 * 同一 doc_id 只保留一条（取最高 score），
 * 每条结果的 parent_text 已经在 chunk 里存好了，
 * 如果缺失再从 DB 回查。
 */
export async function expandToParents(
  deps: ExpandDeps,
  hits: RetrievedDoc[],
): Promise<RetrievedDoc[]> {
  if (hits.length === 0) return [];

  // 按 doc_id 分组，保留每个 doc_id 的最高分命中
  const byDoc = new Map<string, RetrievedDoc>();

  for (const hit of hits) {
    const existing = byDoc.get(hit.doc_id);
    if (!existing || hit.score > existing.score) {
      byDoc.set(hit.doc_id, hit);
    }
  }

  // 收集需要回查 parent_text 的 doc_id（parent_text 为空时）
  const needLookup: string[] = [];
  for (const [docId, doc] of byDoc) {
    if (!doc.parent_text) {
      needLookup.push(docId);
    }
  }

  // 批量回查
  if (needLookup.length > 0) {
    const placeholders = needLookup.map(() => "?").join(",");
    const stmt = deps.db.prepare(
      `SELECT doc_id, doc_source, doc_ref, parent_text, tokens, tags, updated_at
       FROM chunks WHERE doc_id IN (${placeholders})
       GROUP BY doc_id`,
    );
    const rows = stmt.all(...needLookup) as {
      doc_id: string;
      doc_source: string;
      doc_ref: string;
      parent_text: string;
      tokens: number;
      tags: string;
      updated_at: string;
    }[];

    for (const row of rows) {
      const doc = byDoc.get(row.doc_id);
      if (doc) {
        doc.parent_text = row.parent_text;
        doc.tokens = row.tokens;
      }
    }
  }

  // 按 score 降序返回去重结果
  return [...byDoc.values()].sort((a, b) => b.score - a.score);
}
