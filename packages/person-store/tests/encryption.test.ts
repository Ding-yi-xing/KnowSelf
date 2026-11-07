import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EncryptionKeyInvalidError, EncryptionKeyMissingError } from "@knowself/config";
import { openPersonDb, type PersonDb } from "../src/db";
import { COLUMN_MIGRATIONS } from "../src/ddl/migrations";
import { EncryptionModeMismatchError, SchemaVersionError } from "../src/errors";
import {
  closeAll,
  columns,
  KEY,
  makeTempDir,
  MARKER,
  meta,
  openIn,
  rawBytes,
  removeTempDir,
  SQLITE_HEADER_HEX,
  WRONG_KEY,
} from "./helpers";

let dir: string;
let opened: PersonDb[];

beforeEach(() => {
  dir = makeTempDir();
  opened = [];
});

afterEach(() => {
  closeAll(opened);
  removeTempDir(dir);
});

describe("加密开关（DESIGN-13 §7）", () => {
  it("sqlcipher：加密往返可读、错误密钥被拒、明文不落盘", () => {
    const dbPath = join(dir, "encrypted.sqlite");
    const encrypted = openPersonDb({
      dbPath,
      encryption: { mode: "sqlcipher", env: { KNOWSELF_PERSONS_KEY: KEY } },
    });
    expect(encrypted.encryptionMode).toBe("sqlcipher");
    expect(meta(encrypted, "encryption_mode")).toBe("sqlcipher");
    encrypted.prepare("UPDATE persons SET display_name = ? WHERE person_id = 'me'").run(MARKER);
    encrypted.close();

    const bytes = rawBytes(dbPath);
    expect(bytes.subarray(0, 16).toString("hex")).not.toBe(SQLITE_HEADER_HEX);
    expect(bytes.includes(MARKER)).toBe(false);

    const reopened = openPersonDb({
      dbPath,
      encryption: { mode: "sqlcipher", env: { KNOWSELF_PERSONS_KEY: KEY } },
    });
    opened.push(reopened);
    const row = reopened
      .prepare("SELECT display_name FROM persons WHERE person_id = 'me'")
      .get() as {
      display_name: string;
    };
    expect(row.display_name).toBe(MARKER);

    expect(() =>
      openPersonDb({
        dbPath,
        encryption: { mode: "sqlcipher", env: { KNOWSELF_PERSONS_KEY: WRONG_KEY } },
      }),
    ).toThrow(EncryptionKeyInvalidError);
  });

  it("明文库可读到标记（对照：证明上面的泄漏断言有意义）", () => {
    const dbPath = join(dir, "leak-control.sqlite");
    const db = openIn(dir, opened, "leak-control.sqlite");
    db.prepare("UPDATE persons SET display_name = ? WHERE person_id = 'me'").run(MARKER);
    db.close();
    expect(rawBytes(dbPath).includes(MARKER)).toBe(true);
  });

  it("密钥载体缺失 → EncryptionKeyMissingError（server 拒绝启动）", () => {
    expect(() =>
      openPersonDb({
        dbPath: join(dir, "missing-key.sqlite"),
        encryption: { mode: "sqlcipher", keyPath: join(dir, "absent.key"), env: {} },
      }),
    ).toThrow(EncryptionKeyMissingError);
  });

  it("encryption_mode 与库不符 → EncryptionModeMismatchError", () => {
    const db = openIn(dir, opened, "mode-mismatch.sqlite");
    db.prepare("UPDATE persons_meta SET value = 'sqlcipher' WHERE key = 'encryption_mode'").run();
    db.close();
    expect(() => openIn(dir, opened, "mode-mismatch.sqlite")).toThrow(EncryptionModeMismatchError);
  });

  it("schema_version 高于代码预期 → SchemaVersionError", () => {
    const db = openIn(dir, opened, "future-schema.sqlite");
    db.prepare("UPDATE persons_meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => openIn(dir, opened, "future-schema.sqlite")).toThrow(SchemaVersionError);
  });

  it("老库补列：runMigrations 按 COLUMN_MIGRATIONS 补齐缺失列", () => {
    const dbPath = join(dir, "legacy.sqlite");
    const legacy = openIn(dir, opened, "legacy.sqlite");
    // 老库（DESIGN-14 之前）没有 idx_events_kind；先删索引才能模拟「缺列」
    legacy.raw.exec("DROP INDEX IF EXISTS idx_events_kind");
    for (const migration of COLUMN_MIGRATIONS) {
      legacy.raw.exec(`ALTER TABLE \`${migration.table}\` DROP COLUMN \`${migration.column}\``);
    }
    legacy.close();

    const migrated = openIn(dir, opened, "legacy.sqlite");
    for (const migration of COLUMN_MIGRATIONS) {
      expect(columns(migrated, migration.table)).toContain(migration.column);
    }
    expect(
      migrated.prepare("SELECT count(*) AS n FROM persons WHERE person_id = 'me'").get(),
    ).toEqual({ n: 1 });
    expect(existsSync(dbPath)).toBe(true);
  });
});
