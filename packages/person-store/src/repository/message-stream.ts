/**
 * `messages.stream`（DESIGN-13 §3.6；mining 的唯一读取入口，DESIGN-12 §3.1）。
 * 为什么单拆：§2.2 行预算纪律（`messages.ts` 超 200 行按「操作族」再拆，接口不变）。
 * 语义：走 `v_chat_messages`（自动排除已回滚批次）；keyset 分页 `(ts_ms, message_id)`，
 * 不做时间窗外的过滤判断——范围过滤（system / content_type）是 mining 的职责。
 */
import type { ScopeKind } from "@knowself/contracts";
import type { PersonDb } from "../db";
import type { MiningMessageRow } from "../types-chat";
import { marks, STREAM_PAGE } from "./message-filter";

export interface MessageStreamRepo {
  stream(q: {
    scope_kind: ScopeKind;
    scope_id?: string;
    from_ms?: number;
    to_ms?: number;
    conversation_ids?: readonly string[];
  }): AsyncIterable<MiningMessageRow>;
}

const SELECT_PAGE = `SELECT m.message_id, m.conversation_id, m.platform, m.role, m.sender_id,
         m.sender_person_id, m.ts_ms, m.msg_date, m.content, m.content_type,
         m.reply_to, m.meta
    FROM v_chat_messages m`;

export function createMessageStreamRepo(db: PersonDb): MessageStreamRepo {
  const stream = async function* (q: {
    scope_kind: ScopeKind;
    scope_id?: string;
    from_ms?: number;
    to_ms?: number;
    conversation_ids?: readonly string[];
  }): AsyncIterable<MiningMessageRow> {
    const base: string[] = [];
    const params: (string | number)[] = [];
    if (q.scope_kind !== "global" && q.scope_id !== undefined) {
      base.push("m.conversation_id = ?");
      params.push(q.scope_id);
    }
    if (q.conversation_ids !== undefined && q.conversation_ids.length > 0) {
      base.push(`m.conversation_id IN (${marks(q.conversation_ids.length)})`);
      params.push(...q.conversation_ids);
    }
    if (q.from_ms !== undefined) {
      base.push("m.ts_ms >= ?");
      params.push(q.from_ms);
    }
    if (q.to_ms !== undefined) {
      base.push("m.ts_ms < ?");
      params.push(q.to_ms);
    }
    let cursor: { ts: number; id: string } | null = null;
    for (;;) {
      const conditions = [...base];
      const pageParams = [...params];
      if (cursor !== null) {
        conditions.push("(m.ts_ms > ? OR (m.ts_ms = ? AND m.message_id > ?))");
        pageParams.push(cursor.ts, cursor.ts, cursor.id);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `${SELECT_PAGE} ${where} ORDER BY m.ts_ms ASC, m.message_id ASC LIMIT ?`,
        )
        .all(...pageParams, STREAM_PAGE) as MiningMessageRow[];
      if (rows.length === 0) return;
      for (const row of rows) yield row;
      const last = rows[rows.length - 1];
      if (last === undefined) return;
      cursor = { ts: last.ts_ms, id: last.message_id };
      if (rows.length < STREAM_PAGE) return;
    }
  };

  return { stream: stream as MessageStreamRepo["stream"] };
}
