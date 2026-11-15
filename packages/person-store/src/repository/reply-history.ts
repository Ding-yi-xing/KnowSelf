import type { PersonDb } from "../db";
import type { ContentType, MessageRole } from "../types-chat";

export interface ReplyConversationRow {
  conversation_id: string;
  contact_id: string;
  title: string;
  last_msg_ts_ms: number | null;
}

export interface ReplyHistoryMessage {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  sender_person_id: string | null;
  role: MessageRole;
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: ContentType;
}

export interface ReplyHistoryPage {
  rows: ReplyHistoryMessage[];
  next_cursor: { ts_ms: number; message_id: string } | null;
}

export interface ReplyHistoryRepo {
  /** 只返回与本人关联的直聊，不返回群聊或未归属会话。 */
  listDirectConversations(): ReplyConversationRow[];
  /** 强制 conversation_id + keyset 过滤；不支持 offset 全量读取。 */
  listMessages(input: {
    conversation_id: string;
    after?: { ts_ms: number; message_id: string };
    limit?: number;
  }): ReplyHistoryPage;
}

export function createReplyHistoryRepo(db: PersonDb): ReplyHistoryRepo {
  const listDirectConversations = (): ReplyConversationRow[] =>
    db
      .prepare(
        `SELECT c.conversation_id,
                MIN(m.person_id) AS contact_id,
                COALESCE(NULLIF(c.title, ''), MIN(p.display_name)) AS title,
                MAX(c.last_msg_at) AS last_msg_at
           FROM chat_conversations c
           JOIN chat_members self_member
             ON self_member.conversation_id = c.conversation_id
            AND self_member.is_active = 1
            AND self_member.person_id = 'me'
           JOIN chat_members m
             ON m.conversation_id = c.conversation_id
            AND m.is_active = 1
            AND m.person_id <> 'me'
           JOIN persons p
             ON p.person_id = m.person_id
            AND p.subject_kind = 'contact'
          WHERE c.kind = 'direct'
          GROUP BY c.conversation_id, c.title
         HAVING COUNT(DISTINCT m.person_id) = 1
          ORDER BY last_msg_at DESC, c.conversation_id ASC`,
      )
      .all()
      .map((row) => {
        const value = row as {
          conversation_id: string;
          contact_id: string;
          title: string;
          last_msg_at: string | null;
        };
        return {
          conversation_id: value.conversation_id,
          contact_id: value.contact_id,
          title: value.title,
          last_msg_ts_ms:
            value.last_msg_at === null || Number.isNaN(Date.parse(value.last_msg_at))
              ? null
              : Date.parse(value.last_msg_at),
        };
      });

  const listMessages = (input: {
    conversation_id: string;
    after?: { ts_ms: number; message_id: string };
    limit?: number;
  }): ReplyHistoryPage => {
    const limit = Math.max(1, Math.min(input.limit ?? 500, 2000));
    const after = input.after;
    const condition =
      after === undefined
        ? ""
        : " AND (m.ts_ms > ? OR (m.ts_ms = ? AND m.message_id > ?))";
    const params: (string | number)[] = [input.conversation_id];
    if (after !== undefined) params.push(after.ts_ms, after.ts_ms, after.message_id);
    params.push(limit + 1);
    const rows = db
      .prepare(
        `SELECT m.message_id, m.conversation_id, m.sender_id, m.sender_person_id,
                m.role, m.ts_ms, m.msg_date, m.content, m.content_type
           FROM v_chat_messages m
          WHERE m.conversation_id = ?
            AND m.conversation_id IN (
              SELECT c.conversation_id
                FROM chat_conversations c
                JOIN chat_members self_member
                  ON self_member.conversation_id = c.conversation_id
                 AND self_member.is_active = 1
                 AND self_member.person_id = 'me'
                JOIN chat_members contact_member
                  ON contact_member.conversation_id = c.conversation_id
                 AND contact_member.is_active = 1
                 AND contact_member.person_id <> 'me'
                JOIN persons contact_person
                  ON contact_person.person_id = contact_member.person_id
                 AND contact_person.subject_kind = 'contact'
               WHERE c.kind = 'direct'
               GROUP BY c.conversation_id
              HAVING COUNT(DISTINCT contact_member.person_id) = 1
            )
            AND m.role <> 'system'
            AND m.content IS NOT NULL
            AND m.content <> ''${condition}
          ORDER BY m.ts_ms ASC, m.message_id ASC
          LIMIT ?`,
      )
      .all(...params) as ReplyHistoryMessage[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      next_cursor: hasMore && last !== undefined
        ? { ts_ms: last.ts_ms, message_id: last.message_id }
        : null,
    };
  };

  return { listDirectConversations, listMessages };
}
