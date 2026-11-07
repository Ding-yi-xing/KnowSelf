import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { DDL_STATEMENTS } from "../src/ddl";
import { openProfileDb, type ProfileDb } from "../src/db";
import { DbCorruptError } from "../src/errors";

describe("DDL", () => {
  it("is idempotent when run twice", () => {
    const db = new Database(":memory:");
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("core_profile");
    expect(names).toContain("cards");
    expect(names).toContain("card_sections");
    expect(names).toContain("journal_records");
    expect(names).toContain("sources");
    expect(names).toContain("ingestion_proposals");
    expect(names).toContain("profile_sources");
    expect(names).toContain("profile_meta");
    db.close();
  });

  it("enforces core_profile single-row constraint", () => {
    const db = new Database(":memory:");
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    db.prepare(
      "INSERT INTO core_profile (id, display_name, locale, body, updated_at) VALUES (1, 't', 'zh-CN', '', '2026-01-01T00:00:00.000Z')",
    ).run();
    expect(() => {
      db.prepare(
        "INSERT INTO core_profile (id, display_name, locale, body, updated_at) VALUES (2, 't2', 'zh-CN', '', '2026-01-01T00:00:00.000Z')",
      ).run();
    }).toThrow();
    db.close();
  });

  it("enforces journal_records unique date+ordinal", () => {
    const db = new Database(":memory:");
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    db.prepare(
      "INSERT INTO journal_records (date, ordinal, recorded_at, provenance, body) VALUES ('2026-05-27', 1, '2026-05-27T00:00:00.000Z', 'user', 'a')",
    ).run();
    expect(() => {
      db.prepare(
        "INSERT INTO journal_records (date, ordinal, recorded_at, provenance, body) VALUES ('2026-05-27', 1, '2026-05-27T00:00:00.000Z', 'user', 'b')",
      ).run();
    }).toThrow();
    db.close();
  });
});

describe("openProfileDb", () => {
  let db: ProfileDb;

  afterEach(() => {
    if (db?.raw) {
      try {
        db.raw.close();
      } catch {
        /* already closed */
      }
    }
  });

  it("opens an in-memory database and runs DDL", () => {
    db = openProfileDb(":memory:");
    const row = db
      .prepare("SELECT value FROM profile_meta WHERE key = ?")
      .get("schema_version") as { value: string };
    expect(row.value).toBe("1");
  });

  it("enables WAL mode on file-based db", () => {
    const tmpPath = "__test_wal.db";
    db = openProfileDb(tmpPath);
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
    db.raw.close();
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    try {
      unlinkSync(tmpPath + "-wal");
    } catch {
      /* best-effort */
    }
    try {
      unlinkSync(tmpPath + "-shm");
    } catch {
      /* best-effort */
    }
  });

  it("enables foreign keys", () => {
    db = openProfileDb(":memory:");
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it("throws DbCorruptError on schema version mismatch", () => {
    const tmpPath = "__test_schema_version.db";
    const raw = new Database(tmpPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    for (const sql of DDL_STATEMENTS) {
      raw.exec(sql);
    }
    raw.prepare("DELETE FROM profile_meta WHERE key = ?").run("schema_version");
    raw.prepare("INSERT INTO profile_meta (key, value) VALUES (?, ?)").run("schema_version", "99");
    raw.close();

    try {
      expect(() => openProfileDb(tmpPath)).toThrow(DbCorruptError);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      try {
        unlinkSync(tmpPath + "-wal");
      } catch {
        /* best-effort */
      }
      try {
        unlinkSync(tmpPath + "-shm");
      } catch {
        /* best-effort */
      }
    }
  });
});
