import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore, type StagingInsert } from "@knowself/person-store";
import { createChatMessageCommitter, type ChatMessageCommitTargetLike } from "../src/committer";
import { isChatIngestError } from "../src/errors";

const NOW = "2026-09-10T10:00:00+08:00";
const BATCH = "10000000-0000-0000-0000-000000000001";
const CONV = "wechat:wxid_aaaaaaaaaaaa22";
const TS = new Date("2024-01-02T13:45:00+08:00").getTime();

let dir: string;
let store: PersonStore;
const scratch: string[] = [];

function rows(): StagingInsert[] {
  return [0, 1].map((index) => ({
    message_id: `${CONV}:m${index}`,
    platform: "wechat",
    sender_id: "name:张三",
    sender_name: "张三",
    role: "other",
    ts_ms: TS + index * 1000,
    msg_date: "2024-01-02",
    content: `第 ${index} 条`,
    content_type: "text",
    reply_to: null,
    meta: JSON.stringify({ extra: { sender_id_is_pseudo: true } }),
  }));
}

function target(messageIds: readonly string[]): ChatMessageCommitTargetLike {
  return {
    kind: "chat_message",
    batch_id: BATCH,
    conversation_id: CONV,
    message_ids: messageIds,
    tier: "auto",
    reason_codes: [],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-chat-committer-"));
  scratch.push(dir);
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
  store.staging.beginBatch({
    batch_id: BATCH,
    platform: "wechat",
    extractor: "test-reader",
    tool_version: "1",
    now: NOW,
  });
  store.staging.stageMessages({
    batch_id: BATCH,
    conversation_id: CONV,
    rows: rows(),
    now: NOW,
  });
});

afterEach(() => {
  store.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ChatMessageCommitter（DESIGN-11 §7.3 / §8.4 场景 ②）", () => {
  it("首次 commit 落档；重复 commit 幂等返回 skipped > 0 且不抛错", () => {
    const committer = createChatMessageCommitter(store);
    const input = {
      proposal_id: "20000000-0000-0000-0000-000000000001",
      source_id: "00000000-0000-0000-0000-000000000001",
      target: target([`${CONV}:m0`, `${CONV}:m1`]),
      now: NOW,
    };

    const first = committer.commit(input);
    expect(first).toEqual({ committed: 2, skipped: 0 });
    expect(store.messages.count({ conversation_id: CONV })).toBe(2);

    const second = committer.commit(input);
    expect(second.committed).toBe(0);
    expect(second.skipped).toBe(2);
    expect(store.messages.count({ conversation_id: CONV })).toBe(2);
  });

  it("落档后 staging 置 committed 且记录 proposal_id（可回溯，D4）", () => {
    const committer = createChatMessageCommitter(store);
    committer.commit({
      proposal_id: "20000000-0000-0000-0000-000000000002",
      source_id: "00000000-0000-0000-0000-000000000001",
      target: target([`${CONV}:m0`]),
      now: NOW,
    });
    const rowsAfter = store.staging.listStaged({ batch_id: BATCH, conversation_id: CONV });
    expect(rowsAfter.every((row) => row.status === "committed")).toBe(true);
    expect(rowsAfter.every((row) => row.proposal_id === "20000000-0000-0000-0000-000000000002")).toBe(
      true,
    );
  });

  it("staging 缺消息 → COMMIT_FAILED（不静默落档）", () => {
    const committer = createChatMessageCommitter(store);
    let thrown: unknown = null;
    try {
      committer.commit({
        proposal_id: "20000000-0000-0000-0000-000000000003",
        source_id: "00000000-0000-0000-0000-000000000001",
        target: target([`${CONV}:missing`]),
        now: NOW,
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(isChatIngestError(thrown)).toBe(true);
    if (isChatIngestError(thrown)) expect(thrown.code).toBe("COMMIT_FAILED");
    expect(store.messages.count()).toBe(0);
  });

  it("空 message_ids / 超 2000 条 → INVALID_TARGET_REF（contracts 约束）", () => {
    const committer = createChatMessageCommitter(store);
    const base = {
      proposal_id: "20000000-0000-0000-0000-000000000004",
      source_id: "00000000-0000-0000-0000-000000000001",
      now: NOW,
    };
    expect(() => committer.commit({ ...base, target: target([]) })).toThrow();
    expect(() =>
      committer.commit({
        ...base,
        target: target(Array.from({ length: 2001 }, (_, i) => `id-${i}`)),
      }),
    ).toThrow();
  });

  it("恰好 2000 条 → 允许（边界内），全部落档", () => {
    const BATCH2 = "10000000-0000-0000-0000-000000000002";
    store.staging.beginBatch({
      batch_id: BATCH2,
      platform: "wechat",
      extractor: "test-reader",
      tool_version: "1",
      now: NOW,
    });
    const many: StagingInsert[] = Array.from({ length: 2000 }, (_, index) => ({
      message_id: `${CONV}:bulk-${String(index).padStart(4, "0")}`,
      platform: "wechat",
      sender_id: "name:张三",
      sender_name: "张三",
      role: "other",
      ts_ms: TS + index,
      msg_date: "2024-01-02",
      content: `第 ${index} 条`,
      content_type: "text",
      reply_to: null,
      meta: "{}",
    }));
    store.staging.stageMessages({ batch_id: BATCH2, conversation_id: CONV, rows: many, now: NOW });

    const committer = createChatMessageCommitter(store);
    const result = committer.commit({
      proposal_id: "20000000-0000-0000-0000-000000000005",
      source_id: "00000000-0000-0000-0000-000000000001",
      target: {
        ...target(many.map((row) => row.message_id)),
        batch_id: BATCH2,
      },
      now: NOW,
    });
    expect(result).toEqual({ committed: 2000, skipped: 0 });
    // 本测试只 commit 了 BATCH2；BATCH 的 2 行仍是 staged，未落档
    expect(store.messages.count({ conversation_id: CONV })).toBe(2000);
  });

  it("换 proposal_id 重试仍幂等：不回退已落档行、不改写 staging.proposal_id（§8.4 场景 ②）", () => {
    const committer = createChatMessageCommitter(store);
    const firstProposal = "20000000-0000-0000-0000-000000000006";
    committer.commit({
      proposal_id: firstProposal,
      source_id: "00000000-0000-0000-0000-000000000001",
      target: target([`${CONV}:m0`, `${CONV}:m1`]),
      now: NOW,
    });

    const retry = committer.commit({
      proposal_id: "20000000-0000-0000-0000-000000000007",
      source_id: "00000000-0000-0000-0000-000000000001",
      target: target([`${CONV}:m0`, `${CONV}:m1`]),
      now: NOW,
    });
    expect(retry).toEqual({ committed: 0, skipped: 2 });
    expect(store.messages.count({ conversation_id: CONV })).toBe(2);
    // 审计链不被重试污染：仍指向首次 accept 的 proposal
    const rowsAfter = store.staging.listStaged({ batch_id: BATCH, conversation_id: CONV });
    expect(rowsAfter.every((row) => row.proposal_id === firstProposal)).toBe(true);
  });

  it("批次不存在 → COMMIT_FAILED（不静默成功）", () => {
    const committer = createChatMessageCommitter(store);
    let thrown: unknown = null;
    try {
      committer.commit({
        proposal_id: "20000000-0000-0000-0000-000000000008",
        source_id: "00000000-0000-0000-0000-000000000001",
        target: { ...target([`${CONV}:m0`]), batch_id: "not-a-batch" },
        now: NOW,
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(isChatIngestError(thrown)).toBe(true);
    if (isChatIngestError(thrown)) expect(thrown.code).toBe("COMMIT_FAILED");
    expect(store.messages.count({ conversation_id: CONV })).toBe(0);
  });

  it("target.kind 非 chat_message → INVALID_TARGET_REF（不落档）", () => {
    const committer = createChatMessageCommitter(store);
    expect(() =>
      committer.commit({
        proposal_id: "20000000-0000-0000-0000-000000000009",
        source_id: "00000000-0000-0000-0000-000000000001",
        target: { ...target([`${CONV}:m0`]), kind: "person_fact" as unknown as "chat_message" },
        now: NOW,
      }),
    ).toThrow();
    expect(store.messages.count({ conversation_id: CONV })).toBe(0);
  });
});
