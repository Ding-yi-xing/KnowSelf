/**
 * `ingest_batches` + 游标快照（DESIGN-13 §3.7 的批次族；按 §2.2 行预算拆分）。
 * 语义：一次全量/增量采集 = 一行；回滚只改状态，**不物理删消息**（D2）。
 * `cursor_snapshot_json` 是 DESIGN-11 Q8 的加法式加列，供 `revertBatch` 回退游标（§4.4 步骤 4）。
 */
import type { PersonDb } from "../db";
import { parseJsonColumn } from "../json";
import type { BatchRow, BatchStatus, CursorRow } from "../types-ingest";

export interface BatchesRepo {
  beginBatch(q: {
    batch_id: string;
    platform: string;
    extractor: string;
    tool_version: string;
    now: string;
  }): void;
  finishBatch(q: {
    batch_id: string;
    status: "succeeded" | "failed";
    conversation_count: number;
    message_count: number;
    skipped_count?: number;
    error_message?: string;
    now: string;
  }): void;
  getBatch(batchId: string): BatchRow | null;
  listBatches(q?: { status?: BatchStatus; limit?: number; offset?: number }): BatchRow[];
  markBatchReverted(q: { batch_id: string; now: string }): void;
  snapshotCursors(q: { batch_id: string; now: string }): { rows: number };
  restoreCursors(q: { batch_id: string; now: string }): { restored: number };
}

export function createBatchesRepo(db: PersonDb): BatchesRepo {
  const getBatch = (batchId: string): BatchRow | null =>
    (db.prepare("SELECT * FROM ingest_batches WHERE batch_id = ?").get(batchId) as
      | BatchRow
      | undefined) ?? null;

  const beginBatch = (q: Parameters<BatchesRepo["beginBatch"]>[0]): void => {
    db.prepare(
      `INSERT INTO ingest_batches (batch_id, platform, extractor, tool_version, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
    ).run(q.batch_id, q.platform, q.extractor, q.tool_version, q.now);
  };

  const finishBatch = (q: Parameters<BatchesRepo["finishBatch"]>[0]): void => {
    db.prepare(
      `UPDATE ingest_batches
          SET status = ?, finished_at = ?, conversation_count = ?, message_count = ?,
              skipped_count = ?, error_message = ?
        WHERE batch_id = ?`,
    ).run(
      q.status,
      q.now,
      q.conversation_count,
      q.message_count,
      q.skipped_count ?? 0,
      q.error_message ?? null,
      q.batch_id,
    );
  };

  const listBatches = (q: {
    status?: BatchStatus;
    limit?: number;
    offset?: number;
  } = {}): BatchRow[] => {
    const where = q.status === undefined ? "" : "WHERE status = ?";
    const params = q.status === undefined ? [] : [q.status];
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return db
      .prepare(`SELECT * FROM ingest_batches ${where} ORDER BY started_at DESC, batch_id ASC${page}`)
      .all(...params, ...pageParams) as BatchRow[];
  };

  const markBatchReverted = (q: { batch_id: string; now: string }): void => {
    db.prepare(
      "UPDATE ingest_batches SET status = 'reverted', reverted_at = ? WHERE batch_id = ?",
    ).run(q.now, q.batch_id);
  };

  const snapshotCursors = (q: { batch_id: string; now: string }): { rows: number } => {
    const rows = db
      .prepare("SELECT platform, conversation_id, last_ts_ms, last_message_id FROM ingest_cursors")
      .all() as CursorRow[];
    db.prepare("UPDATE ingest_batches SET cursor_snapshot_json = ? WHERE batch_id = ?").run(
      JSON.stringify(rows),
      q.batch_id,
    );
    return { rows: rows.length };
  };

  const restoreCursors = (q: { batch_id: string; now: string }): { restored: number } => {
    const snapshot = parseJsonColumn<CursorRow[]>(
      getBatch(q.batch_id)?.cursor_snapshot_json ?? null,
      [],
    );
    const stmt = db.prepare(
      `INSERT INTO ingest_cursors (platform, conversation_id, last_ts_ms, last_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(platform, conversation_id) DO UPDATE SET
         last_ts_ms = excluded.last_ts_ms, last_message_id = excluded.last_message_id,
         updated_at = excluded.updated_at`,
    );
    for (const row of snapshot) {
      stmt.run(row.platform, row.conversation_id, row.last_ts_ms, row.last_message_id, q.now);
    }
    return { restored: snapshot.length };
  };

  return {
    beginBatch,
    finishBatch,
    getBatch,
    listBatches,
    markBatchReverted,
    snapshotCursors,
    restoreCursors,
  };
}
