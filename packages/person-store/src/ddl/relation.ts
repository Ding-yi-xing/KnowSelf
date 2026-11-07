/**
 * 关系层 DDL：relationships / chat_members。
 * 逐字抄录 DESIGN-10 §2.2；`relationships.produced_by` 为 DESIGN-12 §9.1 #6 加法式加列。
 */
export const RELATION_DDL: readonly string[] = [
  // 关系：三层 scope 建模「我 ×（群）×（他人）」（DESIGN-10 §3）
  `CREATE TABLE IF NOT EXISTS relationships (
    relation_id     TEXT    PRIMARY KEY,
    subject_id      TEXT    NOT NULL DEFAULT 'me',
    counterpart_id  TEXT    NOT NULL,
    scope_kind      TEXT    NOT NULL CHECK (scope_kind IN ('global','direct','group')),
    scope_id        TEXT    NOT NULL DEFAULT '',
    relation_type   TEXT    NOT NULL DEFAULT 'unknown'
                            CHECK (relation_type IN
                              ('family','friend','colleague','classmate','client','vendor',
                               'group_member','acquaintance','unknown')),
    direction       TEXT    NOT NULL DEFAULT 'bidirectional'
                            CHECK (direction IN ('bidirectional','outgoing','incoming')),
    closeness       REAL    NOT NULL DEFAULT 0.5 CHECK (closeness >= 0 AND closeness <= 1),
    sentiment       REAL    NOT NULL DEFAULT 0.0 CHECK (sentiment >= -1 AND sentiment <= 1),
    tags            TEXT    NOT NULL DEFAULT '[]',
    note            TEXT    NOT NULL DEFAULT '',
    evidence_ref    TEXT    NOT NULL DEFAULT '[]',
    source          TEXT    NOT NULL CHECK (source IN ('auto','manual','import')),
    manual_locked   INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0,1)),
    produced_by     TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    UNIQUE (subject_id, counterpart_id, scope_kind, scope_id),
    FOREIGN KEY (subject_id)     REFERENCES persons(person_id) ON DELETE CASCADE,
    FOREIGN KEY (counterpart_id) REFERENCES persons(person_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_rel_counterpart ON relationships(counterpart_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_scope      ON relationships(scope_kind, scope_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_type       ON relationships(relation_type)`,

  // 群成员：会话 × 人物（群聊的第三元）
  `CREATE TABLE IF NOT EXISTS chat_members (
    conversation_id TEXT    NOT NULL,
    person_id       TEXT    NOT NULL,
    group_alias     TEXT    NOT NULL DEFAULT '',
    role_in_group   TEXT    NOT NULL DEFAULT 'member'
                            CHECK (role_in_group IN ('owner','admin','member','unknown')),
    joined_at       TEXT,
    left_at         TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    first_msg_at    TEXT,
    last_msg_at     TEXT,
    msg_count       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    PRIMARY KEY (conversation_id, person_id),
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id)       REFERENCES persons(person_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_members_person ON chat_members(person_id, is_active)`,
];
