/**
 * 时间线 / 派生层 DDL：events / person_facts / person_metrics。
 * 逐字抄录 DESIGN-10 §2.3；加列来自 DESIGN-12 §9.1 #3~#6、DESIGN-13 §14-C2、
 * DESIGN-14 §2.6 #1（`events.event_kind`，加法式，取值见 contracts `EventKindSchema`）。
 * 注：`idx_events_kind` 引用迁移列，放在 `ddl/migrations.ts` 的 `POST_MIGRATION_DDL`。
 */
export const DERIVED_DDL: readonly string[] = [
  // 关键事件时间线（FR-8.5）。source_ref 保证可回溯（D4）。
  `CREATE TABLE IF NOT EXISTS events (
    event_id        TEXT    PRIMARY KEY,
    subject_id      TEXT    NOT NULL DEFAULT 'me',
    person_id       TEXT,
    conversation_id TEXT,
    scope_kind      TEXT    NOT NULL DEFAULT 'me' CHECK (scope_kind IN ('me','direct','group')),
    event_kind      TEXT    NOT NULL DEFAULT 'other',
    title           TEXT    NOT NULL,
    summary         TEXT    NOT NULL DEFAULT '',
    event_date      TEXT    NOT NULL,
    occurred_at     TEXT,
    importance      INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    tags            TEXT    NOT NULL DEFAULT '[]',
    source_kind     TEXT    NOT NULL CHECK (source_kind IN ('message','proposal','manual')),
    source_ref      TEXT    NOT NULL DEFAULT '[]',
    confidence      REAL    NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    manual_locked   INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0,1)),
    produced_by     TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    FOREIGN KEY (subject_id)      REFERENCES persons(person_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id)       REFERENCES persons(person_id) ON DELETE SET NULL,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE SET NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_date   ON events(event_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_person ON events(person_id, event_date DESC)`,

  // 文本型派生结论（话题标签 / 偏好 / 情感趋势描述）；可整层重建（D3）
  `CREATE TABLE IF NOT EXISTS person_facts (
    fact_id         TEXT    PRIMARY KEY,
    person_id       TEXT    NOT NULL,
    scope_kind      TEXT    NOT NULL DEFAULT 'global' CHECK (scope_kind IN ('global','direct','group')),
    scope_id        TEXT    NOT NULL DEFAULT '',
    fact_kind       TEXT    NOT NULL
                            CHECK (fact_kind IN ('topic','preference','sentiment','relation_note','milestone','risk','other')),
    fact_key        TEXT    NOT NULL DEFAULT '',
    fact_value      TEXT    NOT NULL,
    confidence      REAL    NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    source_ref      TEXT    NOT NULL DEFAULT '[]',
    produced_by     TEXT    NOT NULL DEFAULT '',
    manual_locked   INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0,1)),
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    FOREIGN KEY (person_id) REFERENCES persons(person_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_facts_person ON person_facts(person_id, fact_kind)`,

  // 数值型指标缓存（FR-9.1）；可整层重建；标量进 metric_value，分布进 metric_value_json
  `CREATE TABLE IF NOT EXISTS person_metrics (
    metric_id           TEXT    PRIMARY KEY,
    person_id           TEXT    NOT NULL,
    scope_kind          TEXT    NOT NULL CHECK (scope_kind IN ('global','direct','group')),
    scope_id            TEXT    NOT NULL DEFAULT '',
    period              TEXT    NOT NULL DEFAULT 'all'
                                CHECK (period IN ('all','day','week','month','year')),
    period_key          TEXT    NOT NULL DEFAULT '',
    metric_key          TEXT    NOT NULL,
    metric_value        REAL,
    metric_value_json   TEXT,
    metric_unit         TEXT    NOT NULL DEFAULT 'count',
    computed_at         TEXT    NOT NULL,
    produced_by         TEXT    NOT NULL DEFAULT '',
    source_ref          TEXT    NOT NULL DEFAULT '[]',
    evidence_count      INTEGER NOT NULL DEFAULT 0,
    manual_locked       INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0,1)),
    UNIQUE (person_id, scope_kind, scope_id, period, period_key, metric_key),
    CHECK (metric_value IS NOT NULL OR metric_value_json IS NOT NULL),
    FOREIGN KEY (person_id) REFERENCES persons(person_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_metrics_person ON person_metrics(person_id, metric_key)`,
  `CREATE INDEX IF NOT EXISTS idx_metrics_scope  ON person_metrics(scope_kind, scope_id)`,
];
