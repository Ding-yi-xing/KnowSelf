/**
 * 批 2b —— CLI 回滚出口（--revert）的准入 / 输出 / 注入点。
 *
 * 只 import `../src/cli/revert`（无副作用）；不 import `ingest-chat.ts`
 * （它末尾直接 main()，会把 vitest 的 argv 喂给 parseArgs 并 process.exit）。
 *
 * 覆盖验收 7：拒绝非最近 succeeded 批次、回滚后不复用原 batch_id；
 * 以及「restored=0 不得用成功文案掩盖」「索引重建失败要可见」。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchInvalidError, createPersonStore, type PersonStore } from "@knowself/person-store";
import {
  assertRevertable,
  conversationIdsOfBatch,
  deriveTierConfig,
  formatRevertOutput,
  RevertCommandError,
  runRevert,
  type RevertOutcome,
} from "../src/cli/revert";

const T0 = "2026-11-07 08:00:00";
const T1 = "2026-11-07 09:00:00";
const T2 = "2026-11-07 10:00:00";
const T3 = "2026-11-07T11:00:00.000Z";
const CONV = "wechat:conv-1";

let dir: string;
let store: PersonStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-revert-cli-"));
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
  // chat_messages.conversation_id 有 FK → 先建会话行
  store.conversations.upsertFromCommit(
    { conversation_id: CONV, platform: "wechat", kind: "direct", title: "张三" },
    T0,
  );
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function succeeded(batchId: string, now: string): void {
  store.staging.beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "test",
    tool_version: "v1",
    now,
  });
  store.staging.stageMessages({
    batch_id: batchId,
    conversation_id: CONV,
    rows: [
      {
        message_id: `m-${batchId}`,
        platform: "wechat",
        sender_id: "wxid_a",
        sender_name: "张三",
        role: "other",
        ts_ms: 1000,
        msg_date: "2026-11-07",
        content: `msg-${batchId}`,
        content_type: "text",
        reply_to: null,
        meta: "{}",
      },
    ],
    now,
  });
  store.staging.finishBatch({
    batch_id: batchId,
    status: "succeeded",
    conversation_count: 1,
    message_count: 1,
    now,
  });
}

describe("--revert 准入：只撤最近一个 succeeded 批次", () => {
  it("拒绝非最近 succeeded 批次（更早的批次、不存在的批次、running 批次）", () => {
    succeeded("b1", T0);
    succeeded("b2", T1);
    store.staging.beginBatch({
      batch_id: "b3-running",
      platform: "wechat",
      extractor: "test",
      tool_version: "v1",
      now: T2,
    });

    expect(() => assertRevertable(store, "b1")).toThrow(RevertCommandError);
    expect(() => assertRevertable(store, "b1")).toThrow(/最近一个 succeeded/);
    expect(() => assertRevertable(store, "nope")).toThrow(/批次不存在/);
    expect(() => assertRevertable(store, "b3-running")).toThrow(/只有 succeeded 可撤销/);
    expect(assertRevertable(store, "b2").batch_id).toBe("b2");
  });

  it("回滚后原 batch_id 不可复用：assertBatchOpen 抛 BatchInvalidError", async () => {
    succeeded("b1", T0);
    const outcome = await runRevert(
      { store, now: T2, rebuildChatIndex: async () => ({ chunkCount: 0, conversationCount: 0 }) },
      "b1",
    );
    expect(outcome.batch_id).toBe("b1");
    expect(store.staging.getBatch("b1")?.status).toBe("reverted");

    expect(() =>
      store.commitStaged({
        batch_id: "b1",
        conversation_id: CONV,
        proposal_id: "p-reuse",
        now: T3,
      }),
    ).toThrow(BatchInvalidError);
    // 回滚后该批次也不再是可撤销候选
    expect(() => assertRevertable(store, "b1")).toThrow(RevertCommandError);
  });
});

describe("runRevert：按受影响会话重建索引，失败要可见", () => {
  it("把该批涉及的 conversationIds 传给 buildChatIndex({conversationIds})，且如实回传 restored", async () => {
    succeeded("b1", T0);
    const rebuild = vi.fn(async () => ({ chunkCount: 7, conversationCount: 1 }));

    const outcome = await runRevert(
      { store, now: T2, rebuildChatIndex: rebuild },
      "b1",
    );

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith([CONV]); // 调用方（CLI）侧按会话重建，不塞进 person-store
    expect(conversationIdsOfBatch(store, "b1")).toEqual([CONV]);
    expect(outcome).toMatchObject({
      batch_id: "b1",
      rejected: 1,
      index_chunks: 7,
      index_conversations: 1,
      conversation_ids: [CONV],
    });
    expect(typeof outcome.restored).toBe("number");
  });

  it("索引重建失败不静默吞：revertBatch 已生效但错误必须冒泡", async () => {
    succeeded("b1", T0);
    const rebuild = vi.fn(async () => {
      throw new Error("retrieval.sqlite 被占用");
    });

    await expect(
      runRevert({ store, now: T2, rebuildChatIndex: rebuild }, "b1"),
    ).rejects.toThrow(/retrieval\.sqlite 被占用/);
    expect(store.staging.getBatch("b1")?.status).toBe("reverted");
  });
});

describe("输出如实反映 restored，不用「成功」掩盖 0", () => {
  const base: RevertOutcome = {
    batch_id: "b1",
    rejected: 1,
    restored: 0,
    conversation_ids: [CONV],
    index_chunks: 0,
    index_conversations: 0,
  };

  it("restored=0 明确写 0 与「未回退任何游标」，且不含「成功」", () => {
    const lines = formatRevertOutput(base).join("\n");
    expect(lines).toContain("restored=0");
    expect(lines).toContain("未回退任何游标");
    expect(lines).not.toContain("成功");
    expect(lines).toContain("请用新批次重导");
  });

  it("restored>0 显示真实数字", () => {
    const lines = formatRevertOutput({ ...base, restored: 3 }).join("\n");
    expect(lines).toContain("restored=3");
    expect(lines).not.toContain("未回退任何游标");
  });
});

describe("deriveTierConfig：装配层把「因撤销待复核」合并进 review（注入点可达）", () => {
  it("撤销后 review 自动包含该会话（命中 MANUAL_FLAG ⇒ Tier B），去重且不改 auto_ok", () => {
    succeeded("b1", T0);
    store.revertBatch({ batch_id: "b1", now: T2 });
    expect(store.isReviewRequired(CONV)).toBe(true);

    const derived = deriveTierConfig({ auto_ok: ["keep"], review: ["manual"] }, store);
    expect(derived.auto_ok).toEqual(["keep"]);
    expect(derived.review).toContain(CONV);
    expect(derived.review).toContain("manual");
    expect(new Set(derived.review).size).toBe(derived.review?.length);

    // 人工落档一批（新消息 ingested_at > reverted_at）后解除 ⇒ review 不再含该会话
    store.messages.insertOrIgnore([
      {
        message_id: "m-landed",
        conversation_id: CONV,
        platform: "wechat",
        sender_id: "wxid_a",
        sender_name: "张三",
        role: "other",
        ts_ms: 9000,
        msg_date: "2026-11-07",
        content: "landed",
        content_type: "text",
        batch_id: "b-landed",
        ingested_at: T3,
      },
    ]);
    expect(store.isReviewRequired(CONV)).toBe(false);
    expect(deriveTierConfig({}, store).review).toEqual([]);
  });
});
