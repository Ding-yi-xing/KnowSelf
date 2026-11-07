/**
 * persons.sqlite 打开序列（DESIGN-13 §7.3，逐行照抄顺序）。
 * 本包是 persons.sqlite 的**唯一入口**：其他包禁止 `new Database(personsDbPath)`（DESIGN-10 §4.5）。
 */
import Database from "better-sqlite3-multiple-ciphers";
import { resolvePersonsKey, type PersonsKeySource } from "@knowself/config";
import { applyKey, verifyKey, type CipherDbRaw } from "./crypto/cipher";
import { DDL_STATEMENTS } from "./ddl.js";
import {
  COLUMN_MIGRATIONS,
  DEFAULT_TIMEZONE,
  EXPECTED_SCHEMA_VERSION,
  META_DEFAULTS,
  POST_MIGRATION_DDL,
  SELF_PERSON_ID,
} from "./ddl/migrations";
import { EncryptionModeMismatchError, SchemaVersionError } from "./errors";

export { DEFAULT_TIMEZONE, EXPECTED_SCHEMA_VERSION, SELF_PERSON_ID };

/** DESIGN-13 §7.1：本包实现 `sqlcipher`；`none` 仅供测试 / CI 显式开启。 */
export type EncryptionMode = "none" | "sqlcipher";

export interface PersonDbEncryption {
  mode?: EncryptionMode;
  keyPath?: string;
  env?: Record<string, string | undefined>;
}

export interface PersonDbOptions {
  dbPath: string;
  encryption?: PersonDbEncryption;
  /** 'me' 的显示名（DESIGN-13 §7.5：settings → 兜底 `'我'`，不读 profile.sqlite）。 */
  selfDisplayName?: string;
  /** 注入时间戳（ISO8601 带时区）；缺省取系统时间。 */
  now?: string;
}

export interface PersonDb {
  raw: CipherDbRaw;
  encryptionMode: EncryptionMode;
  prepare: CipherDbRaw["prepare"];
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

function keySource(encryption: PersonDbEncryption | undefined): PersonsKeySource {
  return {
    ...(encryption?.keyPath !== undefined ? { keyPath: encryption.keyPath } : {}),
    ...(encryption?.env !== undefined ? { env: encryption.env } : {}),
  };
}

function readMeta(raw: CipherDbRaw, key: string): string | undefined {
  const row = raw.prepare("SELECT value FROM persons_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMeta(raw: CipherDbRaw, key: string, value: string): void {
  raw
    .prepare(
      "INSERT INTO persons_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/** `persons_meta` 读（DESIGN-13 §0-3：该表由 db.ts 持读写原语，repository 只调用）。 */
export function getPersonMeta(db: PersonDb, key: string): string | undefined {
  return readMeta(db.raw, key);
}

/** `persons_meta` 写（同上；版本位 `produced_by.*` 由调用方给出）。 */
export function setPersonMeta(db: PersonDb, key: string, value: string): void {
  setMeta(db.raw, key, value);
}

function seedMetaIfMissing(raw: CipherDbRaw, key: string, value: string): void {
  raw.prepare("INSERT OR IGNORE INTO persons_meta (key, value) VALUES (?, ?)").run(key, value);
}

/** 老库补列：`CREATE TABLE IF NOT EXISTS` 不会给已有表加列（DESIGN-13 §7.3 步骤 8）。 */
function runMigrations(raw: CipherDbRaw): void {
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = raw.prepare(`PRAGMA table_info(\`${migration.table}\`)`).all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === migration.column)) {
      raw.exec(
        `ALTER TABLE \`${migration.table}\` ADD COLUMN \`${migration.column}\` ${migration.definition}`,
      );
    }
  }
}

function assertSchemaVersion(raw: CipherDbRaw): void {
  const current = readMeta(raw, "schema_version");
  if (current === undefined) {
    setMeta(raw, "schema_version", EXPECTED_SCHEMA_VERSION);
    return;
  }
  const actual = Number(current);
  if (!Number.isFinite(actual)) {
    throw new SchemaVersionError(`persons_meta.schema_version 非法：${current}`);
  }
  if (actual > Number(EXPECTED_SCHEMA_VERSION)) {
    throw new SchemaVersionError(
      `schema_version 高于代码预期：期望 ${EXPECTED_SCHEMA_VERSION}，实际 ${current}`,
    );
  }
  if (current !== EXPECTED_SCHEMA_VERSION) {
    setMeta(raw, "schema_version", EXPECTED_SCHEMA_VERSION);
  }
}

function assertEncryptionMode(raw: CipherDbRaw, mode: EncryptionMode): void {
  const stored = readMeta(raw, "encryption_mode");
  if (stored === undefined) {
    setMeta(raw, "encryption_mode", mode);
    return;
  }
  if (stored !== mode) {
    throw new EncryptionModeMismatchError(
      `persons.sqlite 的 encryption_mode=${stored}，与配置 ${mode} 不符`,
    );
  }
}

function applyPragmas(raw: CipherDbRaw, mode: EncryptionMode): void {
  raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("temp_store = MEMORY");
  if (mode === "sqlcipher") {
    raw.pragma("cipher_memory_security = ON");
  }
}

function seedSelf(raw: CipherDbRaw, displayName: string, now: string): void {
  raw
    .prepare(
      `INSERT OR IGNORE INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
     VALUES (?, 'self', ?, ?, ?)`,
    )
    .run(SELF_PERSON_ID, displayName, now, now);
}

/** 空库必须可用（DESIGN-13 §7.5）：seed 约定键，已有键一律不覆盖。 */
function seedMeta(raw: CipherDbRaw, mode: EncryptionMode, now: string): void {
  seedMetaIfMissing(raw, "created_at", now);
  seedMetaIfMissing(raw, "encryption_mode", mode);
  for (const [key, value] of META_DEFAULTS) {
    seedMetaIfMissing(raw, key, value);
  }
}

export function openPersonDb(opts: PersonDbOptions): PersonDb {
  const mode: EncryptionMode = opts.encryption?.mode ?? "sqlcipher";
  const key = mode === "sqlcipher" ? resolvePersonsKey(keySource(opts.encryption)) : undefined;
  const raw = new Database(opts.dbPath);

  try {
    if (key) {
      applyKey(raw, key);
      verifyKey(raw);
    }
    applyPragmas(raw, mode);
    for (const sql of DDL_STATEMENTS) {
      raw.exec(sql);
    }
    runMigrations(raw);
    for (const sql of POST_MIGRATION_DDL) {
      raw.exec(sql);
    }

    const now = opts.now ?? new Date().toISOString();
    assertSchemaVersion(raw);
    assertEncryptionMode(raw, mode);
    seedMeta(raw, mode, now);
    seedSelf(raw, opts.selfDisplayName ?? "我", now);
  } catch (error) {
    raw.close();
    throw error;
  }

  const txn = raw.transaction.bind(raw) as <T>(fn: () => T) => () => T;
  return {
    raw,
    encryptionMode: mode,
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): () => T {
      return txn(fn);
    },
    close: () => raw.close(),
  };
}
