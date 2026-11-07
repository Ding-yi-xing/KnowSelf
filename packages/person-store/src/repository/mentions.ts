/**
 * `chat_message_mentions` 读写族（DESIGN-13 §3.6 的 mentions 部分，签名逐字）。
 * 为什么单拆：§2.2 行预算纪律——`repository/messages.ts` 超 200 行时按「操作族」再拆；
 * `MessagesRepo` 仍原样暴露（由 `messages.ts` 组合）。
 * 语义：@ / 回复关系是**行为证据**（D3 可重建），person_id 已解析，不含平台原始 ID。
 */
import type { PersonDb } from "../db";
import type { MentionInsert, MentionRow } from "../types-chat";

export interface MentionsRepo {
  readMentions(q: {
    conversation_id?: string;
    person_id?: string;
    from_ms?: number;
    to_ms?: number;
  }): MentionRow[];
  upsertMentions(rows: readonly MentionInsert[]): { upserted: number };
  deleteMentionsByMessageIds(messageIds: readonly string[]): { deleted: number };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function createMentionsRepo(db: PersonDb): MentionsRepo {
  const readMentions = (q: {
    conversation_id?: string;
    person_id?: string;
    from_ms?: number;
    to_ms?: number;
  }): MentionRow[] => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.conversation_id !== undefined) {
      conditions.push("m.conversation_id = ?");
      params.push(q.conversation_id);
    }
    if (q.person_id !== undefined) {
      conditions.push("mm.person_id = ?");
      params.push(q.person_id);
    }
    if (q.from_ms !== undefined) {
      conditions.push("m.ts_ms >= ?");
      params.push(q.from_ms);
    }
    if (q.to_ms !== undefined) {
      conditions.push("m.ts_ms < ?");
      params.push(q.to_ms);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return db
      .prepare(
        `SELECT mm.* FROM chat_message_mentions mm
           JOIN chat_messages m ON m.message_id = mm.message_id
           ${where}
          ORDER BY m.ts_ms ASC, mm.message_id ASC`,
      )
      .all(...params) as MentionRow[];
  };

  const upsertMentions = (rows: readonly MentionInsert[]): { upserted: number } => {
    const stmt = db.prepare(
      `INSERT INTO chat_message_mentions (message_id, person_id, mention_kind, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id, person_id, mention_kind) DO NOTHING`,
    );
    let upserted = 0;
    for (const row of rows) {
      upserted += stmt.run(row.message_id, row.person_id, row.mention_kind ?? "at", row.created_at)
        .changes;
    }
    return { upserted };
  };

  const deleteMentionsByMessageIds = (messageIds: readonly string[]): { deleted: number } => {
    if (messageIds.length === 0) return { deleted: 0 };
    const result = db
      .prepare(
        `DELETE FROM chat_message_mentions WHERE message_id IN (${placeholders(messageIds.length)})`,
      )
      .run(...messageIds);
    return { deleted: result.changes };
  };

  return { readMentions, upsertMentions, deleteMentionsByMessageIds };
}
