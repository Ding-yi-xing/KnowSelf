/**
 * 原文层 DDL：chat_conversations / chat_messages / chat_message_mentions + append-only 触发器
 * + v_chat_messages 视图 + persons_meta。逐字抄录 DESIGN-10 §2.4 / §2.6（表名不得简写）。
 */
export const RAW_DDL: readonly string[] = [
  // 聊天会话（单聊 / 群聊）
  `CREATE TABLE IF NOT EXISTS chat_conversations (
    conversation_id TEXT    PRIMARY KEY,
    platform        TEXT    NOT NULL
                            CHECK (platform IN ('wechat','qq','telegram','discord','other')),
    kind            TEXT    NOT NULL CHECK (kind IN ('direct','group')),
    title           TEXT    NOT NULL DEFAULT '',
    owner_person_id TEXT    NOT NULL DEFAULT 'me',
    member_count    INTEGER NOT NULL DEFAULT 0,
    first_msg_at    TEXT,
    last_msg_at     TEXT,
    msg_count       INTEGER NOT NULL DEFAULT 0,
    source_ref      TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    FOREIGN KEY (owner_person_id) REFERENCES persons(person_id) ON DELETE RESTRICT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_conv_kind ON chat_conversations(kind, last_msg_at DESC)`,

  // 消息原始层：append-only（D2）。禁止 UPDATE / DELETE（见下方触发器）
  `CREATE TABLE IF NOT EXISTS chat_messages (
    message_id      TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL,
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
    batch_id        TEXT    NOT NULL,
    ingested_at     TEXT    NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_msg_conv   ON chat_messages(conversation_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_msg_sender ON chat_messages(sender_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_msg_date   ON chat_messages(msg_date)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_msg_reply  ON chat_messages(reply_to) WHERE reply_to IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_chat_msg_batch  ON chat_messages(batch_id)`,

  // append-only 强制（D2）。触发器只做 RAISE(ABORT)，不写任何表。
  `CREATE TRIGGER IF NOT EXISTS trg_chat_msg_no_update
  BEFORE UPDATE ON chat_messages
  BEGIN
      SELECT RAISE(ABORT, 'chat_messages 是 append-only：禁止 UPDATE');
  END`,
  `CREATE TRIGGER IF NOT EXISTS trg_chat_msg_no_delete
  BEFORE DELETE ON chat_messages
  BEGIN
      SELECT RAISE(ABORT, 'chat_messages 是 append-only：禁止 DELETE');
  END`,

  // @ / 回复关系（群聊三元关系的行为证据；派生可重建 D3）
  `CREATE TABLE IF NOT EXISTS chat_message_mentions (
    message_id      TEXT    NOT NULL,
    person_id       TEXT    NOT NULL,
    mention_kind    TEXT    NOT NULL DEFAULT 'at'
                            CHECK (mention_kind IN ('at','reply','at_all')),
    created_at      TEXT    NOT NULL,
    PRIMARY KEY (message_id, person_id, mention_kind),
    FOREIGN KEY (message_id) REFERENCES chat_messages(message_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id)  REFERENCES persons(person_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_mentions_person ON chat_message_mentions(person_id)`,

  // 读视图：把「平台原始 sender_id」解析为 person_id，并过滤已回滚批次（只读）
  `CREATE VIEW IF NOT EXISTS v_chat_messages AS
  SELECT
      m.message_id, m.conversation_id, m.platform,
      m.sender_id, m.sender_name, m.role, m.ts_ms, m.msg_date,
      m.content, m.content_type, m.reply_to, m.meta, m.ingested_at,
      a.person_id AS sender_person_id,
      c.kind      AS conversation_kind,
      c.title     AS conversation_title
  FROM chat_messages m
  JOIN chat_conversations c ON c.conversation_id = m.conversation_id
  LEFT JOIN ingest_batches b ON b.batch_id = m.batch_id
  LEFT JOIN aliases a ON a.platform = m.platform
                     AND a.alias_kind = 'platform_uid'
                     AND a.alias = m.sender_id
  WHERE b.reverted_at IS NULL`,

  // 库元信息（约定 keys 见 DESIGN-10 §2.6 / DESIGN-13 §7.5，不得自创）
  `CREATE TABLE IF NOT EXISTS persons_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];
