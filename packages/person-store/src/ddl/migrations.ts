/**
 * 加法式迁移清单 + persons_meta 约定键（DESIGN-13 §2.2 / §7.5 / §9.1）。
 * 迁移纪律：只允许 `ALTER TABLE ... ADD COLUMN`（带默认值），禁止改列名 / 改语义 / 删列。
 * 常量（`EXPECTED_SCHEMA_VERSION` / `DEFAULT_TIMEZONE` / `SELF_PERSON_ID`，附录 A）在此定义，
 * 由 `db.ts` re-export 给消费方。
 */

/**
 * `persons_meta.schema_version` 期望值。
 * 链路（DESIGN-17 §4.4）：`"1"`（D10）→ `"2"`（D11）→ `"3"`（D12）→ `"4"`（D13）→ **`"5"`**（D14 §2.6）。
 */
export const EXPECTED_SCHEMA_VERSION = "5";

/** 附录 A：`msg_date` / `event_date` 派生用默认时区。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** DESIGN-10 §2.1：「我」的保留 person_id。 */
export const SELF_PERSON_ID = "me";

export interface ColumnMigration {
  table: string;
  column: string;
  definition: string;
}

/**
 * 老库补列清单（新库由 DDL 直接建出同名列）。
 * 来源：DESIGN-12 §9.1 #3~#6、DESIGN-13 §14-C2、DESIGN-14 §2.6 #1、DESIGN-11 Q8。
 */
export const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  { table: "person_metrics", column: "source_ref", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "person_metrics", column: "evidence_count", definition: "INTEGER NOT NULL DEFAULT 0" },
  {
    table: "person_metrics",
    column: "manual_locked",
    definition: "INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0,1))",
  },
  { table: "relationships", column: "produced_by", definition: "TEXT NOT NULL DEFAULT ''" },
  { table: "events", column: "produced_by", definition: "TEXT NOT NULL DEFAULT ''" },
  { table: "events", column: "event_kind", definition: "TEXT NOT NULL DEFAULT 'other'" },
  { table: "ingest_batches", column: "skipped_count", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "ingest_batches", column: "cursor_snapshot_json", definition: "TEXT" },
];

/**
 * 依赖「迁移后才存在」的列的语句：**必须在 `runMigrations` 之后执行**（新库同样执行，幂等）。
 * 为什么单列：`idx_events_kind` 引用 `events.event_kind`——老库在 DDL 阶段该列尚不存在，
 * 直接放进 `DDL_STATEMENTS` 会 `no such column` 失败（DESIGN-14 §2.6 #4）。
 */
export const POST_MIGRATION_DDL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(event_kind, event_date DESC)`,
];

/** persons_meta 约定键的静态初值（DESIGN-10 §2.6 / DESIGN-13 §7.5 步骤 3）。 */
export const META_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ["timezone", DEFAULT_TIMEZONE],
  ["self_person_id", SELF_PERSON_ID],
  ["produced_by.persons_stats", "person-store:stats-v1"],
  ["produced_by.profile", "person-store:profile-v1"],
  ["produced_by.conv_stats", "person-store:conv-stats-v1"],
  ["produced_by.mentions", "person-store:mentions-v1"],
];
