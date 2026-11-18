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
    idempotency_key     TEXT,
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
  // `target_kind` includes chat_message and source_distill. The latter is an
  // Inbox review request that triggers distillation instead of a profile write.
  // 本文件 = **新库的正确终态**；存量旧库的 3 值 CHECK 由 `db.ts` 的
  // `ensureProposalTargetKindConstraint` 增量升级，两者必须保持同一取值集合。
  `CREATE TABLE IF NOT EXISTS ingestion_proposals (
    id                      TEXT    PRIMARY KEY,
    source_id               TEXT    NOT NULL,
    target_kind             TEXT    NOT NULL CHECK (target_kind IN ('core','card_section','journal','chat_message','source_distill')),
    target_ref              TEXT    NOT NULL,
    proposed_body           TEXT    NOT NULL,
    reasoning               TEXT    NOT NULL DEFAULT '',
    source_excerpts         TEXT    NOT NULL DEFAULT '[]',
    produced_by_provider    TEXT    NOT NULL,
    status                  TEXT    NOT NULL CHECK (status IN ('pending','processing','accepted','edited','rejected')),
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

  // WeChat assistance state. The host adapter owns policy; SQLite owns the
  // restart-safe draft and audit trail so a Desktop restart cannot forget a
  // sent message or reset the rolling quota.
  `CREATE TABLE IF NOT EXISTS wechat_assist_drafts (
    id            TEXT PRIMARY KEY,
    contact_id    TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('draft','sent','discarded')),
    created_at    TEXT NOT NULL,
    sent_at       TEXT,
    external_id   TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_assist_drafts_status
    ON wechat_assist_drafts(status, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_assist_drafts_sent_at
    ON wechat_assist_drafts(sent_at)`,

  `CREATE TABLE IF NOT EXISTS wechat_assist_audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    action        TEXT NOT NULL CHECK (action IN (
      'draft_created','draft_discarded','send_rejected',
      'send_attempted','send_succeeded','send_failed',
      'reply_task_started','reply_task_stopped','reply_task_paused',
      'reply_context_shared'
    )),
    draft_id      TEXT NOT NULL,
    contact_id    TEXT NOT NULL,
    reason        TEXT,
    external_id   TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_assist_audit_draft
    ON wechat_assist_audit(draft_id, id)`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_assist_audit_at
    ON wechat_assist_audit(at DESC)`,

  // The send ledger is separate from drafts so an external send can be
  // reconciled after a timeout, process restart, or local write failure.
  `CREATE TABLE IF NOT EXISTS wechat_assist_send_ledger (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id           TEXT NOT NULL UNIQUE,
    idempotency_key    TEXT NOT NULL UNIQUE,
    contact_id         TEXT NOT NULL,
    body_hash          TEXT NOT NULL,
    target_fingerprint TEXT,
    status             TEXT NOT NULL CHECK (status IN ('processing','sent','failed','uncertain')),
    external_id        TEXT,
    lease_owner        TEXT,
    lease_until        TEXT,
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    started_at         TEXT NOT NULL,
    finished_at        TEXT,
    reconciled_at      TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_assist_send_ledger_status_lease
    ON wechat_assist_send_ledger(status, lease_until)`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_assist_send_ledger_contact
    ON wechat_assist_send_ledger(contact_id, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS wechat_reply_tasks (
    id                 TEXT PRIMARY KEY,
    account_scope      TEXT NOT NULL,
    conversation_id    TEXT NOT NULL,
    contact_id         TEXT NOT NULL,
    objective          TEXT NOT NULL,
    provider_id        TEXT NOT NULL,
    model_id           TEXT NOT NULL,
    history_authorized INTEGER NOT NULL DEFAULT 0 CHECK (history_authorized IN (0,1)),
    authorization_version INTEGER NOT NULL DEFAULT 1,
    status             TEXT NOT NULL CHECK (status IN ('starting','running','stopping','stopped','paused','failed')),
    stop_reason        TEXT,
    lease_owner        TEXT,
    lease_until        TEXT,
    turn_count         INTEGER NOT NULL DEFAULT 0,
    send_count         INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    stopped_at         TEXT
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_reply_tasks_active_account
    ON wechat_reply_tasks(account_scope)
    WHERE status IN ('starting','running','stopping')`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_reply_tasks_contact
    ON wechat_reply_tasks(contact_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS wechat_reply_turns (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id            TEXT NOT NULL,
    inbound_message_id TEXT,
    generated_body     TEXT,
    status             TEXT NOT NULL CHECK (status IN ('started','generated','sent','skipped','failed','uncertain')),
    reason             TEXT,
    created_at         TEXT NOT NULL,
    finished_at        TEXT,
    FOREIGN KEY (task_id) REFERENCES wechat_reply_tasks(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wechat_reply_turns_task
    ON wechat_reply_turns(task_id, id)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_reply_turns_inbound_once
    ON wechat_reply_turns(task_id, inbound_message_id)
    WHERE inbound_message_id IS NOT NULL`,

  // 微信协助：目标人物画像 + 用户口吻画像（每个任务一份，可重算覆盖）
  `CREATE TABLE IF NOT EXISTS wechat_reply_personas (
    task_id        TEXT PRIMARY KEY,
    payload_json   TEXT NOT NULL,
    generated_at   TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES wechat_reply_tasks(id) ON DELETE CASCADE
  )`,

  // 微信协助：回复任务的跨轮记忆（已确认事实 / 已问信息点 / 进行中的话题）。
  // 与 personas 分表：画像由模型总结生成，进度由 worker 按轮累积，生命周期与写入者都不同。
  `CREATE TABLE IF NOT EXISTS wechat_reply_task_progress (
    task_id          TEXT PRIMARY KEY,
    facts_json       TEXT NOT NULL DEFAULT '[]',
    asked_slots_json TEXT NOT NULL DEFAULT '[]',
    stage_goal       TEXT NOT NULL DEFAULT '',
    updated_at       TEXT NOT NULL,
    turn_count       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES wechat_reply_tasks(id) ON DELETE CASCADE
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

  // 身份状态时间线：从聊天里挖出「我亲口说过的身份/状态变化」。
  //
  // 真实事故：代理先回「我早不读了」，22 秒后又回「在家待着呗 翻翻招聘信息 投简历」，
  // 两句都是编的。静态画像只有「在读」这一句，盖不住「最近入职了/辞职了」这类时效变化。
  //
  // category 用来做覆盖：同一类（enrollment/work）里新状态失效旧的，不同类可以并存
  // （「在读」+「在找工作」是同时成立的）。
  `CREATE TABLE IF NOT EXISTS identity_states (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    category               TEXT NOT NULL CHECK (category IN ('enrollment','work','other')),
    text                   TEXT NOT NULL,
    source_quote           TEXT NOT NULL DEFAULT '',
    source_conversation_id TEXT NOT NULL DEFAULT '',
    valid_from             TEXT,
    invalid_at             TEXT,
    created_at             TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_identity_states_active
    ON identity_states(invalid_at, category, created_at DESC)`,
];
