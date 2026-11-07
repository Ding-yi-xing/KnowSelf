import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openPersonDb, EXPECTED_SCHEMA_VERSION, type PersonDb } from "../src/db";
import { closeAll, makeTempDir, meta, openIn, removeTempDir } from "./helpers";

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

describe("openPersonDb", () => {
  it("空库初始化：schema_version 为期望值（'5'）、seed 'me' 恰好一行、约定键齐备", () => {
    const db = openIn(dir, opened, "plain.sqlite");
    expect(meta(db, "schema_version")).toBe(EXPECTED_SCHEMA_VERSION);
    expect(meta(db, "encryption_mode")).toBe("none");
    expect(meta(db, "timezone")).toBe("Asia/Shanghai");
    expect(meta(db, "self_person_id")).toBe("me");
    expect(meta(db, "produced_by.persons_stats")).toBe("person-store:stats-v1");

    const rows = db.prepare("SELECT person_id, subject_kind, display_name FROM persons").all() as {
      person_id: string;
      subject_kind: string;
      display_name: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ person_id: "me", subject_kind: "self", display_name: "我" });
  });

  it("PRAGMA：WAL / foreign_keys / temp_store", () => {
    const db = openIn(dir, opened, "pragmas.sqlite");
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const tempStore = db.prepare("PRAGMA temp_store").get() as { temp_store: number };
    expect(journal.journal_mode).toBe("wal");
    expect(foreignKeys.foreign_keys).toBe(1);
    expect(tempStore.temp_store).toBe(2);
  });

  it("重复打开幂等：'me' 不重复、schema_version 不变", () => {
    openIn(dir, opened, "idempotent.sqlite").close();
    const db = openIn(dir, opened, "idempotent.sqlite");
    const count = db.prepare("SELECT count(*) AS n FROM persons WHERE person_id = 'me'").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    expect(meta(db, "schema_version")).toBe(EXPECTED_SCHEMA_VERSION);
  });

  it("transaction() 提交与回滚", () => {
    const db = openIn(dir, opened, "txn.sqlite");
    const insert = db.prepare(
      `INSERT INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
       VALUES (?, 'contact', ?, '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
    );
    db.transaction(() => insert.run("p1", "p1"))();
    expect(() =>
      db.transaction(() => {
        insert.run("p2", "p2");
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    const ids = (
      db.prepare("SELECT person_id FROM persons ORDER BY person_id").all() as {
        person_id: string;
      }[]
    ).map((row) => row.person_id);
    expect(ids).toEqual(["me", "p1"]);
  });

  it("显式 selfDisplayName 生效", () => {
    const db = openPersonDb({
      dbPath: `${dir}/named.sqlite`,
      encryption: { mode: "none" },
      selfDisplayName: "张三",
    });
    opened.push(db);
    const row = db.prepare("SELECT display_name FROM persons WHERE person_id = 'me'").get() as {
      display_name: string;
    };
    expect(row.display_name).toBe("张三");
  });
});
