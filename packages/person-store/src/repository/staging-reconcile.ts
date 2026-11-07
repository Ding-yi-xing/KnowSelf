/**
 * staging 对账与清理（DESIGN-13 §3.7 的 `reconcile` / `pruneCommitted`；按 §2.2 行预算拆分）。
 * 崩溃恢复不变量（DESIGN-11 §8.2）：`chat_messages` 每一行必有对应 **committed** staging 行。
 * 已回滚批次（`reverted_at` 非空）不算不一致——消息按 D2 保留，读视图已过滤。
 */
import type { PersonDb } from "../db";
import type { ReconcileRow } from "../types-ingest";

export interface StagingReconcileRepo {
  reconcile(q?: { batch_id?: string; limit?: number }): ReconcileRow[];
  pruneCommitted(q: { before: string; limit?: number }): { deleted: number };
}

const MISSING_MESSAGE = `SELECT s.batch_id, s.conversation_id, s.message_id,
         'staging_committed_without_message' AS issue
    FROM chat_message_staging s
    LEFT JOIN chat_messages m ON m.message_id = s.message_id
   WHERE s.status = 'committed' AND m.message_id IS NULL`;

const MISSING_STAGING = `SELECT m.batch_id, m.conversation_id, m.message_id,
         'message_without_staging' AS issue
    FROM chat_messages m
    JOIN ingest_batches b ON b.batch_id = m.batch_id
    LEFT JOIN chat_message_staging s
      ON s.batch_id = m.batch_id AND s.conversation_id = m.conversation_id
     AND s.message_id = m.message_id AND s.status = 'committed'
   WHERE s.message_id IS NULL AND b.reverted_at IS NULL`;

export function createStagingReconcileRepo(db: PersonDb): StagingReconcileRepo {
  const reconcile = (q: { batch_id?: string; limit?: number } = {}): ReconcileRow[] => {
    const filterStaging = q.batch_id === undefined ? "" : " AND s.batch_id = ?";
    const filterMessages = q.batch_id === undefined ? "" : " AND m.batch_id = ?";
    const params = q.batch_id === undefined ? [] : [q.batch_id];
    return db
      .prepare(
        `SELECT * FROM (${MISSING_MESSAGE}${filterStaging}
         UNION ALL ${MISSING_STAGING}${filterMessages}) LIMIT ?`,
      )
      .all(...params, ...params, q.limit ?? 1000) as ReconcileRow[];
  };

  const pruneCommitted = (q: { before: string; limit?: number }): { deleted: number } => {
    const result = db
      .prepare(
        `DELETE FROM chat_message_staging
          WHERE message_id IN (
            SELECT message_id FROM chat_message_staging
             WHERE status = 'committed' AND committed_at IS NOT NULL AND committed_at < ?
             LIMIT ?
          )`,
      )
      .run(q.before, q.limit ?? 1000);
    return { deleted: result.changes };
  };

  return { reconcile, pruneCommitted };
}
