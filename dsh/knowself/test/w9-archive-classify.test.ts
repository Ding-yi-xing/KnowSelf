/**
 * 回归：**开关关着时，判定也必须跑**（主理人在全量导入时发现 `classified = 0`）。
 *
 * 根因不是"判定被 enabled 挡住"（那部分写对了），而是**顺序**：
 * 判定原先排在 `auto_commit` **之后**，而 `auto_commit` 会把本批 proposal 全部 accept →
 * 判定再去查 `pending` 时已经空了 → 285 个会话classified 恒为 0。
 *
 * 本用例用真实的顺序问题做断言：同一批里 `auto_commit=true` 且 `enabled=false`，
 * 期望 `classified > 0` 且 `setClassification` 被调到 —— 只要判定还被排在采纳之后，这条必红。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importChat } from "../src/routes/chat-import.js";

/**
 * 造一套能走完整导入流程的桩。
 * @param proposals 本批会"产生"的 proposal（由 ingest 桩主动 create）
 */
function setup(proposals: { id: string; conversation_id: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), "w9-classify-"));
  const setClassification = vi.fn();
  const acceptProposal = vi.fn();

  const stagingRows = Array.from({ length: 30 }, (_, i) => ({
    message_id: `m${i}`,
    sender_id: i % 2 === 0 ? "wxid_a" : "wxid_b",
    role: i % 2 === 0 ? "other" : "other",
    content: "今天吃什么",
    content_type: "text",
  }));

  const personStore = {
    listPersons: () => [{ person_id: "me" }],
    conversations: { list: () => [], get: () => ({ kind: "direct", title: "某人" }) },
    messages: { count: () => 0, countUnattributed: () => 0, countBySenderId: () => 0 },
    aliases: { upsertExtractor: () => ({ created: false }) },
    staging: { listStaged: () => stagingRows },
  };

  const services = {
    personStore,
    ingestion: {
      acceptProposal,
      // 未传 source_id 时导入会先 createSource（与真人路径一致）
      createSource: async () => ({ id: "src-1" }),
      listProposalsByStatus: () =>
        proposals.map((p) => ({
          ...p,
          source_id: "src-1",
          target: { kind: "chat_message", conversation_id: p.conversation_id },
        })),
    },
    profileStore: {
      sources: { get: () => ({ id: "src-1" }) },
      proposals: {
        insertMany: vi.fn(),
        listByStatus: (status: string) =>
          status === "pending"
            ? proposals.map((p) => ({
                id: p.id,
                source_id: "src-1",
                target: { kind: "chat_message", conversation_id: p.conversation_id },
                status: "pending",
              }))
            : [],
        setClassification,
      },
    },
    // 开关**关着**：判定要跑，采纳不要跑（本用例里 auto_commit 才负责采纳）
    settings: { auto_archive: { enabled: false } },
  } as never;

  const ingest = vi.fn(async (opts: { proposalSink: { create: (draft: unknown) => void } }) => {
    for (const p of proposals) {
      opts.proposalSink.create({
        id: p.id,
        source_id: "src-1",
        target: { kind: "chat_message", conversation_id: p.conversation_id, message_ids: ["m1"] },
        proposed_body: "摘要",
        reasoning: "",
        source_excerpts: [],
        produced_by_provider: "chat-ingest",
        status: "pending",
        user_edited_body: null,
        created_at: "2026-11-22T00:00:00.000Z",
        decided_at: null,
      });
    }
    return {
      batch_id: "b1",
      reader_id: "txt",
      conversation_count: proposals.length,
      message_count: 30,
      committed: 30,
      skipped: 0,
      tier: { auto: 0, review: proposals.length },
    };
  });

  const mine = vi.fn(async () => ({
    snapshotId: "snap-1",
    persons: 1,
    scopes: 1,
    upserted: 1,
    skippedLocked: 0,
    pruned: 0,
    warnings: [],
    intentsWritten: 0,
    graph: { snapshot: { nodes: [], edges: [] }, warnings: [] },
  }));

  return { dir, services, ingest, mine, setClassification, acceptProposal };
}

describe("auto_archive：开关只控制采纳，不控制判定", () => {
  it("enabled=false + auto_commit=true → 仍然完成判定（classified > 0）", async () => {
    const { dir, services, ingest, mine, setClassification } = setup([
      { id: "p1", conversation_id: "wechat:c1" },
    ]);

    const res = await importChat(
      services,
      { source_path: dir, auto_commit: true, auto_commit_reason: "regression" },
      { ingest: ingest as never, mine: mine as never },
    );

    const body = res.body as { auto_archive: { classified: number; by_rule: number; auto_accepted: number } };
    // 判定发生在采纳之前 → 能看到 pending
    expect(body.auto_archive.classified).toBe(1);
    expect(body.auto_archive.by_rule).toBe(1);
    // 开关关着 → 判定结果不触发自动采纳（采纳来自显式的 auto_commit）
    expect(body.auto_archive.auto_accepted).toBe(0);
    expect(setClassification).toHaveBeenCalledWith("p1", expect.objectContaining({ target: "person" }));
  });
});
