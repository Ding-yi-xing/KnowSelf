/**
 * `chat_members` 读写族（DESIGN-13 §3.3 的成员方法，签名逐字）。
 * 归属说明：DESIGN-13 §2.2 把成员方法放在 `relationships.ts`（`relationships` 表不在本工单范围）；
 * `chat_members` 是会话×人物的派生缓存，本工单先落此处，由 `conversations.ts` 组合暴露，接口不变。
 * 纪律：`msg_count` 经 `v_chat_messages.sender_person_id` 重算（DESIGN-13 §14-C8），
 *  **不抄** DESIGN-11 §4.4 ⑤ 那条带注释的 SQL（sender_id 是平台 ID，需经 aliases 解析）。
 */
import type { PersonDb } from "../db";
import type { ChatMemberRow, ChatMemberUpsert } from "../types-chat";

type MemberSqlRow = Omit<ChatMemberRow, "is_active"> & { is_active: number };

export interface MembersRepo {
  listMembers(conversationId: string): ChatMemberRow[];
  listGroupsOf(personId: string): ChatMemberRow[];
  upsertMember(row: ChatMemberUpsert, now: string): void;
  recomputeMemberStats(conversationId: string, now: string): void;
}

/** §4.4 ② 的 UPSERT；`last_msg_at` 用 CASE 而非裸 `MAX`——SQLite 的 `MAX(NULL, x)` 返回 NULL。 */
const MEMBER_UPSERT = `INSERT INTO chat_members
    (conversation_id, person_id, group_alias, role_in_group, joined_at, left_at,
     is_active, first_msg_at, last_msg_at, msg_count, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT(conversation_id, person_id) DO UPDATE SET
    group_alias = excluded.group_alias,
    last_msg_at = CASE WHEN chat_members.last_msg_at IS NULL THEN excluded.last_msg_at
                       WHEN excluded.last_msg_at IS NULL THEN chat_members.last_msg_at
                       ELSE MAX(chat_members.last_msg_at, excluded.last_msg_at) END,
    updated_at  = excluded.updated_at`;

function mapMember(row: MemberSqlRow): ChatMemberRow {
  return { ...row, is_active: row.is_active === 1 };
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function createMembersRepo(db: PersonDb): MembersRepo {
  const listMembers = (conversationId: string): ChatMemberRow[] =>
    (
      db
        .prepare("SELECT * FROM chat_members WHERE conversation_id = ? ORDER BY person_id ASC")
        .all(conversationId) as MemberSqlRow[]
    ).map(mapMember);

  const listGroupsOf = (personId: string): ChatMemberRow[] =>
    (
      db
        .prepare(
          `SELECT m.* FROM chat_members m
             JOIN chat_conversations c ON c.conversation_id = m.conversation_id
            WHERE m.person_id = ? AND c.kind = 'group'
            ORDER BY m.last_msg_at DESC, m.conversation_id ASC`,
        )
        .all(personId) as MemberSqlRow[]
    ).map(mapMember);

  const upsertMember = (row: ChatMemberUpsert, now: string): void => {
    db.prepare(MEMBER_UPSERT).run(
      row.conversation_id,
      row.person_id,
      row.group_alias ?? "",
      row.role_in_group ?? "member",
      row.joined_at ?? null,
      row.left_at ?? null,
      row.is_active === false ? 0 : 1,
      row.first_msg_at ?? null,
      row.last_msg_at ?? null,
      now,
      now,
    );
  };

  const recomputeMemberStats = (conversationId: string, now: string): void => {
    const agg = db
      .prepare(
        `SELECT sender_person_id AS person_id, COUNT(*) AS n,
                MIN(ts_ms) AS first_ms, MAX(ts_ms) AS last_ms
           FROM v_chat_messages
          WHERE conversation_id = ? AND sender_person_id IS NOT NULL
          GROUP BY sender_person_id`,
      )
      .all(conversationId) as {
      person_id: string;
      n: number;
      first_ms: number | null;
      last_ms: number | null;
    }[];
    const update = db.prepare(
      `UPDATE chat_members
          SET msg_count = ?, first_msg_at = COALESCE(first_msg_at, ?), last_msg_at = ?,
              updated_at = ?
        WHERE conversation_id = ? AND person_id = ?`,
    );
    for (const row of agg) {
      update.run(
        row.n,
        isoOrNull(row.first_ms),
        isoOrNull(row.last_ms),
        now,
        conversationId,
        row.person_id,
      );
    }
  };

  return { listMembers, listGroupsOf, upsertMember, recomputeMemberStats };
}
