/**
 * QA 独立验收（严过关）—— 不复用 review-required-2b.test.ts。
 *
 * 目标：确认「撤销后强制复核」的粘性解除探针
 *   ① 用 julianday() 而非字符串比较；② 取 MAX(reverted_at)；
 *   ③ COALESCE(..., '')；④ 没有多余过滤（不按 batch_id / committed 过滤）。
 * 自建用例：空格分隔 ISO 字符串与标准 Z 格式混用，且明确构造「字符串比较会判错」的组合。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersonDb } from "../src/db";
import { createReviewRequiredRepo } from "../src/repository/review-required";
import { createMessagesRepo } from "../src/repository/messages";
import { createStagingRepo } from "../src/repository/staging";
import type { StagingInsert } from "../src/types-ingest";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const CONV = "wechat:conv-1";
const NOW = "2026-11-07 08:00:00";

const SPACE_10 = "2026-11-07 10:00:00";
const SPACE_12 = "2026-11-07 12:00:00";
const ISO_Z_10 = "2026-11-07T10:00:00.000Z";
const ISO_Z_12 = "2026-11-07T12:00:00.000Z";

let dir: string;
let db: PersonDb;

beforeEach(() => {
  dir = makeTempDir();
  const opened: PersonDb[] = [];
  db = openIn(dir, opened, "persons.sqlite");
  db.prepare(
    `INSERT INTO chat_conversations
       (conversation_id, platform, kind, title, created_at, updated_at)
     VALUES (?, 'wechat', 'direct', 'QA', ?, ?)`,
  ).run(CONV, NOW, NOW);
});

afterEach(() => {
  closeAll([db]);
  removeTempDir(dir);
});

function stagingRow(messageId: string): StagingInsert {
  return {
    message_id: messageId,
    platform: "wechat",
    sender_id: "wxid_a",
    sender_name: "QA",
    role: "other",
    ts_ms: 1000,
    msg_date: "2026-11-07",
    content: `qa-${messageId}`,
    content_type: "text",
    reply_to: null,
    meta: "{}",
  };
}

/** 建批次 + staging 行 + 该批次自身的落档行（ingested_at 早于撤销），可选置 reverted。 */
function makeBatch(batchId: string, messageId: string, revertedAt?: string): void {
  const staging = createStagingRepo(db);
  staging.beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "qa-independent",
    tool_version: "v1",
    now: NOW,
  });
  staging.stageMessages({
    batch_id: batchId,
    conversation_id: CONV,
    rows: [stagingRow(messageId)],
    now: NOW,
  });
  staging.finishBatch({
    batch_id: batchId,
    status: "succeeded",
    conversation_count: 1,
    message_count: 1,
    now: NOW,
  });
  createMessagesRepo(db).insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: "wxid_a",
      sender_name: "QA",
      role: "other",
      ts_ms: 1000,
      msg_date: "2026-11-07",
      content: `qa-${messageId}`,
      content_type: "text",
      batch_id: batchId,
      ingested_at: NOW,
    },
  ]);
  if (revertedAt !== undefined) staging.markBatchReverted({ batch_id: batchId, now: revertedAt });
}

/** 模拟「用户接受并实际落档」：新增 chat_messages 行，ingested_at = 落档时刻。 */
function land(messageId: string, ingestedAt: string): void {
  createMessagesRepo(db).insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: "wxid_a",
      sender_name: "QA",
      role: "other",
      ts_ms: 9000,
      msg_date: "2026-11-07",
      content: `qa-${messageId}`,
      content_type: "text",
      batch_id: "b-landed-no-batch-row",
      ingested_at: ingestedAt,
    },
  ]);
}

function reviewIds(): string[] {
  return createReviewRequiredRepo(db)
    .listReviewRequiredConversations()
    .map((r) => r.conversation_id);
}

describe("QA 独立：探针 SQL 的构造级不变量", () => {
  const source = readFileSync(
    join(process.cwd(), "packages/person-store/src/repository/review-required.ts"),
    "utf8",
  );
  const probe = source.split("const CLEARED_PROBE_SQL = `")[1]?.split("`;")[0] ?? "";
  const candidates = source.split("const CANDIDATES_SQL = `")[1]?.split("`;")[0] ?? "";

  it("CLEARED_PROBE_SQL 用 julianday() 而非字符串比较，且两侧都过日期函数", () => {
    expect(probe).toContain("julianday(m.ingested_at)");
    expect(probe).toContain("julianday(COALESCE(");
    expect(probe.match(/julianday\(/g)?.length).toBe(2);
    expect(probe).not.toMatch(/m\.ingested_at\s*>\s*'|strftime|datetime\(m\.ingested_at\)/);
  });

  it("COALESCE(..., '') + MAX(b.reverted_at) 同时出现在探针与候选集", () => {
    expect(probe).toContain("julianday(COALESCE((");
    expect(probe).toContain("), '')");
    expect(probe).toContain("MAX(b.reverted_at)");
    expect(candidates).toContain("MAX(b.reverted_at)");
    // julianday('') === NULL 是「从未撤销 ⇒ 条件恒假」的关键；回退值必须是空串而非时间戳占位
    expect(probe).not.toMatch(/,\s*'19\d\d|,\s*'20\d\d/);
  });

  it("没有多余过滤：不按 batch_id / committed / rejected / 批次状态裁掉落档行", () => {
    expect(probe).not.toContain("m.batch_id");
    expect(probe).not.toContain("committed");
    expect(probe).not.toContain("rejected");
    expect(probe).not.toContain("b.status");
    expect(probe).not.toContain("AND m.");
    // 外层 WHERE 只有 conversation_id 一个过滤，外加 julianday 判定
    expect(probe).toContain("WHERE m.conversation_id = ?");
    expect(probe.match(/AND /g)?.length).toBe(2); // 外层 1 个 + 子查询 1 个
  });
});

describe("QA 独立：COALESCE 与空格/Z 混用格式", () => {
  it("从未撤销：探针恒假 ⇒ 不复核、候选集为空", () => {
    makeBatch("b1", "m1");
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
    expect(reviewIds()).toEqual([]);
    expect(db.prepare("SELECT julianday('') AS j").get()).toEqual({ j: null });
  });

  it.each([
    [SPACE_10, SPACE_12],
    [SPACE_10, ISO_Z_12],
    [ISO_Z_10, SPACE_12],
    [ISO_Z_10, ISO_Z_12],
  ])("reverted_at=%s / ingested_at=%s（空格与 Z 混用）⇒ 判定一致：复核解除", (revertedAt, ingestedAt) => {
    makeBatch("b1", "m1", revertedAt);
    land("m-landed", ingestedAt);
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
    expect(reviewIds()).toEqual([]);
  });

  it("字符串比较陷阱：Z 格式撤销 + 空格格式更晚落档，必须解除（证明是 julianday 而非字典序）", () => {
    // 字典序里空格(0x20) < 'T'(0x54)，故 JS 字符串比较会得出「更晚落档 < 撤销」的错误结论
    expect(SPACE_12 > ISO_Z_10).toBe(false);
    makeBatch("b1", "m1", ISO_Z_10);
    land("m-landed", SPACE_12);
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
    expect(reviewIds()).toEqual([]);
  });

  it("相等时刻（两种格式）不解除：探针是严格 >", () => {
    makeBatch("b1", "m1", SPACE_10);
    land("m-landed", ISO_Z_10);
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
    expect(reviewIds()).toEqual([CONV]);
  });

  it("早于撤销（两种格式混用）仍复核：粘性不误解除", () => {
    makeBatch("b1", "m1", ISO_Z_10);
    land("m-landed", "2026-11-07 09:00:00");
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
    expect(reviewIds()).toEqual([CONV]);
  });

  it("MAX(reverted_at) 粘性：两次撤销混用格式，中间落档不解除，只认最近一次", () => {
    makeBatch("b1", "m1", SPACE_10);
    land("m-between", ISO_Z_12); // 早于第二次撤销
    makeBatch("b2", "m2", "2026-11-07 13:00:00");
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
    expect(createReviewRequiredRepo(db).listReviewRequiredConversations()[0]?.last_reverted_at).toBe(
      "2026-11-07 13:00:00",
    );
    land("m-after", "2026-11-07 14:00:00");
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
  });
});
