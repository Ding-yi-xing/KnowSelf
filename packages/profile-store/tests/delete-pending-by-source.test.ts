/**
 * W-7/D：`deletePendingBySource` 的**真实 SQL** 覆盖。
 *
 * 背景：这个方法在 `packages/ingestion/tests/distill-idempotent.test.ts` 里只被
 * 「调用编排」覆盖（store 是内存桩），真正发出去的 `DELETE … WHERE source_id = ?
 * AND status = 'pending'` 一条 SQL 都没跑过。而它是**唯一会删数据的写操作**，
 * 写错一个条件就会抹掉用户已采纳的历史 —— 必须用真库验证。
 *
 * 测试库用 `:memory:`，不碰 `data/profile.sqlite`，不联网。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createProposalsRepo } from "../src/repository/proposals";
import { createSourcesRepo } from "../src/repository/sources";
import type { IngestionProposal, SourceStored, ProposalStatus } from "@knowself/contracts";

const SOURCE_A = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE_B = "550e8400-e29b-41d4-a716-446655440001";

/** 造一条最小 SourceStored。 */
function makeSource(id: string): SourceStored {
  return {
    id,
    kind: "file" as const,
    original_name: `${id}.pdf`,
    mime_type: "application/pdf" as const,
    file_path: `sources/${id}.pdf`,
    url: null,
    extracted_text: "sample text",
    truncated: false,
    char_count: 11,
    user_note: "",
    user_tags: [],
    status: "raw" as const,
    metadata: {},
    created_at: "2026-05-27T00:00:00.000Z",
    last_ingested_at: null,
    last_error: null,
  };
}

/** 造一条 proposal（id 只需在本次测试内唯一）。 */
function makeProposal(
  id: string,
  sourceId: string,
  status: ProposalStatus,
): IngestionProposal {
  return {
    id,
    source_id: sourceId,
    target: { kind: "core" },
    proposed_body: `body-${id}`,
    reasoning: `reason-${id}`,
    source_excerpts: [],
    produced_by_provider: "deepseek-v4-flash",
    status,
    user_edited_body: null,
    created_at: "2026-05-27T00:00:00.000Z",
    decided_at: status === "pending" ? null : "2026-05-28T00:00:00.000Z",
  };
}

describe("proposals repo · deletePendingBySource（W-7/D）", () => {
  let db: ProfileDb;
  let repo: ReturnType<typeof createProposalsRepo>;

  beforeEach(() => {
    db = openProfileDb(":memory:");
    const sources = createSourcesRepo(db);
    sources.insert(makeSource(SOURCE_A));
    sources.insert(makeSource(SOURCE_B));
    repo = createProposalsRepo(db);

    // source A：3 条 pending + 1 条 accepted + 1 条 rejected
    repo.insertMany([
      makeProposal("p-a-1", SOURCE_A, "pending"),
      makeProposal("p-a-2", SOURCE_A, "pending"),
      makeProposal("p-a-3", SOURCE_A, "pending"),
      makeProposal("p-a-acc", SOURCE_A, "accepted"),
      makeProposal("p-a-rej", SOURCE_A, "rejected"),
      {
        ...makeProposal("p-a-distill", SOURCE_A, "pending"),
        target: {
          kind: "source_distill",
          confidence: 0.4,
          classifier: "dsh-session-rule-v1",
          reason: "review before distilling",
        },
      },
    ]);
    // source B：2 条 pending（验证跨 source 不误伤）
    repo.insertMany([
      makeProposal("p-b-1", SOURCE_B, "pending"),
      makeProposal("p-b-2", SOURCE_B, "pending"),
    ]);
  });

  afterEach(() => {
    db.raw.close();
  });

  it("返回删除条数，且只删该 source 的 pending", () => {
    const removed = repo.deletePendingBySource(SOURCE_A);

    expect(removed).toBe(3);
    const left = repo.listBySource(SOURCE_A);
    expect(left.filter((p) => p.status === "pending")).toHaveLength(1);
    expect(left).toHaveLength(3); // accepted + rejected + source_distill review
    expect(left.find((p) => p.id === "p-a-distill")?.target.kind).toBe("source_distill");
  });

  it("accepted / rejected 的 id 集合前后完全相等（绝不误删历史）", () => {
    const decidedBefore = repo
      .listBySource(SOURCE_A)
      .filter((p) => p.status !== "pending")
      .map((p) => p.id)
      .sort();

    repo.deletePendingBySource(SOURCE_A);

    const decidedAfter = repo
      .listBySource(SOURCE_A)
      .filter((p) => p.status !== "pending")
      .map((p) => p.id)
      .sort();

    expect(decidedAfter).toEqual(decidedBefore);
    expect(decidedAfter).toEqual(["p-a-acc", "p-a-rej"]);
    // 内容也没被动过
    const accepted = repo.get("p-a-acc");
    expect(accepted.proposed_body).toBe("body-p-a-acc");
    expect(accepted.decided_at).not.toBeNull();
  });

  it("另一个 source 的 pending 不受影响", () => {
    repo.deletePendingBySource(SOURCE_A);

    const b = repo.listBySource(SOURCE_B);
    expect(b).toHaveLength(2);
    expect(b.every((p) => p.status === "pending")).toBe(true);
    expect(b.map((p) => p.id).sort()).toEqual(["p-b-1", "p-b-2"]);
  });

  it("无 pending 时返回 0，不抛错、不影响其它行", () => {
    expect(repo.deletePendingBySource(SOURCE_A)).toBe(3);
    // 第二次调用已经没有 pending 了
    expect(repo.deletePendingBySource(SOURCE_A)).toBe(0);
    // 全库仍剩 accepted/rejected + source_distill + B 的 2 条
    expect(repo.countByStatus()).toEqual({ accepted: 1, rejected: 1, pending: 3 });
  });

  it("未知 source 返回 0（幂等，不抛）", () => {
    expect(repo.deletePendingBySource("550e8400-e29b-41d4-a716-44665544ffff")).toBe(0);
    expect(repo.countByStatus()).toEqual({ accepted: 1, rejected: 1, pending: 6 });
  });
});
