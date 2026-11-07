/**
 * 迁移测试：`ingestion_proposals.target_kind` 的 CHECK 从 3 值放宽到 4 值
 * （增加 `chat_message`，DESIGN-11 §7.2 #1 / V3 授权「加枚举值」）。
 *
 * 用 v-1 形态（`DDL_STATEMENTS` 仍是 3 值）建库 → `openProfileDb` 触发迁移 → 断言：
 * 行/列/索引/外键全部不变，且新值可写、非法值仍被拒、重复打开不重建。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openProfileDb } from "../src/db";
import { DDL_STATEMENTS } from "../src/ddl";
import { DbCorruptError } from "../src/errors";

const NOW = "2026-09-10T10:00:00.000Z";
const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";
const scratch: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-profile-migration-"));
  scratch.push(dir);
  return join(dir, "profile.sqlite");
}

/**
 * V3 之前（v-1）的 `ingestion_proposals` 建表语句 + 索引。
 * 这里**故意手写旧形态**：`DDL_STATEMENTS` 已是新库终态（含 `chat_message`），
 * 迁移测试必须自己造一个真正的旧库，不能靠现有 DDL。
 */
const OLD_PROPOSALS_DDL = [
  `CREATE TABLE ingestion_proposals (
    id                      TEXT    PRIMARY KEY,
    source_id               TEXT    NOT NULL,
    target_kind             TEXT    NOT NULL CHECK (target_kind IN ('core','card_section','journal')),
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
  )`,
  "CREATE INDEX IF NOT EXISTS idx_proposals_source ON ingestion_proposals(source_id)",
  "CREATE INDEX IF NOT EXISTS idx_proposals_status ON ingestion_proposals(status)",
];

interface OldRow {
  id: string;
  source_id: string;
  target_kind: string;
  target_ref: string;
  proposed_body: string;
  reasoning: string;
  source_excerpts: string;
  produced_by_provider: string;
  status: string;
  user_edited_body: string | null;
  created_at: string;
  decided_at: string | null;
}

/** 造一个「V3 之前」的库：OLD CHECK + 1 个 source + 3 条 proposal + 2 个索引。 */
function buildV1Db(path: string): { rows: OldRow[]; rootpage: number } {
  const raw = new Database(path);
  raw.pragma("foreign_keys = OFF");
  // 除 ingestion_proposals 自身的建表/索引外，其余表用现行 DDL（它们与本迁移无关）。
  // 注意不能按 `includes("ingestion_proposals")` 过滤——`profile_sources` 的外键也含该词。
  for (const sql of DDL_STATEMENTS) {
    const isProposalOwnDdl =
      /CREATE TABLE IF NOT EXISTS ingestion_proposals\b/.test(sql) ||
      /ON ingestion_proposals\(/.test(sql);
    if (isProposalOwnDdl) continue;
    raw.exec(sql);
  }
  for (const sql of OLD_PROPOSALS_DDL) raw.exec(sql);

  raw
    .prepare(
      `INSERT INTO sources
        (id, kind, original_name, mime_type, extracted_text, char_count, status, created_at)
       VALUES (?, 'file', 's.txt', 'text/plain', 'body', 4, 'completed', ?)`,
    )
    .run(SOURCE_ID, NOW);

  const insert = raw.prepare(
    `INSERT INTO ingestion_proposals
      (id, source_id, target_kind, target_ref, proposed_body, reasoning, source_excerpts,
       produced_by_provider, status, user_edited_body, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < 3; index += 1) {
    insert.run(
      `proposal-${index}`,
      SOURCE_ID,
      "core",
      JSON.stringify({ kind: "core" }),
      `body-${index}`,
      `reason-${index}`,
      "[]",
      "test-provider",
      "pending",
      null,
      NOW,
      null,
    );
  }
  raw
    .prepare(
      `INSERT INTO profile_sources (profile_kind, profile_id, source_id, proposal_id, created_at)
       VALUES ('core', 'core_main', ?, 'proposal-0', ?)`,
    )
    .run(SOURCE_ID, NOW);

  const rows = raw
    .prepare("SELECT * FROM ingestion_proposals ORDER BY id")
    .all() as OldRow[];
  const meta = raw
    .prepare("SELECT rootpage, sql FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'")
    .get() as { rootpage: number; sql: string };
  // 前置条件：建库后仍是旧 CHECK（迁移由 openProfileDb 负责）
  expect(meta.sql).not.toContain("'chat_message'");
  raw.close();
  return { rows, rootpage: meta.rootpage };
}

function indexNames(raw: InstanceType<typeof Database>): string[] {
  return (
    raw
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='index' AND tbl_name='ingestion_proposals' AND sql IS NOT NULL
          ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

afterEach(() => {
  for (const path of scratch.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows 上若有未关闭句柄，临时目录留给 OS 清理（不影响断言）
    }
  }
});

describe("ensureProposalTargetKindConstraint（V3 加法式：加枚举值）", () => {
  it("旧库升级：行/列/索引不变，CHECK 放宽到 4 值，foreign_key_check 为空，且确实重建过", () => {
    const path = tmpDbPath();
    const { rows, rootpage: rootpageBefore } = buildV1Db(path);

    const db = openProfileDb(path);
    const after = db.raw.prepare("SELECT * FROM ingestion_proposals ORDER BY id").all() as OldRow[];

    // 行数与逐字段内容不变
    expect(after).toHaveLength(rows.length);
    expect(after).toEqual(rows);

    // 索引仍在（从 sqlite_master 重放，不是手抄）
    expect(indexNames(db.raw)).toEqual(["idx_proposals_source", "idx_proposals_status"]);

    // 外键完整性
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const fkSql = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'")
      .get() as { sql: string };
    expect(fkSql.sql).toContain("'chat_message'");
    expect(fkSql.sql).toContain(
      "IN ('core','card_section','journal','chat_message')",
    );
    // 旧库**必须**重建（与「新建库不重建」用例互为对照）
    const rootpageAfter = (
      db.raw
        .prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'")
        .get() as { rootpage: number }
    ).rootpage;
    expect(rootpageAfter).not.toBe(rootpageBefore);
    db.raw.close();
  });

  it("新建库直通：DDL 已是终态，open 不触发重建", () => {
    // ① DDL 本身就是新库终态（事实源唯一）
    expect(
      DDL_STATEMENTS.some(
        (sql) =>
          /CREATE TABLE IF NOT EXISTS ingestion_proposals\b/.test(sql) &&
          sql.includes("'chat_message'"),
      ),
    ).toBe(true);

    // ② 用 DDL 建好的库：open 前后建表 SQL 与 rootpage 都逐字不变
    const seeded = tmpDbPath();
    const raw = new Database(seeded);
    for (const sql of DDL_STATEMENTS) raw.exec(sql);
    const before = raw
      .prepare(
        "SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'",
      )
      .get() as { sql: string; rootpage: number };
    raw.close();

    const db = openProfileDb(seeded);
    const after = db.raw
      .prepare(
        "SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'",
      )
      .get() as { sql: string; rootpage: number };
    expect(after.sql).toBe(before.sql);
    expect(after.rootpage).toBe(before.rootpage);
    expect(after.sql).not.toContain("ingestion_proposals_new");
    expect(
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ingestion_proposals_new%'")
        .all(),
    ).toEqual([]);
    db.raw.close();

    // ③ 全新路径（此前不存在文件）：第一次 open 也不重建 —— 用「第二次 open 的 rootpage
    //    与第一次相同」反证（若第一次重建过，rootpage 会在第一次被改写；此处无前值可比，
    //    故以 ② 的「open 前 baseline」作为重建与否的正向证据，这里补充首次 open 的稳定性）。
    const fresh = tmpDbPath();
    const firstOpen = openProfileDb(fresh);
    const firstSchema = firstOpen.raw
      .prepare(
        "SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'",
      )
      .get() as { sql: string; rootpage: number };
    expect(firstSchema.sql).toContain("'chat_message'");
    expect(firstSchema.sql).not.toContain("ingestion_proposals_new");
    firstOpen.raw.close();

    const secondOpen = openProfileDb(fresh);
    const secondSchema = secondOpen.raw
      .prepare(
        "SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'",
      )
      .get() as { sql: string; rootpage: number };
    expect(secondSchema.rootpage).toBe(firstSchema.rootpage);
    secondOpen.raw.close();
  });

  it("新约束生效：chat_message 可写，非法枚举仍被拒", () => {
    const path = tmpDbPath();
    buildV1Db(path);
    const db = openProfileDb(path);

    const insert = db.raw.prepare(
      `INSERT INTO ingestion_proposals
        (id, source_id, target_kind, target_ref, proposed_body, produced_by_provider, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    expect(() =>
      insert.run(
        "proposal-chat",
        SOURCE_ID,
        "chat_message",
        JSON.stringify({ kind: "chat_message", batch_id: "b1" }),
        "chat body",
        "chat-ingest:rule-v1",
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      insert.run("proposal-bogus", SOURCE_ID, "bogus", "{}", "x", "p", NOW),
    ).toThrow(/CHECK constraint failed/i);

    db.raw.close();
  });

  it("幂等：连续 openProfileDb 两次，第二次不重建（rootpage 不变）", () => {
    const path = tmpDbPath();
    const { rootpage } = buildV1Db(path);

    const first = openProfileDb(path);
    const afterFirst = first.raw
      .prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'")
      .get() as { rootpage: number };
    const countAfterFirst = first.raw.prepare("SELECT COUNT(*) AS n FROM ingestion_proposals").get() as {
      n: number;
    };
    first.raw.close();

    const second = openProfileDb(path);
    const afterSecond = second.raw
      .prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'")
      .get() as { rootpage: number };
    const countAfterSecond = second.raw
      .prepare("SELECT COUNT(*) AS n FROM ingestion_proposals")
      .get() as { n: number };

    expect(afterFirst.rootpage).not.toBe(rootpage); // 第一次确实重建了
    expect(afterSecond.rootpage).toBe(afterFirst.rootpage); // 第二次未重建
    expect(countAfterSecond.n).toBe(countAfterFirst.n);
    second.raw.close();
  });

  it("异常回滚：迁移前已存在外键孤儿 → 抛 DbCorruptError 且旧表原样保留", () => {
    const path = tmpDbPath();
    buildV1Db(path);

    // 制造一个 FK 孤儿（模拟历史坏数据）：profile_sources.proposal_id 指向不存在的 proposal
    const raw = new Database(path);
    raw.pragma("foreign_keys = OFF");
    raw
      .prepare(
        `INSERT INTO profile_sources (profile_kind, profile_id, source_id, proposal_id, created_at)
         VALUES ('core', 'ghost', ?, 'ghost-proposal', ?)`,
      )
      .run(SOURCE_ID, NOW);
    const before = raw.prepare("SELECT COUNT(*) AS n FROM ingestion_proposals").get() as { n: number };
    raw.close();

    expect(() => openProfileDb(path)).toThrow(DbCorruptError);

    // 回滚后：表仍是旧 CHECK、行数不变
    const verify = new Database(path);
    const schema = verify
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ingestion_proposals'")
      .get() as { sql: string };
    const after = verify.prepare("SELECT COUNT(*) AS n FROM ingestion_proposals").get() as { n: number };
    expect(schema.sql).not.toContain("'chat_message'");
    expect(after.n).toBe(before.n);
    verify.close();
  });
});
