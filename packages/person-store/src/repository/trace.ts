/**
 * `trace`（D4 回溯入口，DESIGN-13 §8.2 / §3.6 末条）。
 * 为什么单拆：§2.2 行预算纪律明文举例「`repository/messages.ts` 的 `trace` 溢出则拆 `repository/trace.ts`」。
 * 语义：只读、幂等、**不写任何表**；走 `v_chat_messages`（自动排除已回滚批次）；
 *      `content_excerpt` 查询期截断 ≤200 字符，**不落库**。
 */
import type { PersonDb } from "../db";
import { TRACE_EXCERPT_CHARS } from "../constants";
import type { TraceRow } from "../types-chat";

export interface TraceRepo {
  trace(messageIds: readonly string[]): TraceRow[];
}

type TraceSqlRow = Omit<TraceRow, "content_excerpt"> & { content: string };

export function createTraceRepo(db: PersonDb): TraceRepo {
  const trace = (messageIds: readonly string[]): TraceRow[] => {
    if (messageIds.length === 0) return [];
    const marks = Array.from({ length: messageIds.length }, () => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT message_id, conversation_id, ts_ms, msg_date, sender_name, content_type, content
           FROM v_chat_messages
          WHERE message_id IN (${marks})
          ORDER BY ts_ms ASC, message_id ASC`,
      )
      .all(...messageIds) as TraceSqlRow[];
    return rows.map((row) => ({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      ts_ms: row.ts_ms,
      msg_date: row.msg_date,
      sender_name: row.sender_name,
      content_type: row.content_type,
      content_excerpt: row.content.slice(0, TRACE_EXCERPT_CHARS),
    }));
  };

  return { trace };
}
