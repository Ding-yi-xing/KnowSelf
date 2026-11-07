/**
 * DDL 语句数组，按 §1 表结构定义从 docs/shared/decisions/2026-05-27-data-schemas-v2-sqlite.md 抄录。
 * 每个元素是一条独立的 SQL 语句；执行顺序与数组顺序一致。
 */
export const DDL_STATEMENTS: string[] = [
  // L1：核心档案（永远 1 行）
  `CREATE TABLE IF NOT EXISTS core_profile (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    display_name    TEXT    NOT NULL,
    locale          TEXT    NOT NULL DEFAULT 'zh-CN',
    section_tags    TEXT    NOT NULL DEFAULT '[]',
    body            TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL,
    schema_version  INTEGER NOT NULL DEFAULT 1
  )`,

  // L2：卡片
  `CREATE TABLE IF NOT EXISTS cards (
    key             TEXT    PRIMARY KEY,
    title           TEXT    NOT NULL,
    summary         TEXT    NOT NULL,
    section_tags    TEXT    NOT NULL DEFAULT '[]',
    updated_at      TEXT    NOT NULL,
    schema_version  INTEGER NOT NULL DEFAULT 1
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cards_updated_at ON cards(updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS card_sections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    card_key        TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    ord             INTEGER NOT NULL,
    updated_at      TEXT    NOT NULL,
    UNIQUE (card_key, title),
    FOREIGN KEY (card_key) REFERENCES cards(key) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_card_sections_card_key ON card_sections(card_key, ord)`,

  // L3：日记 records
  `CREATE TABLE IF NOT EXISTS journal_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT    NOT NULL,
    ordinal         INTEGER NOT NULL,
    recorded_at     TEXT    NOT NULL,
    provenance      TEXT    NOT NULL CHECK (provenance IN ('user','assistant','import','migration')),
    tags            TEXT    NOT NULL DEFAULT '[]',
    body            TEXT    NOT NULL,
    UNIQUE (date, ordinal)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_records(date DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_journal_recorded_at ON journal_records(recorded_at DESC)`,

  // 附件库：用户提供的原始资料
  `CREATE TABLE IF NOT EXISTS sources (
    id                  TEXT    PRIMARY KEY,
    kind                TEXT    NOT NULL CHECK (kind IN ('file','url','paste')),
    original_name       TEXT    NOT NULL DEFAULT '',
    mime_type           TEXT    NOT NULL,
    file_path           TEXT,
    url                 TEXT,
    extracted_text      TEXT    NOT NULL,
    truncated           INTEGER NOT NULL DEFAULT 0,
    char_count          INTEGER NOT NULL,
    user_note           TEXT    NOT NULL DEFAULT '',
    user_tags           TEXT    NOT NULL DEFAULT '[]',
    status              TEXT    NOT NULL CHECK (status IN ('raw','distilling','pending_review','completed','rejected','distill_failed')),
    metadata            TEXT    NOT NULL DEFAULT '{}',
    created_at          TEXT    NOT NULL,
    last_ingested_at    TEXT,
    last_error          TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status)`,

  `CREATE INDEX IF NOT EXISTS idx_sources_created_at ON sources(created_at DESC)`,

  // Ingestion 建议（用户审阅前的暂存区）
  //
  // `target_kind` 含 `chat_message`（DESIGN-11 §7.2 #1，V3 授权「加枚举值」）：
  // 本文件 = **新库的正确终态**；存量旧库的 3 值 CHECK 由 `db.ts` 的
  // `ensureProposalTargetKindConstraint` 增量升级，两者必须保持同一取值集合。
  `CREATE TABLE IF NOT EXISTS ingestion_proposals (
    id                      TEXT    PRIMARY KEY,
    source_id               TEXT    NOT NULL,
    target_kind             TEXT    NOT NULL CHECK (target_kind IN ('core','card_section','journal','chat_message')),
    target_ref              TEXT    NOT NULL,
    proposed_body           TEXT    NOT NULL,
    reasoning               TEXT    NOT NULL DEFAULT '',
    source_excerpts         TEXT    NOT NULL DEFAULT '[]',
    produced_by_provider    TEXT    NOT NULL,
    status                  TEXT    NOT NULL CHECK (status IN ('pending','accepted','edited','rejected')),
    user_edited_body        TEXT,
    created_at              TEXT    NOT NULL,
    decided_at              TEXT,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_proposals_source ON ingestion_proposals(source_id)`,

  `CREATE INDEX IF NOT EXISTS idx_proposals_status ON ingestion_proposals(status)`,

  // 档案条目 ↔ 来源关联（多对多审计）
  `CREATE TABLE IF NOT EXISTS profile_sources (
    profile_kind            TEXT    NOT NULL CHECK (profile_kind IN ('core','card_section','journal_record')),
    profile_id              TEXT    NOT NULL,
    source_id               TEXT    NOT NULL,
    proposal_id             TEXT,
    created_at              TEXT    NOT NULL,
    PRIMARY KEY (profile_kind, profile_id, source_id),
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
    FOREIGN KEY (proposal_id) REFERENCES ingestion_proposals(id) ON DELETE SET NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_profile_sources_profile ON profile_sources(profile_kind, profile_id)`,

  `CREATE INDEX IF NOT EXISTS idx_profile_sources_source ON profile_sources(source_id)`,

  // 数据库元信息
  `CREATE TABLE IF NOT EXISTS profile_meta (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
  )`,

  // V2-05: 模板
  `CREATE TABLE IF NOT EXISTS templates (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    system_prompt_inject TEXT NOT NULL,
    variables           TEXT NOT NULL DEFAULT '[]',
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];
