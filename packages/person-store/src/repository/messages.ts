/**
 * `messages` 仓库（DESIGN-13 §3.6 接口定稿，签名逐字）。
 * append-only（D2）：本文件**只有 `INSERT OR IGNORE`**，无 UPDATE / DELETE；触发器兜底。
 * 唯一写入路径是 `src/commit.ts`（DESIGN-13 §4.3 不变量）——其他文件不得出现 `INSERT INTO chat_messages`。
 * 按 §2.2 行预算拆分：过滤构造 `message-filter.ts`、`stream` 见 `message-stream.ts`、
 * mentions 见 `mentions.ts`、`trace` 见 `trace.ts`；本文件组合暴露，接口不变。
 */
import type { PersonDb } from "../db";
import type { ChatMessageInsert, ChatMessageRow, ContentType } from "../types-chat";
import { buildFilter, escapeLike, type MessageFilterQuery } from "./message-filter";
import { createMessageStreamRepo, type MessageStreamRepo } from "./message-stream";
import { createMentionsRepo, type MentionsRepo } from "./mentions";
import { createTraceRepo, type TraceRepo } from "./trace";

export interface MessagesRepo extends MentionsRepo, TraceRepo, MessageStreamRepo {
  get(messageId: string): ChatMessageRow | null;
  count(q?: {
    conversation_id?: string;
    person_id?: string;
    from_ms?: number;
    to_ms?: number;
  }): number;
  insertOrIgnore(rows: readonly ChatMessageInsert[]): { inserted: number; ignored: number };
  list(q: {
    conversation_id?: string;
    person_id?: string;
    from_ms?: number;
    to_ms?: number;
    content_types?: readonly ContentType[];
    limit?: number;
    offset?: number;
  }): ChatMessageRow[];
  /** LIKE 检索（非 FTS；全文检索归 context-router 的 retrieval.sqlite）。 */
  searchContent(q: {
    keyword: string;
    conversation_id?: string;
    person_id?: string;
    from_ms?: number;
    to_ms?: number;
    limit?: number;
  }): ChatMessageRow[];
  listThread(messageId: string, maxDepth?: number): ChatMessageRow[];
  histogramByDate(q: {
    conversation_id?: string;
    person_id?: string;
    from_date?: string;
    to_date?: string;
  }): { msg_date: string; count: number }[];
}

const MESSAGE_INSERT = `INSERT OR IGNORE INTO chat_messages
    (message_id, conversation_id, platform, sender_id, sender_name, role, ts_ms, msg_date,
     content, content_type, reply_to, meta, batch_id, ingested_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function createMessagesRepo(db: PersonDb): MessagesRepo {
  const get = (messageId: string): ChatMessageRow | null =>
    (db.prepare("SELECT * FROM chat_messages WHERE message_id = ?").get(messageId) as
      | ChatMessageRow
      | undefined) ?? null;

  const count = (q: MessageFilterQuery = {}): number => {
    const f = buildFilter(q);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages m ${f.join} ${f.where}`)
      .get(...f.params) as { n: number };
    return row.n;
  };

  /** 幂等落档（L2）：主键冲突即跳过，返回实际写入 / 跳过行数。 */
  const insertOrIgnore = (
    rows: readonly ChatMessageInsert[],
  ): { inserted: number; ignored: number } => {
    const stmt = db.prepare(MESSAGE_INSERT);
    let inserted = 0;
    for (const row of rows) {
      inserted += stmt.run(
        row.message_id,
        row.conversation_id,
        row.platform,
        row.sender_id,
        row.sender_name ?? "",
        row.role,
        row.ts_ms,
        row.msg_date,
        row.content ?? "",
        row.content_type ?? "text",
        row.reply_to ?? null,
        row.meta ?? "{}",
        row.batch_id,
        row.ingested_at,
      ).changes;
    }
    return { inserted, ignored: rows.length - inserted };
  };

  const list = (q: Parameters<MessagesRepo["list"]>[0]): ChatMessageRow[] => {
    const f = buildFilter(q);
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return db
      .prepare(
        `SELECT m.* FROM chat_messages m ${f.join} ${f.where}
         ORDER BY m.ts_ms ASC, m.message_id ASC${page}`,
      )
      .all(...f.params, ...pageParams) as ChatMessageRow[];
  };

  const searchContent = (q: Parameters<MessagesRepo["searchContent"]>[0]): ChatMessageRow[] => {
    const f = buildFilter(q);
    const clause = f.where === "" ? "WHERE" : `${f.where} AND`;
    const limit = q.limit === undefined ? "" : " LIMIT ?";
    const limitParams = q.limit === undefined ? [] : [q.limit];
    return db
      .prepare(
        `SELECT m.* FROM chat_messages m ${f.join} ${clause} m.content LIKE ? ESCAPE '\\'
         ORDER BY m.ts_ms ASC, m.message_id ASC${limit}`,
      )
      .all(...f.params, `%${escapeLike(q.keyword)}%`, ...limitParams) as ChatMessageRow[];
  };

  /** `reply_to` 链（根 → 叶），最多 `maxDepth` 层；环 / 缺行自动截断。 */
  const listThread = (messageId: string, maxDepth = 20): ChatMessageRow[] => {
    const chain: ChatMessageRow[] = [];
    const seen = new Set<string>();
    let current = get(messageId);
    while (current && chain.length < maxDepth && !seen.has(current.message_id)) {
      seen.add(current.message_id);
      chain.push(current);
      current = current.reply_to === null ? null : get(current.reply_to);
    }
    return chain.reverse();
  };

  const histogramByDate = (
    q: Parameters<MessagesRepo["histogramByDate"]>[0],
  ): { msg_date: string; count: number }[] => {
    const f = buildFilter(q);
    const params = [...f.params];
    const extra: string[] = [];
    if (q.from_date !== undefined) {
      extra.push("m.msg_date >= ?");
      params.push(q.from_date);
    }
    if (q.to_date !== undefined) {
      extra.push("m.msg_date <= ?");
      params.push(q.to_date);
    }
    // 批 2b 下游适配：buildFilter 现在恒返回非空 where（含 REVERTED_BATCH_GUARD）。
    // 无额外日期条件时不能再拼 `... AND ` —— 会产生尾随 AND 的 SQL 语法错误。
    // 零回滚批次下 guard 恒 TRUE，本改动对 histogramByDate 的结果是 no-op（验收 6）。
    // f.where === "" 的分支保留，供未来构造器回归时继续正确。
    const where =
      extra.length === 0
        ? f.where
        : f.where === ""
          ? `WHERE ${extra.join(" AND ")}`
          : `${f.where} AND ${extra.join(" AND ")}`;
    return db
      .prepare(
        `SELECT m.msg_date AS msg_date, COUNT(*) AS count FROM chat_messages m ${f.join} ${where}
         GROUP BY m.msg_date ORDER BY m.msg_date ASC`,
      )
      .all(...params) as { msg_date: string; count: number }[];
  };

  return {
    get,
    count,
    insertOrIgnore,
    list,
    searchContent,
    listThread,
    histogramByDate,
    ...createMessageStreamRepo(db),
    ...createMentionsRepo(db),
    ...createTraceRepo(db),
  };
}
