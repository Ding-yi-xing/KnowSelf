/**
 * 批 2b —— 「撤销后强制复核」粘性解除探针（评审定稿 11b~11f）。
 *
 * 覆盖：
 *   - `COALESCE(..., '')`：从未撤销时 julianday('') == NULL，条件恒假；
 *   - `MAX(reverted_at)`：多次撤销只认最近一次，期间落档不误解除；
 *   - `julianday()` 而非字符串比较：格式漂移（空格/无 Z 与 T...Z）判定一致；
 *   - 解除条件 = 「接受并实际落档一批」：committed=0 / 跨批拒绝时 ingested_at 不前移 ⇒ 不解除；
 *   - 粘性：多次重导不偷偷复原，直到真有消息落档；
 *   - 门面公开方法可达（store.listReviewRequiredConversations / isReviewRequired）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import type { PersonDb } from "../src/db";
import { createPersonStore, type PersonStore } from "../src/store";
import { createReviewRequiredRepo } from "../src/repository/review-required";
import { createMessagesRepo } from "../src/repository/messages";
import { createStagingRepo } from "../src/repository/staging";
import type { StagingInsert } from "../src/types-ingest";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const CONV = "wechat:conv-1";
const BASE_NOW = "2026-11-07 08:00:00";

let dir: string;
let db: PersonDb;

beforeEach(() => {
  dir = makeTempDir();
  const opened: PersonDb[] = [];
  db = openIn(dir, opened, "persons.sqlite");
  db.prepare(
    `INSERT INTO chat_conversations
       (conversation_id, platform, kind, title, created_at, updated_at)
     VALUES (?, 'wechat', 'direct', '张三', ?, ?)`,
  ).run(CONV, BASE_NOW, BASE_NOW);
});

afterEach(() => {
  closeAll([db]);
  removeTempDir(dir);
});

function row(messageId: string, tsMs: number): StagingInsert {
  return {
    message_id: messageId,
    platform: "wechat",
    sender_id: "wxid_a",
    sender_name: "张三",
    role: "other",
    ts_ms: tsMs,
    msg_date: "2026-11-07",
    content: `msg-${messageId}`,
    content_type: "text",
    reply_to: null,
    meta: "{}",
  };
}

/** 建一个 succeeded 批次（含 staging 行），可选置为已撤销。 */
function batch(batchId: string, messageId: string, opts: { revertedAt?: string; ingestedAt?: string } = {}): void {
  const staging = createStagingRepo(db);
  staging.beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "test",
    tool_version: "v1",
    now: BASE_NOW,
  });
  staging.stageMessages({ batch_id: batchId, conversation_id: CONV, rows: [row(messageId, 1000)], now: BASE_NOW });
  staging.finishBatch({
    batch_id: batchId,
    status: "succeeded",
    conversation_count: 1,
    message_count: 1,
    now: BASE_NOW,
  });
  // 被撤批次自身的消息：ingested_at 早于 reverted_at（不物理删除，天然不满足解除探针）
  createMessagesRepo(db).insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: "wxid_a",
      sender_name: "张三",
      role: "other",
      ts_ms: 1000,
      msg_date: "2026-11-07",
      content: `msg-${messageId}`,
      content_type: "text",
      batch_id: batchId,
      ingested_at: opts.ingestedAt ?? BASE_NOW,
    },
  ]);
  if (opts.revertedAt !== undefined) {
    staging.markBatchReverted({ batch_id: batchId, now: opts.revertedAt });
  }
}

/** 模拟「接受并实际落档一批」：新增一条 chat_messages 行，ingested_at = 落档时刻。 */
function landMessage(messageId: string, ingestedAt: string): void {
  createMessagesRepo(db).insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: "wxid_a",
      sender_name: "张三",
      role: "other",
      ts_ms: 9000,
      msg_date: "2026-11-07",
      content: `msg-${messageId}`,
      content_type: "text",
      batch_id: "b-landed",
      ingested_at: ingestedAt,
    },
  ]);
}

function ids(): string[] {
  return createReviewRequiredRepo(db)
    .listReviewRequiredConversations()
    .map((r) => r.conversation_id);
}

describe("COALESCE(..., '') 与候选集：从未撤销 ⇒ 不复核", () => {
  it("无 reverted 批次：集合空、isReviewRequired=false（julianday('') 恒 NULL，不误判）", () => {
    batch("b1", "m1", { ingestedAt: "2026-11-07 12:00:00" });
    expect(ids()).toEqual([]);
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
  });

  it("有 reverted 批次但无对应 staging 行 ⇒ 不是候选（不误复核别的会话）", () => {
    const staging = createStagingRepo(db);
    staging.beginBatch({
      batch_id: "b-empty",
      platform: "wechat",
      extractor: "test",
      tool_version: "v1",
      now: BASE_NOW,
    });
    staging.markBatchReverted({ batch_id: "b-empty", now: "2026-11-07 10:00:00" });
    expect(ids()).toEqual([]);
  });

  it("撤销后尚未重新落档 ⇒ 需强制复核（防 1B′ 假撤销）", () => {
    batch("b1", "m1", { revertedAt: "2026-11-07T10:00:00.000Z" });
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
    expect(ids()).toEqual([CONV]);
    expect(createReviewRequiredRepo(db).listReviewRequiredConversations()[0]?.last_reverted_at).toBe(
      "2026-11-07T10:00:00.000Z",
    );
  });
});

describe("julianday 格式漂移（11c-1 静默失效陷阱）", () => {
  // 同一时刻的两种写法；字符串比较会得出相反结论，julianday 必须一致。
  const SPACE = "2026-11-07 11:00:00";
  const ISO_Z = "2026-11-07T11:00:00.000Z";
  const REVERT_SPACE = "2026-11-07 10:00:00";
  const REVERT_ISO_Z = "2026-11-07T10:00:00.000Z";

  it.each([
    [REVERT_SPACE, SPACE],
    [REVERT_SPACE, ISO_Z],
    [REVERT_ISO_Z, SPACE], // 字符串比较在这里会判错（' 11' < 'T10'），julianday 仍正确解除
    [REVERT_ISO_Z, ISO_Z],
  ])("reverted_at=%s / ingested_at=%s ⇒ 已落档 ⇒ 判定一致（解除复核）", (revertedAt, ingestedAt) => {
    batch("b1", "m1", { revertedAt });
    landMessage("m-landed", ingestedAt);
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
    expect(ids()).toEqual([]);
  });

  it.each([
    [REVERT_SPACE, "2026-11-07 09:00:00"],
    [REVERT_SPACE, "2026-11-07T09:00:00.000Z"],
    [REVERT_ISO_Z, "2026-11-07 09:00:00"],
    [REVERT_ISO_Z, "2026-11-07T09:00:00.000Z"],
  ])("reverted_at=%s / ingested_at=%s（早于撤销）⇒ 判定一致（仍复核）", (revertedAt, ingestedAt) => {
    batch("b1", "m1", { revertedAt });
    landMessage("m-landed", ingestedAt);
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
    expect(ids()).toEqual([CONV]);
  });

  it("证明探针不是字符串比较：T...Z 撤销 / 空格且更晚落档，必须解除", () => {
    // 字符串序：'2026-11-07 12:00:00' < '2026-11-07T10:00:00.000Z'（空格 < 'T'）
    expect("2026-11-07 12:00:00" > "2026-11-07T10:00:00.000Z").toBe(false);
    batch("b1", "m1", { revertedAt: "2026-11-07T10:00:00.000Z" });
    landMessage("m-landed", "2026-11-07 12:00:00");
    // julianday 正确识别 12:00 > 10:00 ⇒ 解除；字符串比较会错误地保持复核
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
  });

  it("相等时刻（两种格式）不解除：探针是严格 >", () => {
    batch("b1", "m1", { revertedAt: REVERT_SPACE });
    landMessage("m-landed", "2026-11-07T10:00:00.000Z");
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
  });
});

describe("MAX(reverted_at) 粘性：只认最近一次撤销", () => {
  it("两次撤销之间的落档不能解除（取 MAX，否则首次撤销永久压制解除）", () => {
    batch("b1", "m1", { revertedAt: "2026-11-07 10:00:00" });
    landMessage("m-between", "2026-11-07 11:00:00");
    // 第二次撤销（更晚）；若用 MIN/首次撤销，m-between 会误解除
    batch("b2", "m2", { revertedAt: "2026-11-07 12:00:00" });

    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
    expect(createReviewRequiredRepo(db).listReviewRequiredConversations()[0]?.last_reverted_at).toBe(
      "2026-11-07 12:00:00",
    );

    // 真正在「最近一次撤销之后」落档才解除
    landMessage("m-after", "2026-11-07 13:00:00");
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
    expect(ids()).toEqual([]);
  });
});

describe("解除条件 = 接受并实际落档一批（11d / 11f）", () => {
  it("committed=0 && rejected=N（跨批拒绝）：ingested_at 不前移 ⇒ 不解除", () => {
    batch("b1", "m1", { revertedAt: "2026-11-07 10:00:00" });
    // 模拟拒绝：staging 全部置 rejected，但不写任何 chat_messages 行
    createStagingRepo(db).rejectBatch({ batch_id: "b1", now: "2026-11-07 11:00:00" });
    const rowsBefore = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n;

    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
    expect(ids()).toEqual([CONV]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n).toBe(rowsBefore);
  });

  it("粘性：多次重导（只入队、不落档）不会偷偷复原自动信任", () => {
    batch("b1", "m1", { revertedAt: "2026-11-07 10:00:00" });
    // 三次「重导」：新建批次 + staging，但没有任何新 chat_messages 行
    for (let i = 0; i < 3; i += 1) {
      const staging = createStagingRepo(db);
      const id = `reimport-${i}`;
      staging.beginBatch({
        batch_id: id,
        platform: "wechat",
        extractor: "test",
        tool_version: "v1",
        now: "2026-11-07 11:00:00",
      });
      staging.stageMessages({
        batch_id: id,
        conversation_id: CONV,
        rows: [row(`${id}-msg`, 2000 + i)],
        now: "2026-11-07 11:00:00",
      });
      expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(true);
      expect(ids()).toEqual([CONV]);
    }

    // 用户接受并实际落档一批 ⇒ 解除（粘性到此为止）
    landMessage("m-accepted", "2026-11-07 14:00:00");
    expect(createReviewRequiredRepo(db).isReviewRequired(CONV)).toBe(false);
    expect(ids()).toEqual([]);
  });
});

describe("门面公开方法可达（加法式，不改判定链路）", () => {
  let store: PersonStore;

  afterEach(() => {
    store?.close();
  });

  it("PersonStore.listReviewRequiredConversations / isReviewRequired 接线生效", () => {
    store = createPersonStore({
      dbPath: join(dir, "facade.sqlite"),
      encryption: { mode: "none" },
    });
    store.staging.beginBatch({
      batch_id: "b1",
      platform: "wechat",
      extractor: "test",
      tool_version: "v1",
      now: BASE_NOW,
    });
    store.staging.stageMessages({
      batch_id: "b1",
      conversation_id: CONV,
      rows: [row("m1", 1000)],
      now: BASE_NOW,
    });
    store.commitStaged({
      batch_id: "b1",
      conversation_id: CONV,
      proposal_id: "p1",
      now: BASE_NOW,
      conversation: { conversation_id: CONV, platform: "wechat", kind: "direct", title: "张三" },
    });
    store.staging.finishBatch({
      batch_id: "b1",
      status: "succeeded",
      conversation_count: 1,
      message_count: 1,
      now: BASE_NOW,
    });

    expect(store.listReviewRequiredConversations()).toEqual([]);
    expect(store.isReviewRequired(CONV)).toBe(false);

    store.revertBatch({ batch_id: "b1", now: "2026-11-07 10:00:00" });
    expect(store.isReviewRequired(CONV)).toBe(true);
    expect(store.listReviewRequiredConversations().map((r) => r.conversation_id)).toEqual([CONV]);
  });
});
