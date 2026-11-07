import { describe, it, expect } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { DDL_STATEMENTS } from "../src/ddl";
import { POST_MIGRATION_DDL } from "../src/ddl/migrations";

type Raw = InstanceType<typeof Database>;

/** DESIGN-17 §4.1：17 张表 + `semantic_llm_cache`（DESIGN-14 §2.6 #3）+ 1 视图 + 2 触发器。 */
const EXPECTED_TABLES = [
  "aliases",
  "chat_conversations",
  "chat_members",
  "chat_message_intents",
  "chat_message_mentions",
  "chat_message_staging",
  "chat_messages",
  "events",
  "ingest_batches",
  "ingest_cursors",
  "mining_graph_snapshots",
  "person_facts",
  "person_merges",
  "person_metrics",
  "persons",
  "persons_meta",
  "relationships",
  "semantic_llm_cache",
];

function freshDb(): Raw {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const sql of [...DDL_STATEMENTS, ...POST_MIGRATION_DDL]) {
    db.exec(sql);
  }
  return db;
}

function names(db: Raw, type: string): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function insertPerson(db: Raw, personId: string, subjectKind = "contact"): void {
  db.prepare(
    `INSERT INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
     VALUES (?, ?, ?, '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
  ).run(personId, subjectKind, personId);
}

describe("DDL_STATEMENTS", () => {
  it("建出 17 张表 + v_chat_messages 视图 + 2 个 append-only 触发器", () => {
    const db = freshDb();
    expect(names(db, "table")).toEqual(EXPECTED_TABLES);
    expect(names(db, "view")).toEqual(["v_chat_messages"]);
    expect(names(db, "trigger")).toEqual(["trg_chat_msg_no_delete", "trg_chat_msg_no_update"]);
    db.close();
  });

  it("幂等：重复执行不报错、表数不变", () => {
    const db = freshDb();
    for (const sql of [...DDL_STATEMENTS, ...POST_MIGRATION_DDL]) {
      db.exec(sql);
    }
    expect(names(db, "table")).toEqual(EXPECTED_TABLES);
    db.close();
  });

  it("DESIGN-14 §2.6 增量：events.event_kind + idx_events_kind + semantic_llm_cache 索引", () => {
    const db = freshDb();
    const eventColumns = (
      db.prepare("PRAGMA table_info(`events`)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(eventColumns).toContain("event_kind");
    const indexes = names(db, "index");
    expect(indexes).toContain("idx_events_kind");
    expect(indexes).toContain("idx_semantic_cache_ver");

    // 默认值 'other' 生效（DESIGN-14 §5.2 的兜底取值）
    db.prepare(
      `INSERT INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
       VALUES ('me', 'self', '我', '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
    ).run();
    db.prepare(
      `INSERT INTO events (event_id, title, event_date, source_kind, created_at, updated_at)
       VALUES ('e1', '见面', '2026-09-10', 'manual', '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
    ).run();
    const event = db.prepare("SELECT event_kind FROM events WHERE event_id = 'e1'").get() as {
      event_kind: string;
    };
    expect(event.event_kind).toBe("other");
    db.close();
  });

  it("append-only：chat_messages 的 UPDATE / DELETE 被触发器拒绝", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
       VALUES ('me', 'self', '我', '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_conversations (conversation_id, platform, kind, created_at, updated_at)
       VALUES ('wechat:c1', 'wechat', 'direct', '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_messages
         (message_id, conversation_id, platform, sender_id, role, ts_ms, msg_date, batch_id, ingested_at)
       VALUES ('m1', 'wechat:c1', 'wechat', 'wxid_1', 'other', 1, '2026-09-10', 'b1', '2026-09-10T00:00:00+08:00')`,
    ).run();

    expect(() =>
      db.prepare("UPDATE chat_messages SET content = 'x' WHERE message_id = 'm1'").run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM chat_messages WHERE message_id = 'm1'").run()).toThrow(
      /append-only/,
    );
    db.close();
  });

  it("uq_persons_self：subject_kind='self' 至多一行", () => {
    const db = freshDb();
    insertPerson(db, "me", "self");
    expect(() => insertPerson(db, "me2", "self")).toThrow();
    db.close();
  });

  it("uq_aliases_platform_uid：一个平台 ID 只能属于一个人", () => {
    const db = freshDb();
    insertPerson(db, "p1");
    insertPerson(db, "p2");
    const insertAlias = db.prepare(
      `INSERT INTO aliases
         (alias_id, person_id, platform, alias_kind, alias, normalized, source, created_at, updated_at)
       VALUES (?, ?, 'wechat', ?, ?, ?, 'extractor', '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
    );
    insertAlias.run("a1", "p1", "platform_uid", "wxid_1", "wxid_1");
    expect(() => insertAlias.run("a2", "p2", "platform_uid", "wxid_1", "wxid_1")).toThrow();
    // 非 platform_uid 的同名别名不受该唯一索引限制
    insertAlias.run("a3", "p2", "nickname", "wxid_1", "wxid_1");
    db.close();
  });

  it("relationships 三层 scope 唯一键生效", () => {
    const db = freshDb();
    insertPerson(db, "me", "self");
    insertPerson(db, "p1");
    const insert = db.prepare(
      `INSERT INTO relationships
         (relation_id, counterpart_id, scope_kind, scope_id, source, created_at, updated_at)
       VALUES (?, 'p1', 'group', 'wechat:g1', 'auto', '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
    );
    insert.run("r1");
    expect(() => insert.run("r2")).toThrow();
    db.close();
  });

  it("person_metrics：metric_value 与 metric_value_json 不可同时为空", () => {
    const db = freshDb();
    insertPerson(db, "p1");
    expect(() =>
      db
        .prepare(
          `INSERT INTO person_metrics
             (metric_id, person_id, scope_kind, metric_key, computed_at)
           VALUES ('mt1', 'p1', 'global', 'msg_count', '2026-09-10T00:00:00+08:00')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("外键生效：chat_members 引用不存在的会话被拒绝", () => {
    const db = freshDb();
    insertPerson(db, "p1");
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_members (conversation_id, person_id, created_at, updated_at)
           VALUES ('wechat:missing', 'p1', '2026-09-10T00:00:00+08:00', '2026-09-10T00:00:00+08:00')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});
