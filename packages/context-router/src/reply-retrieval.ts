import { createHash } from "node:crypto";
import type { ReplyRetrievalDb } from "./db";

export interface ReplyConversationSource {
  conversation_id: string;
  contact_id: string;
  title: string;
  account_scope?: string;
}

export interface ReplySourceMessage {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  role: string;
  ts_ms: number;
  content: string;
  content_type: string;
}

export interface ReplyHistorySource {
  listMessages(input: {
    conversation_id: string;
    after?: { ts_ms: number; message_id: string };
    limit?: number;
  }): {
    rows: ReplySourceMessage[];
    next_cursor: { ts_ms: number; message_id: string } | null;
  };
}

export interface ReplyContextMessage extends ReplySourceMessage {
  indexed_at: string;
}

export interface ReplyRetrievalIndex {
  upsertConversation(input: ReplyConversationSource, now?: string): void;
  syncConversation(
    input: ReplyConversationSource,
    source: ReplyHistorySource,
    opts?: { batchSize?: number; maxMessages?: number; now?: () => string },
  ): number;
  rebuildConversation(input: ReplyConversationSource, source: ReplyHistorySource, opts?: { batchSize?: number; now?: () => string }): number;
  deleteConversation(conversationId: string): void;
  recent(conversationId: string, limit?: number): ReplyContextMessage[];
  search(conversationId: string, query: string, limit?: number): ReplyContextMessage[];
  state(conversationId: string): { state: string; last_ts_ms: number | null; last_message_id: string | null } | null;
}

const INDEX_VERSION = "reply-v1";
const DEFAULT_BATCH = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 20, 100));
}

function rowMessage(row: Record<string, unknown>): ReplyContextMessage {
  return {
    message_id: String(row.message_id),
    conversation_id: String(row.conversation_id),
    sender_id: String(row.sender_id),
    role: String(row.role),
    ts_ms: Number(row.ts_ms),
    content: String(row.content),
    content_type: String(row.content_type),
    indexed_at: String(row.indexed_at),
  };
}

export function createReplyRetrievalIndex(db: ReplyRetrievalDb): ReplyRetrievalIndex {
  const insertMessage = db.prepare(
    `INSERT INTO reply_messages
      (message_id, conversation_id, ts_ms, sender_id, role, content_type, content, content_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       ts_ms = excluded.ts_ms,
       sender_id = excluded.sender_id,
       role = excluded.role,
       content_type = excluded.content_type,
       content = excluded.content,
       content_hash = excluded.content_hash,
       indexed_at = excluded.indexed_at`,
  );
  const upsertCheckpoint = db.prepare(
    `INSERT INTO reply_index_checkpoints
      (conversation_id, last_ts_ms, last_message_id, index_version, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       last_ts_ms = excluded.last_ts_ms,
       last_message_id = excluded.last_message_id,
       index_version = excluded.index_version,
       state = excluded.state,
       updated_at = excluded.updated_at`,
  );

  function upsertConversation(input: ReplyConversationSource, now = nowIso()): void {
    db.prepare(
      `INSERT INTO reply_conversations
        (conversation_id, contact_id, account_scope, title, state, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         contact_id = excluded.contact_id,
         account_scope = excluded.account_scope,
         title = excluded.title,
         updated_at = excluded.updated_at`,
    ).run(input.conversation_id, input.contact_id, input.account_scope ?? "default", input.title, now);
  }

  function checkpoint(conversationId: string): { last_ts_ms: number | null; last_message_id: string | null } {
    const row = db.prepare(
      "SELECT last_ts_ms, last_message_id FROM reply_index_checkpoints WHERE conversation_id = ?",
    ).get(conversationId) as { last_ts_ms: number | null; last_message_id: string | null } | undefined;
    return row ?? { last_ts_ms: null, last_message_id: null };
  }

  function syncConversation(
    input: ReplyConversationSource,
    source: ReplyHistorySource,
    opts: { batchSize?: number; maxMessages?: number; now?: () => string } = {},
  ): number {
    const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH, 2000));
    const maxMessages = Math.max(1, Math.min(opts.maxMessages ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    const now = opts.now ?? nowIso;
    upsertConversation(input, now());
    let cursorValue = checkpoint(input.conversation_id);
    let total = 0;
    let fetched = 0;
    for (;;) {
      const after = cursorValue.last_ts_ms === null || cursorValue.last_message_id === null
        ? undefined
        : { ts_ms: cursorValue.last_ts_ms, message_id: cursorValue.last_message_id };
      const page = source.listMessages({
        conversation_id: input.conversation_id,
        ...(after === undefined ? {} : { after }),
        limit: Math.min(batchSize, maxMessages - fetched),
      });
      if (page.rows.length === 0) break;
      fetched += page.rows.length;
      const last = page.rows[page.rows.length - 1]!;
      db.transaction(() => {
        const indexedAt = now();
        for (const row of page.rows) {
          const content = row.content.trim();
          if (content === "") continue;
          insertMessage.run(
            row.message_id,
            input.conversation_id,
            row.ts_ms,
            row.sender_id,
            row.role,
            row.content_type,
            content,
            hashContent(content),
            indexedAt,
          );
          total += 1;
        }
        upsertCheckpoint.run(
          input.conversation_id,
          last.ts_ms,
          last.message_id,
          INDEX_VERSION,
          "ready",
          indexedAt,
        );
        db.prepare("UPDATE reply_conversations SET source_highwater_ts_ms = ?, source_highwater_message_id = ?, state = 'ready', updated_at = ? WHERE conversation_id = ?").run(last.ts_ms, last.message_id, indexedAt, input.conversation_id);
      })();
      cursorValue = { last_ts_ms: last.ts_ms, last_message_id: last.message_id };
      if (page.next_cursor === null || fetched >= maxMessages) break;
    }
    return total;
  }

  function deleteConversation(conversationId: string): void {
    db.transaction(() => {
      db.prepare("DELETE FROM reply_messages WHERE conversation_id = ?").run(conversationId);
      db.prepare("DELETE FROM reply_index_checkpoints WHERE conversation_id = ?").run(conversationId);
      db.prepare("DELETE FROM reply_conversations WHERE conversation_id = ?").run(conversationId);
    })();
  }

  function rebuildConversation(
    input: ReplyConversationSource,
    source: ReplyHistorySource,
    opts: { batchSize?: number; now?: () => string } = {},
  ): number {
    deleteConversation(input.conversation_id);
    return syncConversation(input, source, opts);
  }

  function recent(conversationId: string, limit?: number): ReplyContextMessage[] {
    return (db.prepare(
      `SELECT message_id, conversation_id, sender_id, role, ts_ms, content, content_type, indexed_at
         FROM reply_messages WHERE conversation_id = ? ORDER BY ts_ms DESC, message_id DESC LIMIT ?`,
    ).all(conversationId, normalizeLimit(limit)) as Record<string, unknown>[]).map(rowMessage).reverse();
  }

  function search(conversationId: string, query: string, limit?: number): ReplyContextMessage[] {
    const text = query.trim();
    if (text === "") return [];
    return (db.prepare(
      `SELECT m.message_id, m.conversation_id, m.sender_id, m.role, m.ts_ms,
              m.content, m.content_type, m.indexed_at
         FROM reply_messages_fts f
         JOIN reply_messages m ON m.rowid = f.rowid
        WHERE f.reply_messages_fts MATCH ? AND m.conversation_id = ?
        ORDER BY bm25(reply_messages_fts), m.ts_ms DESC, m.message_id DESC
        LIMIT ?`,
    ).all(text, conversationId, normalizeLimit(limit)) as Record<string, unknown>[]).map(rowMessage);
  }

  function state(conversationId: string): { state: string; last_ts_ms: number | null; last_message_id: string | null } | null {
    const row = db.prepare(
      `SELECT c.state, p.last_ts_ms, p.last_message_id
         FROM reply_conversations c
         LEFT JOIN reply_index_checkpoints p ON p.conversation_id = c.conversation_id
        WHERE c.conversation_id = ?`,
    ).get(conversationId) as { state: string; last_ts_ms: number | null; last_message_id: string | null } | undefined;
    return row ?? null;
  }

  return { upsertConversation, syncConversation, rebuildConversation, deleteConversation, recent, search, state };
}
