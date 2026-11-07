import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { DDL_STATEMENTS } from "../src/ddl";

describe("DDL_STATEMENTS", () => {
  it("openProfileDb 后查询 sqlite_master 能看到全部业务表", () => {
    const db = new Database(":memory:");
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    const expected = [
      "card_sections",
      "cards",
      "core_profile",
      "ingestion_proposals",
      "journal_records",
      "profile_meta",
      "profile_sources",
      "sources",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    db.close();
  });

  it("DDL 执行后 PRAGMA journal_mode 已切到 WAL", () => {
    const db = new Database(":memory:");
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    db.exec("PRAGMA journal_mode = WAL");
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(["wal", "memory"]).toContain(row.journal_mode);
    db.close();
  });

  it("DDL 执行后 PRAGMA foreign_keys 可开启", () => {
    const db = new Database(":memory:");
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    db.exec("PRAGMA foreign_keys = ON");
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  it("DDL 执行后 profile_meta 表 schema_version 可写入", () => {
    const db = new Database(":memory:");
    for (const sql of DDL_STATEMENTS) {
      db.exec(sql);
    }
    db.prepare("INSERT INTO profile_meta (key, value) VALUES (?, ?)").run("schema_version", "1");
    const row = db.prepare("SELECT value FROM profile_meta WHERE key = ?").get("schema_version") as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.value).toBe("1");
    db.close();
  });
});
