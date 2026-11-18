/**
 * `conversations` 仓库（DESIGN-13 §3.5 接口定稿，签名逐字）。
 * 会话是**可重建缓存**（DESIGN-11 §0-10）：真相源是 `chat_messages`，本表随落档同事务 UPSERT。
 * 成员族（`chat_members`）实现在 `members.ts`，由本文件组合暴露——`ConversationsRepo` 接口不变。
 * 纪律：只做 SQL 与行映射；业务判断（落档顺序 / 批次校验）在 `src/commit.ts`。
 */
import type { PersonDb } from "../db";
import type { ChatConversationRow, ConversationKind, ConversationUpsert } from "../types-chat";
import { createMembersRepo, type MembersRepo } from "./members";

export interface ConversationsRepo extends MembersRepo {
  get(conversationId: string): ChatConversationRow | null;
  list(q?: {
    kind?: ConversationKind;
    platform?: string;
    keyword?: string;
    limit?: number;
    offset?: number;
  }): ChatConversationRow[];
  listForPerson(personId: string, q?: { active_only?: boolean }): ChatConversationRow[];
  /** 落档事务内，DESIGN-11 §4.4 ①（title 覆盖；member_count / first / last 取并集）。 */
  upsertFromCommit(row: ConversationUpsert, now: string): void;
  /** `msg_count` / `first_msg_at` / `last_msg_at` 直接 COUNT/MIN/MAX，不做增量累加（§4.4 ⑤）。 */
  recomputeStats(conversationId: string, now: string): void;
  countByKind(): Record<ConversationKind, number>;
  /**
   * 按会话 ID 后缀修正微信会话类型：
   * `*@chatroom` = 群聊，其余（wxid_* / @openim / gh_* / 纯 id）= 直聊。
   *
   * 早期导入把不少 wxid 直聊标成了 group（member_count 也异常），而 UPSERT 不改 kind，
   * 导致错误长期保留。启动时跑一次即可自愈；未来 UPSERT 也会强制按后缀写 kind。
   */
  reclassifyBySuffix(now: string): { updated: number };
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

const CONV_UPSERT = `INSERT INTO chat_conversations
    (conversation_id, platform, kind, title, owner_person_id, member_count,
     first_msg_at, last_msg_at, msg_count, source_ref, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  ON CONFLICT(conversation_id) DO UPDATE SET
    title        = excluded.title,
    member_count = MAX(chat_conversations.member_count, excluded.member_count),
    first_msg_at = CASE WHEN chat_conversations.first_msg_at IS NULL THEN excluded.first_msg_at
                        WHEN excluded.first_msg_at IS NULL THEN chat_conversations.first_msg_at
                        ELSE MIN(chat_conversations.first_msg_at, excluded.first_msg_at) END,
    last_msg_at  = CASE WHEN chat_conversations.last_msg_at IS NULL THEN excluded.last_msg_at
                        WHEN excluded.last_msg_at IS NULL THEN chat_conversations.last_msg_at
                        ELSE MAX(chat_conversations.last_msg_at, excluded.last_msg_at) END,
    updated_at   = excluded.updated_at`;

export function createConversationsRepo(db: PersonDb): ConversationsRepo {
  const get = (conversationId: string): ChatConversationRow | null =>
    (db
      .prepare("SELECT * FROM chat_conversations WHERE conversation_id = ?")
      .get(conversationId) as ChatConversationRow | undefined) ?? null;

  const list = (q: {
    kind?: ConversationKind;
    platform?: string;
    keyword?: string;
    limit?: number;
    offset?: number;
  } = {}): ChatConversationRow[] => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(q.kind);
    }
    if (q.platform !== undefined) {
      conditions.push("platform = ?");
      params.push(q.platform);
    }
    if (q.keyword !== undefined) {
      conditions.push("title LIKE ?");
      params.push(`%${q.keyword}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return db
      .prepare(
        `SELECT * FROM chat_conversations ${where}
         ORDER BY last_msg_at DESC, conversation_id ASC${page}`,
      )
      .all(...params, ...pageParams) as ChatConversationRow[];
  };

  const listForPerson = (
    personId: string,
    q: { active_only?: boolean } = {},
  ): ChatConversationRow[] => {
    const active = q.active_only === true ? " AND m.is_active = 1" : "";
    return db
      .prepare(
        `SELECT c.* FROM chat_conversations c
           JOIN chat_members m ON m.conversation_id = c.conversation_id
          WHERE m.person_id = ?${active}
          ORDER BY c.last_msg_at DESC, c.conversation_id ASC`,
      )
      .all(personId) as ChatConversationRow[];
  };

  const upsertFromCommit = (row: ConversationUpsert, now: string): void => {
    // 微信的会话类型由 ID 后缀唯一决定；不要相信导出 txt 的「类型」字段
    // （历史数据里 wxid 直聊被写成群聊，UPSERT 又不改 kind，错误会一直保留）。
    const kind: ConversationKind =
      row.platform === "wechat"
        ? row.conversation_id.endsWith("@chatroom")
          ? "group"
          : "direct"
        : row.kind;
    db.prepare(CONV_UPSERT).run(
      row.conversation_id,
      row.platform,
      kind,
      row.title,
      row.owner_person_id ?? "me",
      row.member_count ?? 0,
      row.first_msg_at ?? null,
      row.last_msg_at ?? null,
      row.source_ref ?? "{}",
      now,
      now,
    );
  };

  const recomputeStats = (conversationId: string, now: string): void => {
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS msg_count, MIN(ts_ms) AS first_ms, MAX(ts_ms) AS last_ms
           FROM v_chat_messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as {
      msg_count: number;
      first_ms: number | null;
      last_ms: number | null;
    };
    db.prepare(
      `UPDATE chat_conversations SET msg_count = ?, first_msg_at = ?, last_msg_at = ?,
                                     updated_at = ?
       WHERE conversation_id = ?`,
    ).run(agg.msg_count, isoOrNull(agg.first_ms), isoOrNull(agg.last_ms), now, conversationId);
  };

  const countByKind = (): Record<ConversationKind, number> => {
    const rows = db
      .prepare("SELECT kind, COUNT(*) AS n FROM chat_conversations GROUP BY kind")
      .all() as { kind: ConversationKind; n: number }[];
    const result: Record<ConversationKind, number> = { direct: 0, group: 0 };
    for (const row of rows) result[row.kind] = row.n;
    return result;
  };

  const reclassifyBySuffix = (now: string): { updated: number } => {
    const result = db
      .prepare(
        `UPDATE chat_conversations
            SET kind = CASE WHEN conversation_id LIKE '%@chatroom' THEN 'group' ELSE 'direct' END,
                updated_at = ?
          WHERE platform = 'wechat'
            AND kind <> CASE WHEN conversation_id LIKE '%@chatroom' THEN 'group' ELSE 'direct' END`,
      )
      .run(now);
    return { updated: result.changes };
  };

  return {
    get,
    list,
    listForPerson,
    upsertFromCommit,
    recomputeStats,
    countByKind,
    reclassifyBySuffix,
    ...createMembersRepo(db),
  };
}
