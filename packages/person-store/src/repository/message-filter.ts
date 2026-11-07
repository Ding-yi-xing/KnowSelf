/**
 * 消息查询的公共过滤构造器（DESIGN-13 §2.2 行预算拆分：`messages.ts` / `message-stream.ts` 共用）。
 * 语义：`person_id` 过滤必须走 `v_chat_messages.sender_person_id`（`chat_messages.sender_id` 是平台 ID）。
 */
import type { ContentType } from "../types-chat";

export interface MessageFilter {
  join: string;
  where: string;
  params: (string | number)[];
}

export interface MessageFilterQuery {
  conversation_id?: string;
  person_id?: string;
  from_ms?: number;
  to_ms?: number;
  content_types?: readonly ContentType[];
}

/** `stream` 的分页大小（keyset 分页，避免一次载入 10 万条）。 */
export const STREAM_PAGE = 1000;

/** LIKE 通配符转义（`%` / `_` / `\`），配合 `ESCAPE '\'` 使用（DESIGN-13 §11.1）。 */
export function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function buildFilter(q: MessageFilterQuery): MessageFilter {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const join = q.person_id === undefined ? "" : "JOIN v_chat_messages v ON v.message_id = m.message_id";
  if (q.person_id !== undefined) {
    conditions.push("v.sender_person_id = ?");
    params.push(q.person_id);
  }
  if (q.conversation_id !== undefined) {
    conditions.push("m.conversation_id = ?");
    params.push(q.conversation_id);
  }
  if (q.from_ms !== undefined) {
    conditions.push("m.ts_ms >= ?");
    params.push(q.from_ms);
  }
  if (q.to_ms !== undefined) {
    conditions.push("m.ts_ms < ?");
    params.push(q.to_ms);
  }
  if (q.content_types !== undefined && q.content_types.length > 0) {
    conditions.push(`m.content_type IN (${marks(q.content_types.length)})`);
    params.push(...q.content_types);
  }
  return { join, where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}
