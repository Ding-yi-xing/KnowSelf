/**
 * 采集层 DDL：ingest_batches / ingest_cursors（DESIGN-10 §2.5）
 * + chat_message_staging（DESIGN-11 §4.3）。
 * `ingest_batches.skipped_count` / `cursor_snapshot_json` 为 DESIGN-11 Q8 加法式加列。
 */
export const INGEST_DDL: readonly string[] = [
  // 采集批次：一次全量/增量采集 = 一行；回滚不物理删消息（D2）
  `CREATE TABLE IF NOT EXISTS ingest_batches (
    batch_id            TEXT    PRIMARY KEY,
    platform            TEXT    NOT NULL,
    extractor           TEXT    NOT NULL,
    tool_version        TEXT    NOT NULL DEFAULT '',
    started_at          TEXT    NOT NULL,
    finished_at         TEXT,
    status              TEXT    NOT NULL
                                CHECK (status IN ('running','succeeded','failed','reverted')),
    conversation_count  INTEGER NOT NULL DEFAULT 0,
    message_count       INTEGER NOT NULL DEFAULT 0,
    skipped_count       INTEGER NOT NULL DEFAULT 0,
    cursor_snapshot_json TEXT,
    error_message       TEXT,
    reverted_at         TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_batches_status ON ingest_batches(status, started_at DESC)`,

  // 增量采集游标（FR-7.4）：每会话一行
  `CREATE TABLE IF NOT EXISTS ingest_cursors (
    platform        TEXT    NOT NULL,
    conversation_id TEXT    NOT NULL,
    last_ts_ms      INTEGER NOT NULL DEFAULT 0,
    last_message_id TEXT,
    updated_at      TEXT    NOT NULL,
    PRIMARY KEY (platform, conversation_id)
  )`,

  // 聊天采集暂存层（DESIGN-11 新增）：载荷仓 + 断点续跑锚点 + 对账凭据，可整表丢弃（派生）
  `CREATE TABLE IF NOT EXISTS chat_message_staging (
    batch_id        TEXT    NOT NULL,
    conversation_id TEXT    NOT NULL,
    message_id      TEXT    NOT NULL,
    platform        TEXT    NOT NULL
                            CHECK (platform IN ('wechat','qq','telegram','discord','other')),
    sender_id       TEXT    NOT NULL,
    sender_name     TEXT    NOT NULL DEFAULT '',
    role            TEXT    NOT NULL CHECK (role IN ('me','other','system')),
    ts_ms           INTEGER NOT NULL,
    msg_date        TEXT    NOT NULL,
    content         TEXT    NOT NULL DEFAULT '',
    content_type    TEXT    NOT NULL DEFAULT 'text'
                            CHECK (content_type IN
                              ('text','image','file','link','voice','video','system','other')),
    reply_to        TEXT,
    meta            TEXT    NOT NULL DEFAULT '{}',
    tier            TEXT    NOT NULL DEFAULT 'review' CHECK (tier IN ('auto','review')),
    reason_codes    TEXT    NOT NULL DEFAULT '[]',
    status          TEXT    NOT NULL DEFAULT 'staged'
                            CHECK (status IN ('staged','committed','rejected')),
    proposal_id     TEXT,
    created_at      TEXT    NOT NULL,
    committed_at    TEXT,
    PRIMARY KEY (batch_id, conversation_id, message_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_staging_status ON chat_message_staging(status, batch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_staging_conv   ON chat_message_staging(conversation_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_staging_prop   ON chat_message_staging(proposal_id)`,
];
