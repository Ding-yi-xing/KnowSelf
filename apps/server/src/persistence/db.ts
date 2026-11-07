/**
 * db.ts — conversations.sqlite 打开 + DDL 初始化
 *
 * 只负责 better-sqlite3 打开与建表；不暴露查询方法。
 * DDL 来自 docs/shared/decisions/2026-05-27-data-schemas.md §2.3。
 */

import Database from "better-sqlite3";

function ensureColumns(
  db: Database.Database,
  table: string,
  columns: { name: string; type: string }[],
): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as { name: string }[]).map((c) => c.name),
  );
  for (const col of columns) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${col.name}\` ${col.type}`);
    }
  }
}

const CONVERSATIONS_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    message_count       INTEGER NOT NULL DEFAULT 0,
    last_provider_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
    content             TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    provider_id         TEXT,
    model               TEXT,
    turn_id             TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id);

CREATE TABLE IF NOT EXISTS messages_archive (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    role                TEXT NOT NULL,
    content             TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    provider_id         TEXT,
    model               TEXT,
    turn_id             TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_archive_conv
  ON messages_archive(conversation_id, created_at);
`;

export type ConversationsDb = Database.Database;

/**
 * 打开 conversations.sqlite，执行 DDL 并返回 Database 实例。
 * better-sqlite3 同步接口：语句用 exec 批量执行。
 */
export function openConversationsDb(dbPath: string): ConversationsDb {
  const db = new Database(dbPath);

  // 从 WAL → exec DDL → 回到 WAL（exec 会触发默认 journal mode，需显式设回）
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(CONVERSATIONS_DDL);

  // 轻量迁移：补齐旧库可能缺少的列（future-proof）
  ensureColumns(db, "conversations", []);
  ensureColumns(db, "messages", []);
  ensureColumns(db, "messages_archive", []);

  return db;
}
