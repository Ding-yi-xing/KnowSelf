/**
 * 主体层 DDL：persons / aliases / person_merges。
 * 逐字抄录 docs/process/003-DESIGN-10-数据模型详细设计.md §2.1（不得改名、不得改语义）。
 */
export const SUBJECT_DDL: readonly string[] = [
  // 人物主体：一个人一行。「我」= person_id 'me'（保留值，初始化时 seed）
  `CREATE TABLE IF NOT EXISTS persons (
    person_id       TEXT    PRIMARY KEY,
    subject_kind    TEXT    NOT NULL CHECK (subject_kind IN ('self','contact')),
    display_name    TEXT    NOT NULL,
    remark          TEXT    NOT NULL DEFAULT '',
    sort_key        TEXT    NOT NULL DEFAULT '',
    avatar_ref      TEXT,
    status          TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','archived','merged')),
    merged_into     TEXT,
    first_msg_at    TEXT,
    last_msg_at     TEXT,
    msg_count       INTEGER NOT NULL DEFAULT 0,
    conv_count      INTEGER NOT NULL DEFAULT 0,
    profile_json    TEXT    NOT NULL DEFAULT '{}',
    manual_locked   INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0,1)),
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    FOREIGN KEY (merged_into) REFERENCES persons(person_id) ON DELETE SET NULL
  )`,

  // 「我」唯一：subject_kind='self' 至多一行（partial unique index）
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_persons_self
     ON persons(subject_kind) WHERE subject_kind = 'self'`,
  `CREATE INDEX IF NOT EXISTS idx_persons_kind ON persons(subject_kind, status)`,
  `CREATE INDEX IF NOT EXISTS idx_persons_last ON persons(last_msg_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(display_name)`,

  // 别名：一个人的多个昵称/备注/平台 ID（FR-8.3）
  `CREATE TABLE IF NOT EXISTS aliases (
    alias_id        TEXT    PRIMARY KEY,
    person_id       TEXT    NOT NULL,
    platform        TEXT    NOT NULL
                            CHECK (platform IN ('wechat','qq','telegram','discord','other')),
    alias_kind      TEXT    NOT NULL
                            CHECK (alias_kind IN ('platform_uid','nickname','remark','group_card','phone','email','other')),
    alias           TEXT    NOT NULL,
    normalized      TEXT    NOT NULL,
    is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    confidence      REAL    NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    source          TEXT    NOT NULL CHECK (source IN ('extractor','auto_merge','manual')),
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    UNIQUE (platform, alias_kind, alias, person_id),
    FOREIGN KEY (person_id) REFERENCES persons(person_id) ON DELETE CASCADE
  )`,

  // 一个平台 ID 只能属于一个人（保证 v_chat_messages 视图 1:1）
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_aliases_platform_uid
     ON aliases(platform, alias) WHERE alias_kind = 'platform_uid'`,
  `CREATE INDEX IF NOT EXISTS idx_aliases_person     ON aliases(person_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aliases_normalized ON aliases(normalized)`,
  `CREATE INDEX IF NOT EXISTS idx_aliases_lookup     ON aliases(platform, alias_kind, alias)`,

  // 归并审计：别名归并必须可撤销（FR-8.3「人工可校正」）
  `CREATE TABLE IF NOT EXISTS person_merges (
    merge_id        TEXT    PRIMARY KEY,
    from_person_id  TEXT    NOT NULL,
    into_person_id  TEXT    NOT NULL,
    reason          TEXT    NOT NULL DEFAULT '',
    evidence        TEXT    NOT NULL DEFAULT '[]',
    performed_by    TEXT    NOT NULL CHECK (performed_by IN ('auto','manual')),
    confidence      REAL    NOT NULL DEFAULT 1.0,
    merged_at       TEXT    NOT NULL,
    undone_at       TEXT,
    FOREIGN KEY (from_person_id) REFERENCES persons(person_id) ON DELETE CASCADE,
    FOREIGN KEY (into_person_id) REFERENCES persons(person_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_merges_from ON person_merges(from_person_id)`,
  `CREATE INDEX IF NOT EXISTS idx_merges_into ON person_merges(into_person_id)`,
];
