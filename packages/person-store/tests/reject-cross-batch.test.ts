/**
 * reject-cross-batch.test.ts — 批 1.5 跨批精确拒绝（真实 persons.sqlite）
 *
 * 背景：`chat_message_staging` 的 PK 是 `(batch_id, conversation_id, message_id)`，
 * 同一消息在不同批次是**不同行**。月度重导 90% 重叠时，只拒当期批次会让被拒内容
 * 从更新批次再次落档——「拒绝的有效期只有一个导入周期」。
 *
 * 覆盖：跨批全拒 / 内容级不变量 / committed 不回退 / running 批次保守失败 / 空入参。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PersonDb } from "../src/db";
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
    msg_date: "2026-09-10",
    content: "hi",
    content_type: "text",
    reply_to: null,
    meta: "{}",
  };
}

function openBatch(batchId: string, ids: readonly string[], succeed: boolean): void {
  repo.beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "tarry9110",
    tool_version: "v1",
    now: NOW,
  });
  repo.stageMessages({
    batch_id: batchId,
    conversation_id: CONV,
    rows: ids.map((id, i) => row(id, 1000 + i * 1000)),
    now: NOW,
  });
  if (succeed) {
    repo.finishBatch({
      batch_id: batchId,
      status: "succeeded",
      conversation_count: 1,
      message_count: ids.length,
      now: LATER,
    });
  }
}

describe("rejectStagedCrossBatch（批 1.5）", () => {
  it("同一消息在两个 succeeded 批次 → 全部置 rejected，remaining_staged=0", () => {
    openBatch("b1", ["m1", "m2"], true);
    openBatch("b2", ["m1", "m2", "m3"], true);

    const result = repo.rejectStagedCrossBatch({
      conversation_id: CONV,
      proposal_id: "p1",
      message_ids: ["m1", "m2"],
      now: LATER,
    });

    // b1 两行 + b2 两行 = 4 行；m3 不受影响
    expect(result).toEqual({ rejected: 4, remaining_staged: 0 });
    expect(repo.countByStatus("b1")).toEqual({ staged: 0, committed: 0, rejected: 2 });
    expect(repo.countByStatus("b2")).toEqual({ staged: 1, committed: 0, rejected: 2 });
  });

  it("只影响目标 message_ids，其它会话/消息不受影响", () => {
    openBatch("b1", ["m1", "m2"], true);
    repo.stageMessages({
      batch_id: "b1",
      conversation_id: "wechat:other",
      rows: [row("m1", 9000)],
      now: NOW,
    });

    const result = repo.rejectStagedCrossBatch({
      conversation_id: CONV,
      proposal_id: "p1",
      message_ids: ["m1"],
      now: LATER,
    });

    expect(result).toEqual({ rejected: 1, remaining_staged: 0 });
    const other = repo.listStaged({ batch_id: "b1", conversation_id: "wechat:other" });
    expect(other[0]?.status).toBe("staged");
  });

  it("已 committed 的行不被回退（落档单向性），staged 行仍被拒", () => {
    openBatch("b1", ["m1", "m2"], true);
    repo.commitStaged({
      batch_id: "b1",
      conversation_id: CONV,
      proposal_id: "p-accept",
      now: LATER,
    });
    openBatch("b2", ["m1", "m2"], true);

    const result = repo.rejectStagedCrossBatch({
      conversation_id: CONV,
      proposal_id: "p1",
      message_ids: ["m1", "m2"],
      now: LATER,
    });

    expect(result.rejected).toBe(2); // 只拒 b2 的 staged 行
    expect(result.remaining_staged).toBe(0);
    expect(repo.countByStatus("b1").committed).toBe(2); // b1 已落档，不回退
  });

  it("running 批次的行不被改，且如实上报 remaining_staged（供内容级不变量抛错）", () => {
    openBatch("b1", ["m1"], true);
    openBatch("b2", ["m1"], false); // 仍 running

    const result = repo.rejectStagedCrossBatch({
      conversation_id: CONV,
      proposal_id: "p1",
      message_ids: ["m1"],
      now: LATER,
    });

    expect(result.rejected).toBe(1);
    expect(result.remaining_staged).toBe(1);
    expect(repo.countByStatus("b2").staged).toBe(1);
  });

  it("幂等：重复调用 rejected=0，remaining_staged 仍为 0", () => {
    openBatch("b1", ["m1"], true);
    const q = { conversation_id: CONV, proposal_id: "p1", message_ids: ["m1"], now: LATER };
    expect(repo.rejectStagedCrossBatch(q).rejected).toBe(1);
    expect(repo.rejectStagedCrossBatch(q)).toEqual({ rejected: 0, remaining_staged: 0 });
  });

  it("空 message_ids → 不动任何行", () => {
    openBatch("b1", ["m1"], true);
    expect(
      repo.rejectStagedCrossBatch({
        conversation_id: CONV,
        proposal_id: "p1",
        message_ids: [],
        now: LATER,
      }),
    ).toEqual({ rejected: 0, remaining_staged: 0 });
    expect(repo.countByStatus("b1").staged).toBe(1);
  });

  it("旧 rejectStaged 保持会话级语义（零回归）", () => {
    openBatch("b1", ["m1", "m2"], true);
    openBatch("b2", ["m1"], true);
    expect(
      repo.rejectStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER }),
    ).toEqual({ rejected: 2 });
    expect(repo.countByStatus("b2").staged).toBe(1);
  });
});
