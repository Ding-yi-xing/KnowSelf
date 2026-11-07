import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createPersonStore, type PersonStore } from "../src/store";
import type { PersonsChangeEvent } from "../src/events";
import type { StagingInsert } from "../src/types-ingest";
import { makeTempDir, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const LATER = "2026-09-10T11:00:00+08:00";
const CONV = "wechat:conv-1";

let dir: string;
let store: PersonStore;

beforeEach(() => {
  dir = makeTempDir();
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
  store.staging.beginBatch({
    batch_id: "b1",
    platform: "wechat",
    extractor: "tarry9110",
    tool_version: "v1",
    now: NOW,
  });
});

afterEach(() => {
  store.close();
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
    content: `msg-${messageId}`,
    content_type: "text",
    reply_to: null,
    meta: "{}",
    ...over,
  };
}

function stage(rows: readonly StagingInsert[]): void {
  store.staging.stageMessages({ batch_id: "b1", conversation_id: CONV, rows, now: NOW });
}

describe("PersonStoreChatApi（DESIGN-11 §7.5 的 9 个能力）", () => {
  it("能力 1/2/3/7：beginBatch、finishBatch、stageMessages、readCursor 在 staging 仓库", () => {
    stage([row("m1", 1000), row("m2", 2000)]);
    expect(store.staging.getBatch("b1")?.status).toBe("running");
    store.staging.finishBatch({
      batch_id: "b1",
      status: "succeeded",
      conversation_count: 1,
      message_count: 2,
      now: LATER,
    });
    expect(store.staging.getBatch("b1")?.message_count).toBe(2);
    expect(store.staging.readCursor("wechat", CONV)).toBeNull();
    expect(store.staging.countByStatus("b1")).toEqual({ staged: 2, committed: 0, rejected: 0 });
  });

  it("能力 4：ensurePersonForUid 幂等（首次建、二次复用且不覆盖 display_name）", () => {
    const first = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_a",
      display_name: "张三",
      now: NOW,
    });
    expect(first.created).toBe(true);
    const second = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_a",
      display_name: "张三改名",
      now: LATER,
    });
    expect(second).toEqual({ person_id: first.person_id, created: false });
    expect(store.getPerson(first.person_id)?.display_name).toBe("张三");
  });

  it("能力 5：commitStaged 落档（消息 append-only / 会话 / 成员 / 游标 / 事件）", () => {
    stage([
      row("m1", 1000, { role: "me", sender_id: "wxid_me", sender_name: "我" }),
      row("m2", 2000),
    ]);
    const events: PersonsChangeEvent[] = [];
    store.onCommitted((event) => events.push(event));

    const result = store.commitStaged({
      batch_id: "b1",
      conversation_id: CONV,
      proposal_id: "p1",
      now: LATER,
      conversation: { conversation_id: CONV, platform: "wechat", kind: "direct", title: "张三" },
    });

    expect(result).toEqual({ committed: 2, skipped: 0 });
    expect(store.messages.get("m1")?.ingested_at).toBe(LATER);
    expect(store.messages.count({ conversation_id: CONV })).toBe(2);
    const conv = store.conversations.get(CONV);
    expect(conv?.msg_count).toBe(2);
    expect(conv?.title).toBe("张三");
    const members = store.conversations.listMembers(CONV);
    expect(members.length).toBe(2);
    expect(members.map((m) => m.person_id)).toContain("me");
    expect(members.map((m) => m.person_id)).toContain(
      store.aliases.resolvePersonId("wechat", "wxid_a"),
    );
    expect(store.staging.readCursor("wechat", CONV)).toEqual({
      last_ts_ms: 2000,
      last_message_id: "m2",
    });
    expect(events.map((e) => e.kind)).toEqual(["messages_committed"]);
    expect(events[0]?.committed).toBe(2);
  });

  it("能力 5 幂等：二次 commitStaged 返回 committed=0 / skipped=N，不新增消息", () => {
    stage([row("m1", 1000)]);
    const input = { batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER };
    expect(store.commitStaged(input)).toEqual({ committed: 1, skipped: 0 });
    expect(store.commitStaged(input)).toEqual({ committed: 0, skipped: 1 });
    expect(store.messages.count({ conversation_id: CONV })).toBe(1);
  });

  it("commitStaged 缺省会话元数据时由 staging 行推导（kind / member_count）", () => {
    stage([row("m1", 1000), row("m2", 2000, { sender_id: "wxid_b", sender_name: "李四" })]);
    store.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER });
    const conv = store.conversations.get(CONV);
    expect(conv?.kind).toBe("direct");
    expect(conv?.member_count).toBe(2);
    expect(conv?.first_msg_at).toBe(new Date(1000).toISOString());
  });

  it("commitStaged 拒绝不存在 / 已回滚的批次（BATCH_INVALID）", () => {
    expect(() =>
      store.commitStaged({
        batch_id: "nope",
        conversation_id: CONV,
        proposal_id: "p1",
        now: LATER,
      }),
    ).toThrow(/批次不存在/);
    store.staging.markBatchReverted({ batch_id: "b1", now: LATER });
    expect(() =>
      store.commitStaged({
        batch_id: "b1",
        conversation_id: CONV,
        proposal_id: "p1",
        now: LATER,
      }),
    ).toThrow(/批次状态不可落档/);
  });

  it("能力 6：rejectStaged 置 rejected 且不落档", () => {
    stage([row("m1", 1000)]);
    expect(
      store.staging.rejectStaged({
        batch_id: "b1",
        conversation_id: CONV,
        proposal_id: "p1",
        now: LATER,
      }),
    ).toEqual({ rejected: 1 });
    expect(store.messages.count()).toBe(0);
    expect(store.staging.countByStatus("b1")).toEqual({ staged: 0, committed: 0, rejected: 1 });
  });

  it("能力 8：revertBatch 保留消息、置 rejected、回退游标、发事件（幂等）", () => {
    store.staging.advanceCursor({
      platform: "wechat",
      conversation_id: CONV,
      last_ts_ms: 500,
      last_message_id: "m0",
      now: NOW,
    });
    store.staging.snapshotCursors({ batch_id: "b1", now: NOW });
    stage([row("m1", 1000)]);
    store.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: NOW });
    expect(store.staging.readCursor("wechat", CONV)?.last_ts_ms).toBe(1000);

    const events: PersonsChangeEvent[] = [];
    store.onCommitted((event) => events.push(event));
    const result = store.revertBatch({ batch_id: "b1", now: LATER });

    expect(result).toEqual({ rejected: 1, restored: 1 });
    expect(store.messages.get("m1")).not.toBeNull();
    expect(store.staging.getBatch("b1")?.status).toBe("reverted");
    expect(store.staging.countByStatus("b1")).toEqual({ staged: 0, committed: 0, rejected: 1 });
    expect(store.staging.readCursor("wechat", CONV)).toEqual({
      last_ts_ms: 500,
      last_message_id: "m0",
    });
    expect(store.revertBatch({ batch_id: "b1", now: LATER })).toEqual({
      rejected: 0,
      restored: 0,
    });
    expect(events.map((e) => e.kind)).toEqual(["batch_reverted", "batch_reverted"]);
  });

  it("能力 9：onCommitted 返回取消订阅函数", () => {
    stage([row("m1", 1000)]);
    const seen: string[] = [];
    const off = store.onCommitted((event) => seen.push(event.kind));
    store.commitStaged({ batch_id: "b1", conversation_id: CONV, proposal_id: "p1", now: LATER });
    off();
    store.staging.markBatchReverted({ batch_id: "b1", now: LATER });
    store.revertBatch({ batch_id: "b1", now: LATER });
    expect(seen).toEqual(["messages_committed"]);
    expect(store.recentChanges().map((e) => e.kind)).toEqual([
      "messages_committed",
      "batch_reverted",
    ]);
  });
});
