import Database from "better-sqlite3";
import type { Statement as BStatement } from "better-sqlite3";
import { DDL_STATEMENTS } from "./ddl";
import { DbCorruptError } from "./errors";

type DatabaseInstance = InstanceType<typeof Database>;

export interface ProfileDb {
  raw: DatabaseInstance;
  prepare: (sql: string) => BStatement;
  transaction<T>(fn: () => T): () => T;
}

const EXPECTED_SCHEMA_VERSION = "1";

/**
 * PRAGMA table_info 检测缺列 → ALTER TABLE ADD COLUMN。
 * 解决 CREATE TABLE IF NOT EXISTS 对新表生效、但已有表不补列的问题。
 */
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

function ensureSourcesStatusConstraint(raw: DatabaseInstance): void {
  const row = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sources'")
    .get() as { sql: string } | undefined;

  if (!row?.sql.includes("'ingested'") || row.sql.includes("'pending_review'")) {
    return;
  }

  raw.pragma("foreign_keys = OFF");
  try {
    raw.exec(`
      CREATE TABLE sources_new (
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
      );

      INSERT INTO sources_new
        (id, kind, original_name, mime_type, file_path, url, extracted_text, truncated,
         char_count, user_note, user_tags, status, metadata, created_at, last_ingested_at, last_error)
      SELECT
        id, kind, original_name, mime_type, file_path, url, extracted_text, truncated,
        char_count, user_note, user_tags,
        CASE status WHEN 'ingested' THEN 'pending_review' ELSE status END,
        metadata, created_at, last_ingested_at, last_error
      FROM sources;

      DROP TABLE sources;
      ALTER TABLE sources_new RENAME TO sources;
      CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
      CREATE INDEX IF NOT EXISTS idx_sources_created_at ON sources(created_at DESC);
    `);
  } finally {
    raw.pragma("foreign_keys = ON");
  }
}

/**
 * `ingestion_proposals.target_kind` 的合法取值（DESIGN-11 §7.2 #1，与 contracts
 * `ProposalTargetKindSchema` 同集合）。V3 授权允许「加枚举值」
 * （`docs/shared/current/当前锁定范围与禁止主动重构清单.md`）。
 */
const PROPOSAL_TARGET_KINDS = ["core", "card_section", "journal", "chat_message"] as const;

/** 生成 CHECK 里的取值列表；仅供本文件的迁移使用。 */
function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
}

/**
 * 把 `ingestion_proposals.target_kind` 的 CHECK 从 3 值放宽到 4 值（增加 `chat_message`）。
 *
 * 语义：**只放宽、不收窄**——列定义 / 默认值 / NOT NULL / 外键 / 列顺序一律照抄旧定义，
 * 不删行、不改行、不改其它列语义。
 *
 * 幂等：`sqlite_master.sql` 已含 `'chat_message'` 时直接返回（重复打开库不重建）。
 * 一致性：重建后校验 `COUNT(*)` 前后相等，且 `PRAGMA foreign_key_check` 为空，否则回滚并抛
 * `DbCorruptError`。索引从 `sqlite_master` 读出旧 DDL 后原样重放（不手抄索引名，防漏）。
 */
function ensureProposalTargetKindConstraint(raw: DatabaseInstance): void {
  const row = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ingestion_proposals'")
    .get() as { sql: string } | undefined;
  if (row === undefined) return; // 表尚未建立（DDL 已先执行，正常不会走到这里）
  if (row.sql.includes("'chat_message'")) return; // 幂等：已升级

  const indexSql = (
    raw
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'ingestion_proposals' AND sql IS NOT NULL
          ORDER BY name`,
      )
      .all() as { sql: string }[]
  ).map((item) => item.sql);
  const countOf = (): number =>
    (raw.prepare("SELECT COUNT(*) AS n FROM ingestion_proposals").get() as { n: number }).n;
  const before = countOf();

  raw.pragma("foreign_keys = OFF");
  let inTransaction = false;
  try {
    raw.exec("BEGIN");
    inTransaction = true;
    raw.exec(`
      CREATE TABLE ingestion_proposals_new (
        id                      TEXT    PRIMARY KEY,
        source_id               TEXT    NOT NULL,
        target_kind             TEXT    NOT NULL CHECK (target_kind IN (${sqlStringList(PROPOSAL_TARGET_KINDS)})),
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
      );

      INSERT INTO ingestion_proposals_new
        (id, source_id, target_kind, target_ref, proposed_body, reasoning, source_excerpts,
         produced_by_provider, status, user_edited_body, created_at, decided_at)
      SELECT
        id, source_id, target_kind, target_ref, proposed_body, reasoning, source_excerpts,
        produced_by_provider, status, user_edited_body, created_at, decided_at
      FROM ingestion_proposals;

      DROP TABLE ingestion_proposals;
      ALTER TABLE ingestion_proposals_new RENAME TO ingestion_proposals;
    `);
    for (const sql of indexSql) raw.exec(sql);

    const after = countOf();
    if (after !== before) {
      throw new DbCorruptError(
        `ingestion_proposals 迁移丢行：迁移前 ${before} 行，迁移后 ${after} 行`,
      );
    }
    const violations = raw.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (violations.length > 0) {
      throw new DbCorruptError(
        `ingestion_proposals 迁移后外键校验失败：${JSON.stringify(violations).slice(0, 500)}`,
      );
    }
    raw.exec("COMMIT");
    inTransaction = false;
  } catch (cause) {
    if (inTransaction) raw.exec("ROLLBACK");
    throw cause;
  } finally {
    raw.pragma("foreign_keys = ON");
  }
}

export function openProfileDb(dbPath: string): ProfileDb {
  const raw = new Database(dbPath);

  raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("foreign_keys = ON");

  for (const sql of DDL_STATEMENTS) {
    raw.exec(sql);
  }

  // 轻量迁移：补齐旧库缺少的列 / 放宽 CHECK 枚举（必须在 schema_version 校验之前）
  ensureColumns(raw, "sources", [{ name: "last_error", type: "TEXT" }]);
  ensureSourcesStatusConstraint(raw);
  try {
    ensureProposalTargetKindConstraint(raw);
  } catch (cause) {
    // 迁移失败已回滚；关闭句柄再抛，避免把半开连接泄漏给调用方
    raw.close();
    throw cause;
  }

  const row = raw.prepare("SELECT value FROM profile_meta WHERE key = ?").get("schema_version") as
    | { value: string }
    | undefined;

  if (!row) {
    raw
      .prepare("INSERT INTO profile_meta (key, value) VALUES (?, ?)")
      .run("schema_version", EXPECTED_SCHEMA_VERSION);
  } else if (row.value !== EXPECTED_SCHEMA_VERSION) {
    raw.close();
    throw new DbCorruptError(
      `schema_version 不匹配：期望 ${EXPECTED_SCHEMA_VERSION}，实际 ${row.value}`,
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
