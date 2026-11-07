/**
 * conversation.ts — conversations 表 CRUD
 *
 * 接口：createConversationStore(db) → ConversationStore
 *
 * 职责：
 *   - ensureConversation  — 不存在则建
 *   - appendMessage       — 事务内写历史
 *   - listConversations   — 分页列表
 *   - getConversation     — 单会话详情
 *   - renameConversation  — 改 title
 *   - deleteConversation  — 级联删 messages
 *   - archiveOverflow     — 超阈值消息移入 archive
 *
 * 消息的 content 列是 JSON 数组（ContentBlock[]）。
 */

import type Database from "better-sqlite3";
import type {
  ConversationId,
  ConversationRecord,
  ChatHistoryMessage,
  ListConversationsQuery,
  ListConversationsResponse,
  GetConversationResponse,
  ContentBlock,
} from "@knowself/contracts";

// ─── Internal types from SQLite rows ─────────────────────────────────

interface ConvRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_provider_id: string | null;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  provider_id: string | null;
  model: string | null;
  turn_id: string | null;
}

// ─── Row→contract helpers ────────────────────────────────────────────

function convRow(r: ConvRow): ConversationRecord {
  return {
    id: r.id,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
    message_count: r.message_count,
    last_provider_id: r.last_provider_id,
  };
}

function msgRow(r: MsgRow): ChatHistoryMessage {
  let content: ContentBlock[];
  try {
    content = JSON.parse(r.content) as ContentBlock[];
  } catch {
    content = [{ kind: "text", text: r.content } as ContentBlock];
  }

  return {
    id: r.id,
    conversation_id: r.conversation_id,
    role: r.role as ChatHistoryMessage["role"],
    content,
    created_at: r.created_at,
    provider_id: r.provider_id,
    model: r.model,
  };
}

// ─── Public type ─────────────────────────────────────────────────────

export type ConversationStore = ReturnType<typeof createConversationStore>;

// ─── Factory ─────────────────────────────────────────────────────────

export function createConversationStore(db: Database.Database) {
  const stmts = {
    convInsert: db.prepare(
      `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at, message_count, last_provider_id)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ),
    convGet: db.prepare("SELECT * FROM conversations WHERE id = ?"),
    convList: db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?"),
    convCount: db.prepare("SELECT COUNT(*) AS total FROM conversations"),
    convDelete: db.prepare("DELETE FROM conversations WHERE id = ?"),
    convRename: db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?"),
    convTouch: db.prepare(
      "UPDATE conversations SET updated_at = ?, message_count = message_count + 1, last_provider_id = COALESCE(?, last_provider_id) WHERE id = ?",
    ),
    msgInsert: db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, provider_id, model, turn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    msgList: db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at"),
  };

  const now = () => new Date().toISOString();

  return {
    // ── ensureConversation ────────────────────────────────────

    ensureConversation(id: ConversationId, hint?: { title?: string; provider_id?: string }): void {
      const n = now();
      stmts.convInsert.run(id, hint?.title ?? "新对话", n, n, hint?.provider_id ?? null);
    },

    // ── appendMessage ─────────────────────────────────────────

    appendMessage(msg: ChatHistoryMessage): void {
      db.transaction(() => {
        stmts.msgInsert.run(
          msg.id,
          msg.conversation_id,
          msg.role,
          JSON.stringify(msg.content),
          msg.created_at,
          msg.provider_id ?? null,
          msg.model ?? null,
          (msg as Record<string, unknown>).turn_id ?? null,
        );
        stmts.convTouch.run(msg.created_at, msg.provider_id ?? null, msg.conversation_id);
      })();
    },

    // ── listConversations ─────────────────────────────────────

    listConversations(q: ListConversationsQuery): ListConversationsResponse {
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const rows = stmts.convList.all(limit, offset) as ConvRow[];
      const countRow = stmts.convCount.get() as { total: number };
      return { items: rows.map(convRow), total: countRow.total };
    },

    // ── getConversation ───────────────────────────────────────

    getConversation(id: ConversationId): GetConversationResponse {
      const conv = stmts.convGet.get(id) as ConvRow | undefined;
      if (!conv) {
        const err = new Error("NOT_FOUND") as Error & { code: string };
        err.code = "NOT_FOUND";
        throw err;
      }
      const msgRows = stmts.msgList.all(id) as MsgRow[];
      return {
        conversation: convRow(conv),
        messages: msgRows.map(msgRow),
      };
    },

    // ── renameConversation ────────────────────────────────────

    renameConversation(id: ConversationId, title: string): ConversationRecord {
      const n = now();
      stmts.convRename.run(title, n, id);
      const updated = stmts.convGet.get(id) as ConvRow | undefined;
      if (!updated) {
        const err = new Error("NOT_FOUND") as Error & { code: string };
        err.code = "NOT_FOUND";
        throw err;
      }
      return convRow(updated);
    },

    // ── deleteConversation ────────────────────────────────────

    deleteConversation(id: ConversationId): void {
      const conv = stmts.convGet.get(id) as ConvRow | undefined;
      if (!conv) {
        const err = new Error("NOT_FOUND") as Error & { code: string };
        err.code = "NOT_FOUND";
        throw err;
      }
      stmts.convDelete.run(id);
    },

    // ── archiveOverflow ───────────────────────────────────────

    archiveOverflow(id: ConversationId, keep: number): void {
      const countRow = db
        .prepare("SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?")
        .get(id) as { cnt: number };
      if (countRow.cnt <= keep) return;

      const excess = countRow.cnt - keep;
      const rows = db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at LIMIT ?")
        .all(id, excess) as MsgRow[];

      const ins = db.prepare(
        `INSERT INTO messages_archive
         (id, conversation_id, role, content, created_at, provider_id, model, turn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const del = db.prepare("DELETE FROM messages WHERE id = ?");

      db.transaction(() => {
        for (const r of rows) {
          ins.run(
            r.id,
            r.conversation_id,
            r.role,
            r.content,
            r.created_at,
            r.provider_id,
            r.model,
            r.turn_id,
          );
          del.run(r.id);
        }
      })();
    },
  };
}
