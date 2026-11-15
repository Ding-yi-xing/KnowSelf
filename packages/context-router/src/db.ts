/**
 * db.ts — retrieval.sqlite 数据库打开与 DDL
 *
 * 基线 DDL 抄录自 docs/shared/decisions/2026-05-27-data-schemas-v2-sqlite.md §2 节。
 * V3 增量（DESIGN-10 §7.2 / §7.4，K-33~K-35）：
 *   - 新增 5 张 chat_* 表（chunks 系列旧表**一律不动**）
 *   - 向量维度 384 → 1024（Ollama `qwen3-embedding:0.6b`，SRS §2.4 A4 已授权）
 *   - index_meta.schema_version 2 → 3
 *
 * better-sqlite3 同步 API；WAL 模式 + foreign_keys ON。
 */

import Database from "better-sqlite3";
import type { Statement as BStatement } from "better-sqlite3";
import { load as sqliteVecLoad } from "sqlite-vec";
import { DbCorruptError } from "./errors";

type DatabaseInstance = InstanceType<typeof Database>;

/** 当前 embedding 维度：Ollama `qwen3-embedding:0.6b` = 1024（原 bge-small-zh = 384）。 */
export const EMBEDDING_DIM = 1024;

export interface RetrievalDb {
  raw: DatabaseInstance;
  prepare: (sql: string) => BStatement;
  transaction<T>(fn: () => T): () => T;
}

export interface ReplyDbStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface ReplyRetrievalDb {
  raw: {
    exec(sql: string): unknown;
    pragma(source: string): unknown;
    close(): void;
    transaction<T>(fn: () => T): () => T;
  };
  prepare(sql: string): ReplyDbStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

const REPLY_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS reply_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reply_conversations (
    conversation_id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    account_scope TEXT NOT NULL,
    title TEXT NOT NULL,
    source_highwater_ts_ms INTEGER,
    source_highwater_message_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','ready','degraded','failed')),
    failure_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_reply_conversations_contact ON reply_conversations(contact_id)",
  `CREATE TABLE IF NOT EXISTS reply_messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    sender_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES reply_conversations(conversation_id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_reply_messages_conv_ts ON reply_messages(conversation_id, ts_ms, message_id)",
  `CREATE VIRTUAL TABLE IF NOT EXISTS reply_messages_fts USING fts5(
    content,
    conversation_id UNINDEXED,
    message_id UNINDEXED,
    content='reply_messages',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER IF NOT EXISTS reply_messages_ai AFTER INSERT ON reply_messages BEGIN
    INSERT INTO reply_messages_fts(rowid, content, conversation_id, message_id)
    VALUES (new.rowid, new.content, new.conversation_id, new.message_id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS reply_messages_ad AFTER DELETE ON reply_messages BEGIN
    INSERT INTO reply_messages_fts(reply_messages_fts, rowid, content, conversation_id, message_id)
    VALUES ('delete', old.rowid, old.content, old.conversation_id, old.message_id);
  END`,
  `CREATE TABLE IF NOT EXISTS reply_index_checkpoints (
    conversation_id TEXT PRIMARY KEY,
    last_ts_ms INTEGER,
    last_message_id TEXT,
    index_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','ready','degraded','failed')),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES reply_conversations(conversation_id) ON DELETE CASCADE
  )`,
];

export function openReplyRetrievalDbFromHandle(handle: ReplyRetrievalDb): ReplyRetrievalDb {
  handle.raw.pragma("journal_mode = WAL");
  handle.raw.pragma("synchronous = NORMAL");
  handle.raw.pragma("foreign_keys = ON");
  for (const sql of REPLY_DDL) handle.raw.exec(sql);
  return handle;
}

function ensureColumns(
  raw: DatabaseInstance,
  table: string,
  columns: { name: string; type: string }[],
): void {
  const existing = new Set(
    (raw.prepare(`PRAGMA table_info(\`${table}\`)`).all() as { name: string }[]).map((c) => c.name),
  );
  for (const col of columns) {
    if (!existing.has(col.name)) {
      raw.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${col.name}\` ${col.type}`);
    }
  }
}

/** 读取 sqlite-vec 虚拟表的声明维度；表不存在返回 null。 */
function currentVecDim(raw: DatabaseInstance, table: string): number | null {
  const row = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string } | undefined;
  if (!row?.sql) return null;
  const m = /float\[(\d+)\]/.exec(row.sql);
  return m ? Number(m[1]) : null;
}

/** 删除并重建指定维度的 vec0 表。 */
function recreateVecTable(raw: DatabaseInstance, table: string, dim: number): void {
  raw.exec(`DROP TABLE IF EXISTS ${table}`);
  raw.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(embedding float[${dim}])`);
}

// ── 基线表（V2，保持原样） ──────────────────────────────────────────
const BASELINE_DDL: string[] = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS chunks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id          TEXT    NOT NULL,
    doc_source      TEXT    NOT NULL CHECK (doc_source IN ('core','card','card_section','journal_record')),
    doc_ref         TEXT    NOT NULL,
    parent_index    INTEGER NOT NULL,
    child_index     INTEGER NOT NULL,
    parent_text     TEXT    NOT NULL,
    child_text      TEXT    NOT NULL,
    tokens          INTEGER NOT NULL,
    tags            TEXT    NOT NULL DEFAULT '[]',
    updated_at      TEXT    NOT NULL,
    indexed_at      TEXT    NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_chunks_doc_ref ON chunks(doc_ref)",
  "CREATE INDEX IF NOT EXISTS idx_chunks_doc_source ON chunks(doc_source)",
  "CREATE INDEX IF NOT EXISTS idx_chunks_updated_at ON chunks(updated_at)",
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    child_text,
    content='chunks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, child_text) VALUES (new.id, new.child_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, child_text) VALUES ('delete', old.id, old.child_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, child_text) VALUES ('delete', old.id, old.child_text);
    INSERT INTO chunks_fts(rowid, child_text) VALUES (new.id, new.child_text);
  END`,
  `CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id    INTEGER PRIMARY KEY,
    model_id    TEXT    NOT NULL,
    dim         INTEGER NOT NULL,
    vector      BLOB    NOT NULL,
    indexed_at  TEXT    NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_id)",
  `CREATE TABLE IF NOT EXISTS vec_chunk_map (
    vec_rowid INTEGER PRIMARY KEY,
    chunk_id  INTEGER NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_vec_chunk_map_chunk ON vec_chunk_map(chunk_id)",
  `CREATE TABLE IF NOT EXISTS index_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

// ── V3 聊天索引（DESIGN-10 §7.2 逐字；只新增表） ──────────────────────
const CHAT_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS chat_chunks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_ref         TEXT    NOT NULL,
    conversation_id TEXT    NOT NULL,
    person_id       TEXT,
    parent_index    INTEGER NOT NULL,
    child_index     INTEGER NOT NULL,
    parent_text     TEXT    NOT NULL,
    child_text      TEXT    NOT NULL,
    seg_text        TEXT    NOT NULL DEFAULT '',
    ts_ms           INTEGER NOT NULL,
    msg_date        TEXT    NOT NULL,
    message_ids     TEXT    NOT NULL DEFAULT '[]',
    tokens          INTEGER NOT NULL,
    indexed_at      TEXT    NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_chat_chunks_doc_ref ON chat_chunks(doc_ref)",
  "CREATE INDEX IF NOT EXISTS idx_chat_chunks_conv ON chat_chunks(conversation_id, ts_ms)",
  "CREATE INDEX IF NOT EXISTS idx_chat_chunks_person ON chat_chunks(person_id, ts_ms)",
  "CREATE INDEX IF NOT EXISTS idx_chat_chunks_date ON chat_chunks(msg_date)",
  // 中文检索关键（DESIGN-10 §7.1 修订 2）：FTS 索引**预分词列** `seg_text`
  //（jieba `cutForSearch` 空格连接），而不是原始 child_text——unicode61 会把连续汉字
  // 切成单 token，搜「张三」0 命中。列名与 content 表沿用既有 chunks_fts 的模式。
  `CREATE VIRTUAL TABLE IF NOT EXISTS chat_chunks_fts USING fts5(
    seg_text,
    content='chat_chunks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER IF NOT EXISTS chat_chunks_ai AFTER INSERT ON chat_chunks BEGIN
    INSERT INTO chat_chunks_fts(rowid, seg_text) VALUES (new.id, new.seg_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chat_chunks_ad AFTER DELETE ON chat_chunks BEGIN
    INSERT INTO chat_chunks_fts(chat_chunks_fts, rowid, seg_text) VALUES ('delete', old.id, old.seg_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chat_chunks_au AFTER UPDATE ON chat_chunks BEGIN
    INSERT INTO chat_chunks_fts(chat_chunks_fts, rowid, seg_text) VALUES ('delete', old.id, old.seg_text);
    INSERT INTO chat_chunks_fts(rowid, seg_text) VALUES (new.id, new.seg_text);
  END`,
  `CREATE TABLE IF NOT EXISTS chat_embeddings (
    chunk_id    INTEGER PRIMARY KEY,
    model_id    TEXT    NOT NULL,
    dim         INTEGER NOT NULL,
    vector      BLOB    NOT NULL,
    indexed_at  TEXT    NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES chat_chunks(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_chat_embeddings_model ON chat_embeddings(model_id)",
  `CREATE TABLE IF NOT EXISTS chat_vec_chunk_map (
    vec_rowid INTEGER PRIMARY KEY,
    chunk_id  INTEGER NOT NULL UNIQUE REFERENCES chat_chunks(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_chat_vec_chunk_map_chunk ON chat_vec_chunk_map(chunk_id)",
];

const EXPECTED_SCHEMA_VERSION = "3";

export function openRetrievalDb(dbPath: string): RetrievalDb {
  const raw = new Database(dbPath);

  // 加载 sqlite-vec 扩展（vec0 虚拟表依赖）
  sqliteVecLoad(raw);

  // 1) 基线表（含 vec 表以外的全部）
  for (const sql of BASELINE_DDL) {
    raw.exec(sql);
  }

  // 2) 向量维度迁移：旧库可能是 float[384]（bge-small 时代）。
  //    vec0 不支持 ALTER，只能整表重建；索引是派生缓存，清空后由 reindex 重建。
  const baselineDim = currentVecDim(raw, "vec_embeddings");
  if (baselineDim === null) {
    raw.exec(`CREATE VIRTUAL TABLE vec_embeddings USING vec0(embedding float[${EMBEDDING_DIM}])`);
  } else if (baselineDim !== EMBEDDING_DIM) {
    recreateVecTable(raw, "vec_embeddings", EMBEDDING_DIM);
    // 旧维度向量已不可用：清掉映射与向量正文，等待重建（不删 chunks 正文）
    raw.exec("DELETE FROM vec_chunk_map");
    raw.exec("DELETE FROM embeddings");
  }

  // 3) V3 聊天索引表（chat 向量表同样按 EMBEDDING_DIM 建）
  for (const sql of CHAT_DDL) {
    raw.exec(sql);
  }
  const chatVecDim = currentVecDim(raw, "chat_vec_embeddings");
  if (chatVecDim === null) {
    raw.exec(
      `CREATE VIRTUAL TABLE chat_vec_embeddings USING vec0(embedding float[${EMBEDDING_DIM}])`,
    );
  } else if (chatVecDim !== EMBEDDING_DIM) {
    recreateVecTable(raw, "chat_vec_embeddings", EMBEDDING_DIM);
    raw.exec("DELETE FROM chat_vec_chunk_map");
    raw.exec("DELETE FROM chat_embeddings");
  }

  // 4) 轻量迁移：补齐旧库可能缺少的列（future-proof）
  ensureColumns(raw, "chunks", []);
  ensureColumns(raw, "embeddings", []);
  ensureColumns(raw, "vec_chunk_map", []);

  // 5) 版本校验 + 迁移
  const row = raw.prepare("SELECT value FROM index_meta WHERE key = ?").get("schema_version") as
    | { value: string }
    | undefined;

  if (!row) {
    raw
      .prepare("INSERT INTO index_meta (key, value) VALUES (?, ?)")
      .run("schema_version", EXPECTED_SCHEMA_VERSION);
  } else if (row.value === "1") {
    // V1 → V3：补齐 vec 映射表与全部 chat 表（上方幂等 DDL 已建好）
    raw
      .prepare("UPDATE index_meta SET value = ? WHERE key = ?")
      .run(EXPECTED_SCHEMA_VERSION, "schema_version");
  } else if (row.value === "2") {
    // V2 → V3：新增 chat_* 5 表 + FTS 源表（已在步骤 3 建好），仅推版本号
    raw
      .prepare("UPDATE index_meta SET value = ? WHERE key = ?")
      .run(EXPECTED_SCHEMA_VERSION, "schema_version");
  } else if (row.value !== EXPECTED_SCHEMA_VERSION) {
    raw.close();
    throw new DbCorruptError(
      `retrieval.sqlite schema_version 不匹配：期望 ${EXPECTED_SCHEMA_VERSION}，实际 ${row.value}`,
    );
  }

  const txn = raw.transaction.bind(raw) as <T>(fn: () => T) => () => T;
  return {
    raw,
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): () => T {
      return txn(fn);
    },
  };
}
