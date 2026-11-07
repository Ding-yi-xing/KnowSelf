import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PersonDb } from "../src/db";
import { createMessagesRepo } from "../src/repository/messages";
import { createStagingRepo, type StagingRepo } from "../src/repository/staging";
import type { StagingInsert } from "../src/types-ingest";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const LATER = "2026-09-10T11:00:00+08:00";
const CONV = "wechat:conv-1";

let dir: string;
let db: PersonDb;
let repo: StagingRepo;

beforeEach(() => {
  dir = makeTempDir();
  const opened: PersonDb[] = [];
  db = openIn(dir, opened, "persons.sqlite");
  repo = createStagingRepo(db);
  repo.beginBatch({
    batch_id: "b1",
    platform: "wechat",
    extractor: "tarry9110",
    tool_version: "v1",
    now: NOW,
  });
});

afterEach(() => {
  closeAll([db]);
  removeTempDir(dir);
});

function row(messageId: string, tsMs: number, over: Partial<StagingInsert> = {}): StagingInsert {
  return {
    message_id: messageId,
    platform: "wechat",
    sender_id: "wxid_a",
    sender_name: "张三",
    role: "other",
    ts_ms: tsMs,
    msg_date: "2026-09-10",
    content: "hi",
    content_type: "text",
    reply_to: null,
    meta: "{}",
    ...over,
  };
}

describe("staging repo — 批次", () => {
  it("beginBatch / getBatch / finishBatch / listBatches", () => {
    expect(repo.getBatch("b1")?.status).toBe("running");
    expect(repo.getBatch("missing")).toBeNull();
    repo.finishBatch({
      batch_id: "b1",
      status: "succeeded",
      conversation_count: 1,
      message_count: 2,
      skipped_count: 3,
      now: LATER,
    });
    const batch = repo.getBatch("b1");
    expect(batch?.status).toBe("succeeded");
    expect(batch?.message_count).toBe(2);
    expect(batch?.skipped_count).toBe(3);
    expect(batch?.finished_at).toBe(LATER);
    expect(repo.listBatches({ status: "succeeded" }).length).toBe(1);
    expect(repo.listBatches({ status: "failed" })).toEqual([]);
    expect(repo.listBatches({ limit: 1 }).length).toBe(1);
  });
});

describe("staging repo — staging 行", () => {
  it("stageMessages 幂等（L1）：二次 stage 全部 ignored", () => {
    const rows = [row("m1", 1000), row("m2", 2000)];
    expect(repo.stageMessages({ batch_id: "b1", conversation_id: CONV, rows, now: NOW })).toEqual({
      inserted: 2,
      ignored: 0,
    });
    expect(repo.stageMessages({ batch_id: "b1", conversation_id: CONV, rows, now: NOW })).toEqual({
      inserted: 0,
      ignored: 2,
    });
    expect(repo.listStaged({ batch_id: "b1", conversation_id: CONV }).length).toBe(2);
    expect(repo.countByStatus("b1")).toEqual({ staged: 2, committed: 0, rejected: 0 });
  });

  it("markTier 写入 tier / reason_codes；listStaged 支持 status 过滤", () => {
    repo.stageMessages({
      batch_id: "b1",
      conversation_id: CONV,
      rows: [row("m1", 1000)],
      now: NOW,
    });
    expect(
      repo.markTier({
        batch_id: "b1",
        conversation_id: CONV,
        items: [{ message_id: "m1", tier: "auto", reason_codes: [] }],
        now: LATER,
      }),
    ).toEqual({ updated: 1 });
    const staged = repo.listStaged({ batch_id: "b1", status: "staged" });
    expect(staged[0]?.tier).toBe("auto");
    expect(staged[0]?.reason_codes).toBe("[]");
    expect(repo.listStaged({ batch_id: "b1", status: "committed" })).toEqual([]);
    expect(repo.listStaged({ batch_id: "b1", limit: 1 }).length).toBe(1);
  });

  it("commitStaged / rejectStaged / rejectBatch 的状态与幂等回报", () => {
    repo.stageMessages({
      batch_id: "b1",
      conversation_id: CONV,
      rows: [row("m1", 1000), row("m2", 2000)],
      now: NOW,
    });
    expect(
      repo.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER }),
    ).toEqual({ committed: 2, skipped: 0 });
    expect(
      repo.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER }),
    ).toEqual({ committed: 0, skipped: 2 });
    expect(repo.listStaged({ batch_id: "b1", status: "committed" })[0]?.proposal_id).toBe("p1");

    expect(repo.rejectBatch({ batch_id: "b1", now: LATER })).toEqual({ rejected: 2 });
    expect(repo.countByStatus("b1")).toEqual({ staged: 0, committed: 0, rejected: 2 });
    expect(repo.rejectBatch({ batch_id: "b1", now: LATER })).toEqual({ rejected: 0 });
  });

  it("rejectStaged 只拒绝 staged 行（不碰 committed）", () => {
    repo.stageMessages({
      batch_id: "b1",
      conversation_id: CONV,
      rows: [row("m1", 1000), row("m2", 2000)],
      now: NOW,
    });
    repo.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER });
    repo.stageMessages({
      batch_id: "b1",
      conversation_id: CONV,
      rows: [row("m3", 3000)],
      now: LATER,
    });
    expect(
      repo.rejectStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p2", now: LATER }),
    ).toEqual({ rejected: 1 });
    expect(repo.countByStatus("b1")).toEqual({ staged: 0, committed: 2, rejected: 1 });
  });
});

describe("staging repo — 游标", () => {
  it("advanceCursor 单调不回退；readCursor 返回最大 (ts, id)", () => {
    expect(repo.readCursor("wechat", CONV)).toBeNull();
    repo.advanceCursor({
      platform: "wechat",
      conversation_id: CONV,
      last_ts_ms: 2000,
      last_message_id: "m2",
      now: NOW,
    });
    repo.advanceCursor({
      platform: "wechat",
      conversation_id: CONV,
      last_ts_ms: 1000,
      last_message_id: "m1",
      now: LATER,
    });
    expect(repo.readCursor("wechat", CONV)).toEqual({ last_ts_ms: 2000, last_message_id: "m2" });
    repo.advanceCursor({
      platform: "wechat",
      conversation_id: CONV,
      last_ts_ms: 3000,
      last_message_id: "m3",
      now: LATER,
    });
    expect(repo.readCursor("wechat", CONV)).toEqual({ last_ts_ms: 3000, last_message_id: "m3" });
  });

  it("snapshotCursors / restoreCursors：回退到快照（唯一允许回退的路径）", () => {
    repo.advanceCursor({
      platform: "wechat",
      conversation_id: CONV,
      last_ts_ms: 1000,
      last_message_id: "m1",
      now: NOW,
    });
    expect(repo.snapshotCursors({ batch_id: "b1", now: NOW })).toEqual({ rows: 1 });
    repo.advanceCursor({
      platform: "wechat",
      conversation_id: CONV,
      last_ts_ms: 5000,
      last_message_id: "m5",
      now: LATER,
    });
    expect(repo.restoreCursors({ batch_id: "b1", now: LATER })).toEqual({ restored: 1 });
    expect(repo.readCursor("wechat", CONV)).toEqual({ last_ts_ms: 1000, last_message_id: "m1" });
  });
});

describe("staging repo — 对账与清理", () => {
  it("reconcile 检出双向不一致；已回滚批次不算不一致", () => {
    repo.beginBatch({
      batch_id: "b2",
      platform: "wechat",
      extractor: "tarry9110",
      tool_version: "v1",
      now: NOW,
    });
    repo.markBatchReverted({ batch_id: "b2", now: NOW });
    db.prepare(
      `INSERT INTO chat_conversations (conversation_id, platform, kind, title, created_at, updated_at)
       VALUES (?, 'wechat', 'direct', '张三', ?, ?)`,
    ).run(CONV, NOW, NOW);
    repo.stageMessages({
      batch_id: "b1",
      conversation_id: CONV,
      rows: [row("m1", 1000)],
      now: NOW,
    });
    repo.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER });
    // m2 只进 chat_messages（b1 的 staging 未 committed），m1 只 committed 无消息
    createMessagesRepo(db).insertOrIgnore([
      {
        message_id: "m2",
        conversation_id: CONV,
        platform: "wechat",
        sender_id: "wxid_a",
        role: "other",
        ts_ms: 2000,
        msg_date: "2026-09-10",
        batch_id: "b1",
        ingested_at: NOW,
      },
      {
        message_id: "m9",
        conversation_id: CONV,
        platform: "wechat",
        sender_id: "wxid_a",
        role: "other",
        ts_ms: 9000,
        msg_date: "2026-09-10",
        batch_id: "b2",
        ingested_at: NOW,
      },
    ]);
    const issues = repo.reconcile({ batch_id: "b1" }).map((r) => `${r.message_id}:${r.issue}`);
    expect(issues).toContain("m1:staging_committed_without_message");
    expect(issues).toContain("m2:message_without_staging");
    expect(issues.some((issue) => issue.startsWith("m9:"))).toBe(false);
    expect(repo.reconcile({ batch_id: "b1", limit: 1 }).length).toBe(1);
  });

  it("pruneCommitted 只清理早于阈值的 committed 行", () => {
    repo.stageMessages({
      batch_id: "b1",
      conversation_id: CONV,
      rows: [row("m1", 1000)],
      now: NOW,
    });
    repo.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: NOW });
    expect(repo.pruneCommitted({ before: NOW })).toEqual({ deleted: 0 });
    expect(repo.pruneCommitted({ before: LATER })).toEqual({ deleted: 1 });
    expect(repo.listStaged({ batch_id: "b1" })).toEqual([]);
  });
});
