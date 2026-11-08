/**
 * 批 2b —— `buildFilter` fail-open 守卫 / 存量保护 / 回滚后派生读数下降。
 *
 * 验收基线 3「逐位一致」用三种证据同时钉死：
 *   ① 构造级：`buildFilter` 与改动前的 legacy 构造器逐字对比（谓词是唯一差异，params 顺序不变）；
 *   ② 行为级：零回滚 fixture 上 4 个读方法的**硬编码期望值**（即改动前的真实读数）；
 *   ③ fail-open：`NOT EXISTS` 对零回滚 fixture 的每一行恒为 TRUE。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PersonDb } from "../src/db";
import {
  buildFilter,
  REVERTED_BATCH_GUARD,
  type MessageFilterQuery,
} from "../src/repository/message-filter";
import { createMessagesRepo, type MessagesRepo } from "../src/repository/messages";
import { createStagingRepo } from "../src/repository/staging";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const CONV = "wechat:conv-1";

let dir: string;
let db: PersonDb;
let repo: MessagesRepo;

beforeEach(() => {
  dir = makeTempDir();
  const opened: PersonDb[] = [];
  db = openIn(dir, opened, "persons.sqlite");
  repo = createMessagesRepo(db);
  db.prepare(
    `INSERT INTO chat_conversations
       (conversation_id, platform, kind, title, created_at, updated_at)
     VALUES (?, 'wechat', 'direct', '张三', ?, ?)`,
  ).run(CONV, NOW, NOW);
});

afterEach(() => {
  closeAll([db]);
  removeTempDir(dir);
});

/** 改动前的 buildFilter（逐字复制基线，仅用于证明「谓词是唯一差异」）。 */
function legacyFilter(q: MessageFilterQuery) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const join = q.person_id === undefined ? "" : "JOIN v_chat_messages v ON v.message_id = m.message_id";
  if (q.person_id !== undefined) {
    conditions.push("v.sender_person_id = ?");
    params.push(q.person_id);
  }
  if (q.conversation_id !== undefined) {
    conditions.push("m.conversation_id = ?");
    params.push(q.conversation_id);
  }
  if (q.from_ms !== undefined) {
    conditions.push("m.ts_ms >= ?");
    params.push(q.from_ms);
  }
  if (q.to_ms !== undefined) {
    conditions.push("m.ts_ms < ?");
    params.push(q.to_ms);
  }
  if (q.content_types !== undefined && q.content_types.length > 0) {
    conditions.push(`m.content_type IN (${q.content_types.map(() => "?").join(", ")})`);
    params.push(...q.content_types);
  }
  return { join, where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

interface SeedRow {
  message_id: string;
  ts_ms: number;
  content: string;
  batch_id: string;
  msg_date: string;
  content_type?: "text" | "image";
}

function seedZeroRevertFixture(): void {
  const staging = createStagingRepo(db);
  staging.beginBatch({
    batch_id: "b1",
    platform: "wechat",
    extractor: "test",
    tool_version: "v1",
    now: NOW,
  });
  staging.beginBatch({
    batch_id: "b2",
    platform: "wechat",
    extractor: "test",
    tool_version: "v1",
    now: NOW,
  });
  staging.finishBatch({
    batch_id: "b2",
    status: "succeeded",
    conversation_count: 1,
    message_count: 2,
    now: NOW,
  });
  // 别名：让 person_id 分支能 JOIN 到 v_chat_messages
  db.prepare(
    `INSERT OR IGNORE INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
     VALUES ('p1', 'contact', '张三', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO aliases
       (alias_id, person_id, platform, alias_kind, alias, normalized, source, created_at, updated_at)
     VALUES ('a1', 'p1', 'wechat', 'platform_uid', 'wxid_a', 'wxid_a', 'extractor', ?, ?)`,
  ).run(NOW, NOW);

  const rows: SeedRow[] = [
    { message_id: "m1", ts_ms: 1000, content: "Alpha 100%", batch_id: "b1", msg_date: "2026-09-10" },
    { message_id: "m2", ts_ms: 2000, content: "Beta", batch_id: "b2", msg_date: "2026-09-10" },
    {
      message_id: "m3",
      ts_ms: 3000,
      content: "[图片]",
      batch_id: "b2",
      msg_date: "2026-09-11",
      content_type: "image",
    },
    { message_id: "m4", ts_ms: 4000, content: "Gamma", batch_id: "b1", msg_date: "2026-09-11" },
  ];
  for (const row of rows) {
    repo.insertOrIgnore([
      {
        message_id: row.message_id,
        conversation_id: CONV,
        platform: "wechat",
        sender_id: "wxid_a",
        sender_name: "张三",
        role: "other",
        ts_ms: row.ts_ms,
        msg_date: row.msg_date,
        content: row.content,
        content_type: row.content_type ?? "text",
        batch_id: row.batch_id,
        ingested_at: NOW,
      },
    ]);
  }
}

function revertBatch(batchId: string): void {
  db.prepare(
    "UPDATE ingest_batches SET status = 'reverted', reverted_at = ? WHERE batch_id = ?",
  ).run("2026-09-10T12:00:00+08:00", batchId);
}

describe("批 2b ① 构造级：guard 是唯一差异，其它条件/参数顺序不变", () => {
  const queries: MessageFilterQuery[] = [
    {},
    { person_id: "p1" },
    { conversation_id: CONV },
    { from_ms: 1000, to_ms: 5000 },
    { content_types: ["text", "image"] },
    { person_id: "p1", conversation_id: CONV, from_ms: 1000, to_ms: 5000, content_types: ["text"] },
  ];

  it.each(queries)("buildFilter(%o) 只在末尾多一条谓词，params 逐位相同", (q) => {
    const legacy = legacyFilter(q);
    const current = buildFilter(q);
    expect(current.join).toBe(legacy.join);
    expect(current.params).toEqual(legacy.params);
    expect(current.where).toBe(
      legacy.where === "" ? `WHERE ${REVERTED_BATCH_GUARD}` : `${legacy.where} AND ${REVERTED_BATCH_GUARD}`,
    );
    // 无条件分支：person_id 传不传都生效
    expect(current.where).toContain(REVERTED_BATCH_GUARD);
  });

  it("谓词不含占位符（不会挤占 params 顺序）", () => {
    expect(REVERTED_BATCH_GUARD).not.toContain("?");
    expect(buildFilter({}).params).toEqual([]);
  });
});

describe("批 2b ② 存量保护：零回滚 fixture 逐位一致（验收基线 3）", () => {
  it("count / list / searchContent / histogramByDate 与改动前读数逐位一致", () => {
    seedZeroRevertFixture();

    // ③ fail-open 构造级保证：零回滚批次时 NOT EXISTS 对每一行恒 TRUE
    const guardTrueCount = db
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages m WHERE ${REVERTED_BATCH_GUARD}`)
      .get() as { n: number };
    expect(guardTrueCount.n).toBe(4);

    // ② 硬编码期望值 = 改动前的真实读数（整数相等、数组顺序与长度相同）
    expect(repo.count()).toBe(4);
    expect(repo.count({ conversation_id: CONV })).toBe(4);
    expect(repo.count({ person_id: "p1" })).toBe(4);
    expect(repo.count({ from_ms: 2000, to_ms: 4000 })).toBe(2);

    expect(repo.list({}).map((r) => r.message_id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(repo.list({ content_types: ["image"] }).map((r) => r.message_id)).toEqual(["m3"]);
    expect(repo.list({ person_id: "p1" }).map((r) => r.message_id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(repo.list({ from_ms: 3000, to_ms: 4000 }).map((r) => r.message_id)).toEqual(["m3"]);

    expect(repo.searchContent({ keyword: "Beta" }).map((r) => r.message_id)).toEqual(["m2"]);
    expect(repo.searchContent({ keyword: "100%" }).map((r) => r.message_id)).toEqual(["m1"]);
    expect(repo.searchContent({ keyword: "%" }).map((r) => r.message_id)).toEqual(["m1"]);
    expect(repo.searchContent({ keyword: "Alpha", person_id: "p1" }).map((r) => r.message_id)).toEqual(["m1"]);

    expect(repo.histogramByDate({})).toEqual([
      { msg_date: "2026-09-10", count: 2 },
      { msg_date: "2026-09-11", count: 2 },
    ]);
    // histogramByDate 的额外日期条件分支（f.where 恒非空后不能产生尾随 AND）
    expect(repo.histogramByDate({ from_date: "2026-09-11" })).toEqual([
      { msg_date: "2026-09-11", count: 2 },
    ]);
    expect(repo.histogramByDate({ to_date: "2026-09-10" })).toEqual([
      { msg_date: "2026-09-10", count: 2 },
    ]);
  });

  it("消息的 ingest_batches 行缺失时仍保留（fail-open，不静默丢消息）", () => {
    seedZeroRevertFixture();
    repo.insertOrIgnore([
      {
        message_id: "m_ghost",
        conversation_id: CONV,
        platform: "wechat",
        sender_id: "wxid_a",
        sender_name: "张三",
        role: "other",
        ts_ms: 5000,
        msg_date: "2026-09-12",
        content: "Ghost",
        content_type: "text",
        batch_id: "batch-that-never-existed",
        ingested_at: NOW,
      },
    ]);
    expect(repo.count()).toBe(5);
    expect(repo.list({}).map((r) => r.message_id)).toEqual(["m1", "m2", "m3", "m4", "m_ghost"]);
    expect(repo.searchContent({ keyword: "Ghost" }).map((r) => r.message_id)).toEqual(["m_ghost"]);
  });
});

describe("批 2b ③ 回滚后派生读数下降 + 索引读口不再读到已撤消息（验收基线 4/5）", () => {
  it("revert b2 后 count 下降、searchContent 搜不到 Beta、messages.list 不含 m2/m3", () => {
    seedZeroRevertFixture();
    const before = {
      count: repo.count(),
      search: repo.searchContent({ keyword: "Beta" }).map((r) => r.message_id),
    };
    expect(before).toEqual({ count: 4, search: ["m2"] });

    revertBatch("b2");

    expect(repo.count()).toBe(2);
    expect(repo.count({ person_id: "p1" })).toBe(2);
    // context-router 的 adaptChatStore.listMessages 走的正是这个读口（不传 person_id）
    expect(repo.list({ conversation_id: CONV }).map((r) => r.message_id)).toEqual(["m1", "m4"]);
    expect(repo.searchContent({ keyword: "Beta" })).toEqual([]);
    expect(repo.histogramByDate({})).toEqual([
      { msg_date: "2026-09-10", count: 1 },
      { msg_date: "2026-09-11", count: 1 },
    ]);
    // 回滚不物理删除（D2）：get / 基表仍在
    expect(repo.get("m2")).not.toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n,
    ).toBe(4);
  });
});
