/**
 * `ingest_cursors`（DESIGN-13 §3.7 的游标族；按 §2.2 行预算拆分）。
 * 语义（DESIGN-11 §5.1）：`last_ts_ms` = 该会话**已成功落档**消息的最大 `ts_ms`；
 * `last_message_id` = 同一毫秒上已落档的最大 `message_id`（同毫秒多消息不丢）。
 * 单调不回退（§5.3 L3）：`advanceCursor` 用 MAX 语义，回退输入**静默不生效**；
 * 回退只走 `restoreCursors`（DESIGN-13 §4.4 步骤 4，唯一允许路径）。
 */
import type { PersonDb } from "../db";

export interface CursorsRepo {
  readCursor(
    platform: string,
    conversationId: string,
  ): { last_ts_ms: number; last_message_id: string | null } | null;
  advanceCursor(q: {
    platform: string;
    conversation_id: string;
    last_ts_ms: number;
    last_message_id: string;
    now: string;
  }): void;
}

const CURSOR_ADVANCE = `INSERT INTO ingest_cursors
    (platform, conversation_id, last_ts_ms, last_message_id, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(platform, conversation_id) DO UPDATE SET
    last_ts_ms      = MAX(ingest_cursors.last_ts_ms, excluded.last_ts_ms),
    last_message_id = CASE WHEN excluded.last_ts_ms > ingest_cursors.last_ts_ms
                           THEN excluded.last_message_id
                           ELSE ingest_cursors.last_message_id END,
    updated_at      = excluded.updated_at`;

export function createCursorsRepo(db: PersonDb): CursorsRepo {
  const readCursor = (
    platform: string,
    conversationId: string,
  ): { last_ts_ms: number; last_message_id: string | null } | null =>
    (db
      .prepare(
        `SELECT last_ts_ms, last_message_id FROM ingest_cursors
          WHERE platform = ? AND conversation_id = ?`,
      )
      .get(platform, conversationId) as
      | { last_ts_ms: number; last_message_id: string | null }
      | undefined) ?? null;

  const advanceCursor = (q: Parameters<CursorsRepo["advanceCursor"]>[0]): void => {
    db.prepare(CURSOR_ADVANCE).run(
      q.platform,
      q.conversation_id,
      q.last_ts_ms,
      q.last_message_id,
      q.now,
    );
  };

  return { readCursor, advanceCursor };
}
