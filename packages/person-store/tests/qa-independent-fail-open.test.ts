/**
 * QA 独立验收（严过关）—— 不复用 revert-guard-2b.test.ts / repository-messages.test.ts。
 *
 * 目标：证明 `REVERTED_BATCH_GUARD` 是一个「无条件分支、无占位符、params 顺序不变」的
 * fail-open 谓词，并且在**零回滚批次**时对 count / list / searchContent / histogramByDate
 * 四个读出口逐位无影响。
 *
 * 独立手段：用「与生产 SQL 完全相同、仅把 guard 从 where 中剥离」的等价 SQL 作为参照，
 * 逐位比对四个读出口的真实返回值 —— 参照值不是手写常量，不受工程师测试口径影响。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const OTHER_CONV = "wechat:conv-2";
const BASE_MS = 1_700_000_000_000;

let dir: string;
let db: PersonDb;
let repo: MessagesRepo;

beforeEach(() => {
  dir = makeTempDir();
  const opened: PersonDb[] = [];
  db = openIn(dir, opened, "persons.sqlite");
  repo = createMessagesRepo(db);
  const conv = db.prepare(
    `INSERT INTO chat_conversations
       (conversation_id, platform, kind, title, created_at, updated_at)
     VALUES (?, 'wechat', 'direct', 'QA', ?, ?)`,
  );
  conv.run(CONV, NOW, NOW);
  conv.run(OTHER_CONV, NOW, NOW);
});

afterEach(() => {
  closeAll([db]);
  removeTempDir(dir);
});

function beginBatch(batchId: string): void {
  createStagingRepo(db).beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "qa-independent",
    tool_version: "v1",
    now: NOW,
  });
}

interface SeedMessage {
  id: string;
  ts: number;
  content: string;
  batch: string;
  contentType?: "text" | "image";
  msgDate?: string;
  conv?: string;
}

function seed(rows: readonly SeedMessage[]): void {
  repo.insertOrIgnore(
    rows.map((r) => ({
      message_id: r.id,
      conversation_id: r.conv ?? CONV,
      platform: "wechat",
      sender_id: "wxid_a",
      sender_name: "QA",
      role: "other",
      ts_ms: r.ts,
      msg_date: r.msgDate ?? "2026-09-10",
      content: r.content,
      content_type: r.contentType ?? "text",
      batch_id: r.batch,
      ingested_at: NOW,
    })),
  );
}

/** 零回滚批次的基线数据：2 个 succeeded 批次（reverted_at 为 NULL）+ 1 个孤立 batch_id。 */
function seedNoReverts(): void {
  beginBatch("b1");
  beginBatch("b2");
  seed([
    { id: "m1", ts: BASE_MS, content: "alpha one", batch: "b1" },
    { id: "m2", ts: BASE_MS + 1, content: "beta two", batch: "b2", contentType: "image", msgDate: "2026-09-11" },
    { id: "m3", ts: BASE_MS + 2, content: "alpha three", batch: "b1", msgDate: "2026-09-12", conv: OTHER_CONV },
    { id: "m4", ts: BASE_MS + 3, content: "gamma ghost", batch: "b-ghost" },
  ]);
}

/** 把 guard 从 where 中剥离，得到「守卫不存在时」的等价 SQL。 */
function stripGuard(where: string): string {
  if (where === `WHERE ${REVERTED_BATCH_GUARD}`) return "";
  const suffix = ` AND ${REVERTED_BATCH_GUARD}`;
  expect(where.endsWith(suffix)).toBe(true);
  return where.slice(0, -suffix.length);
}

interface Shape {
  label: string;
  q: MessageFilterQuery;
  keyword: string;
  from_date?: string;
  to_date?: string;
  expectedParams: (string | number)[];
}

const SHAPES: readonly Shape[] = [
  { label: "无过滤", q: {}, keyword: "alpha", expectedParams: [] },
  { label: "conversation_id", q: { conversation_id: CONV }, keyword: "alpha", expectedParams: [CONV] },
  {
    label: "from_ms/to_ms",
    q: { from_ms: BASE_MS, to_ms: BASE_MS + 9000 },
    keyword: "beta",
    expectedParams: [BASE_MS, BASE_MS + 9000],
  },
  {
    label: "content_types",
    q: { content_types: ["text", "image"] },
    keyword: "gamma",
    expectedParams: ["text", "image"],
  },
  {
    label: "全条件 + 日期直方图",
    q: {
      conversation_id: CONV,
      from_ms: BASE_MS,
      to_ms: BASE_MS + 9000,
      content_types: ["text", "image"],
    },
    keyword: "alpha",
    from_date: "2026-09-10",
    to_date: "2026-09-12",
    expectedParams: [CONV, BASE_MS, BASE_MS + 9000, "text", "image"],
  },
  {
    label: "person_id（带 JOIN 分支）",
    q: { person_id: "p1" },
    keyword: "alpha",
    expectedParams: ["p1"],
  },
];

/** 用与生产完全一致的 SQL（仅去掉 guard）计算四个参照读数。 */
function referenceReads(shape: Shape): {
  count: number;
  list: unknown[];
  search: unknown[];
  histogram: unknown[];
} {
  const f = buildFilter(shape.q);
  const bare = stripGuard(f.where);

  const count = (
    db.prepare(`SELECT COUNT(*) AS n FROM chat_messages m ${f.join} ${bare}`).get(...f.params) as {
      n: number;
    }
  ).n;
  const list = db
    .prepare(
      `SELECT m.* FROM chat_messages m ${f.join} ${bare} ORDER BY m.ts_ms ASC, m.message_id ASC`,
    )
    .all(...f.params);
  const clause = bare === "" ? "WHERE" : `${bare} AND`;
  const search = db
    .prepare(
      `SELECT m.* FROM chat_messages m ${f.join} ${clause} m.content LIKE ? ESCAPE '\\' ORDER BY m.ts_ms ASC, m.message_id ASC`,
    )
    .all(...f.params, `%${shape.keyword}%`);

  const params = [...f.params];
  const extra: string[] = [];
  if (shape.from_date !== undefined) {
    extra.push("m.msg_date >= ?");
    params.push(shape.from_date);
  }
  if (shape.to_date !== undefined) {
    extra.push("m.msg_date <= ?");
    params.push(shape.to_date);
  }
  const where =
    extra.length === 0
      ? bare
      : bare === ""
        ? `WHERE ${extra.join(" AND ")}`
        : `${bare} AND ${extra.join(" AND ")}`;
  const histogram = db
    .prepare(
      `SELECT m.msg_date AS msg_date, COUNT(*) AS count FROM chat_messages m ${f.join} ${where}
       GROUP BY m.msg_date ORDER BY m.msg_date ASC`,
    )
    .all(...params);

  return { count, list, search, histogram };
}

describe("QA 独立：REVERTED_BATCH_GUARD 构造级不变量", () => {
  it("谓词本身是 NOT EXISTS、不含占位符、只认 reverted_at IS NOT NULL", () => {
    expect(REVERTED_BATCH_GUARD).toContain("NOT EXISTS");
    expect(REVERTED_BATCH_GUARD).toContain("b.reverted_at IS NOT NULL");
    expect(REVERTED_BATCH_GUARD).not.toContain("?");
    expect(REVERTED_BATCH_GUARD).not.toContain("undefined");
    expect(REVERTED_BATCH_GUARD).not.toMatch(/TODO|PLACEHOLDER|占位/i);
  });

  it.each(SHAPES)(
    "无条件分支 + guard 恒在末尾 + params 逐位不变：$label",
    (shape) => {
      const f = buildFilter(shape.q);
      expect(f.where).toContain(REVERTED_BATCH_GUARD);
      // guard 放在最后，既有条件字符串逐字不变
      expect(
        f.where === `WHERE ${REVERTED_BATCH_GUARD}` ||
          f.where.endsWith(` AND ${REVERTED_BATCH_GUARD}`),
      ).toBe(true);
      expect(f.params).toEqual(shape.expectedParams);
      if (shape.q.person_id === undefined) expect(f.join).toBe("");
      else expect(f.join).toContain("JOIN v_chat_messages");
    },
  );
});

describe("QA 独立：零回滚批次时四个读出口逐位无影响", () => {
  beforeEach(() => seedNoReverts());

  it.each(SHAPES)("$label：count / list / searchContent / histogramByDate 与去守卫 SQL 完全一致", (shape) => {
    const ref = referenceReads(shape);
    const q = shape.q;
    const histogramQuery = {
      ...q,
      ...(shape.from_date === undefined ? {} : { from_date: shape.from_date }),
      ...(shape.to_date === undefined ? {} : { to_date: shape.to_date }),
    };
    expect(repo.count(q)).toBe(ref.count);
    expect(repo.list(q)).toEqual(ref.list);
    expect(repo.searchContent({ ...q, keyword: shape.keyword })).toEqual(ref.search);
    expect(repo.histogramByDate(histogramQuery)).toEqual(ref.histogram);
  });

  it("fail-open：batch_id 在 ingest_batches 无对应行时消息仍被四个读出口包含", () => {
    // b-ghost 从未 beginBatch，NOT EXISTS 恒 TRUE，不能因 join 不到而丢消息
    expect(repo.count({ conversation_id: CONV })).toBe(3);
    expect(repo.list({ conversation_id: CONV }).map((r) => r.message_id)).toEqual(["m1", "m2", "m4"]);
    expect(repo.searchContent({ keyword: "gamma" }).map((r) => r.message_id)).toEqual(["m4"]);
    expect(repo.histogramByDate({})).toEqual([
      { msg_date: "2026-09-10", count: 2 },
      { msg_date: "2026-09-11", count: 1 },
      { msg_date: "2026-09-12", count: 1 },
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n).toBe(4);
  });

  it("正对照：置 b2 为 reverted 后四个读出口同时剔除该批消息，基表仍保留（append-only）", () => {
    createStagingRepo(db).markBatchReverted({ batch_id: "b2", now: NOW });
    expect(repo.count({ conversation_id: CONV })).toBe(2);
    expect(repo.list({ conversation_id: CONV }).map((r) => r.message_id)).toEqual(["m1", "m4"]);
    expect(repo.searchContent({ keyword: "beta" })).toEqual([]);
    expect(repo.histogramByDate({})).toEqual([
      { msg_date: "2026-09-10", count: 2 },
      { msg_date: "2026-09-12", count: 1 },
    ]);
    // 回滚不物理删除：基表 4 行不变
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n).toBe(4);
    expect(repo.get("m2")?.content).toBe("beta two");
  });
});
