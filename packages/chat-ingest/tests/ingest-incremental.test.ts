/**
 * 增量采集端到端（DESIGN-11 §5.2 / §5.3 / §9.3 T2·T3；§9.2 `IncrementalFilter` / `CursorStore` 行）。
 *
 * 断言全部来自条文：
 *   - §5.2 过滤规则（首采全收 / ts > / ts == 且 id > / 其余丢弃）；
 *   - §5.3 L3「游标只在落档事务提交后推进」「`last_ts_ms = MAX(existing, incoming)`」；
 *   - §6.2 规则 3「`TS_REGRESSION` → 不推进游标」。
 *
 * 为了只验证增量层本身，用例**预置会话行**（否则 NEW_CONVERSATION 会让整批进队列，
 * 掩盖游标行为）。数据全部为合成内容（§9.1 铁律 2）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import { createChatMessageCommitter, type ChatMessageCommitterLike } from "../src/committer";
import { advanceCursorState } from "../src/cursor";
import { ingestExport, type IngestProposalSink, type IngestExportResult } from "../src/index";
import type { ChatIngestProposalDraft, PendingProposalRef } from "../src/proposal";
import { NOW } from "./fixtures";

const CONV = "wechat:wxid_aaaaaaaaaaaa22";
const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";
const TS = new Date("2024-01-02T13:45:00+08:00").getTime();

/** 合成消息：content 用「第 N 条」占位，不含任何真实聊天内容（§9.1）。 */
function syntheticMessage(index: number, over: Record<string, unknown> = {}) {
  const other = index % 2 === 0;
  return {
    message_id: `m${String(index).padStart(3, "0")}`,
    ts_ms: TS + index * 1000,
    sender_id: other ? "name:张三" : undefined,
    sender_name: other ? "张三" : "我",
    role: other ? "other" : "me",
    content: `第 ${index} 条合成消息`,
    content_type: "text",
    ...over,
  };
}

let store: PersonStore;
let scratch: string[];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "knowself-chat-incremental-"));
  (scratch ??= []).push(dir);
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
  store.ensurePersonForUid({
    platform: "wechat",
    platform_uid: "name:张三",
    display_name: "张三",
    now: NOW,
  });
  // 预置会话，隔离 NEW_CONVERSATION（§6.2 规则 8 由 tier-gates.test.ts 单独覆盖）
  store.conversations.upsertFromCommit(
    {
      conversation_id: CONV,
      platform: "wechat",
      kind: "direct",
      title: "张三",
      member_count: 2,
      first_msg_at: new Date(TS).toISOString(),
      last_msg_at: new Date(TS).toISOString(),
    },
    NOW,
  );
});

afterEach(() => {
  store.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** 造一个 JSON 导出目录；`messages` 决定本文件包含哪些消息（升序无关）。 */
function exportDir(messages: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-chat-incremental-export-"));
  scratch.push(dir);
  writeFileSync(
    join(dir, "single.json"),
    JSON.stringify({
      conversation_key: "wxid_aaaaaaaaaaaa22",
      title: "张三",
      kind: "单聊",
      messages,
    }),
    "utf8",
  );
  return dir;
}

/** 内存 sink：create 记草稿，accept 走真实 committer（§6.3 Tier A 自动 accept 路径）。 */
interface RecordingSink extends IngestProposalSink {
  created: ChatIngestProposalDraft[];
}

function sinkFor(committer: ChatMessageCommitterLike): RecordingSink {
  const created: ChatIngestProposalDraft[] = [];
  return {
    created,
    listPending(_input: { conversation_id: string }): readonly PendingProposalRef[] {
      return [];
    },
    create(proposal: ChatIngestProposalDraft): void {
      created.push(proposal);
    },
    accept(proposalId: string): void {
      const proposal = created.find((item) => item.id === proposalId);
      if (proposal === undefined) throw new Error(`不存在：${proposalId}`);
      committer.commit({
        proposal_id: proposalId,
        source_id: proposal.source_id,
        target: proposal.target,
        now: NOW,
      });
    },
  };
}

/** 最近一次运行的 sink（用于断言 proposal 载荷）。 */
let lastSink: RecordingSink | null = null;

function run(dir: string): Promise<IngestExportResult> {
  const committer = createChatMessageCommitter(store);
  lastSink = sinkFor(committer);
  return ingestExport({
    store,
    dir,
    now: NOW,
    reader: "json",
    source_id: SOURCE_ID,
    proposalSink: lastSink,
    chatCommitter: committer,
    only: ["张三"],
  });
}

/**
 * 跨运行持久的 sink：`created` 累积，等价于生产侧的 `ingestion_proposals` 表。
 * 复现「同一会话 Tier B 待审 → 再跑一次」必须用它（`sinkFor` 每次运行都是空的）。
 */
interface PersistentSink extends IngestProposalSink {
  created: ChatIngestProposalDraft[];
  accepted: string[];
}

function persistentSink(committer: ChatMessageCommitterLike): PersistentSink {
  const created: ChatIngestProposalDraft[] = [];
  const accepted: string[] = [];
  const decided = new Set<string>();
  return {
    created,
    accepted,
    listPending(input: { conversation_id: string }): readonly PendingProposalRef[] {
      // §6.5（2A）：按会话作用域查既有 pending，不按 batch_id 过滤。
      return created
        .filter(
          (proposal) =>
            !decided.has(proposal.id) &&
            proposal.target.conversation_id === input.conversation_id,
        )
        .map((proposal) => ({
          proposal_id: proposal.id,
          message_ids: proposal.target.message_ids,
        }));
    },
    create(proposal: ChatIngestProposalDraft): void {
      created.push(proposal);
    },
    accept(proposalId: string): void {
      const proposal = created.find((item) => item.id === proposalId);
      if (proposal === undefined) throw new Error(`不存在：${proposalId}`);
      committer.commit({
        proposal_id: proposalId,
        source_id: proposal.source_id,
        target: proposal.target,
        now: NOW,
      });
      decided.add(proposalId);
      accepted.push(proposalId);
    },
  };
}

function cursorOf() {
  return store.staging.readCursor("wechat", CONV);
}

describe("§5.2 首采全收 + §5.3 游标建立", () => {
  it("首采：无游标行 → 全部落档；游标推进到本批 (ts_ms, message_id) 最大者", async () => {
    const messages = [0, 1, 2, 3, 4].map((index) => syntheticMessage(index));
    const result = await run(exportDir(messages));

    expect(result.tier).toEqual({ auto: 1, review: 0 });
    expect(result.committed).toBe(5);
    expect(result.cursor_filtered).toBe(0);
    expect(store.messages.count({ conversation_id: CONV })).toBe(5);
    expect(cursorOf()).toEqual({
      last_ts_ms: TS + 4000,
      last_message_id: `${CONV}:m004`,
    });
  });

  it("二次同文件：全部被游标过滤，不新增消息、不新建 proposal", async () => {
    const dir = exportDir([0, 1, 2, 3, 4].map((index) => syntheticMessage(index)));
    await run(dir);
    const second = await run(dir);

    expect(second.proposals.created).toBe(0);
    expect(second.committed).toBe(0);
    expect(second.cursor_filtered).toBe(5);
    expect(store.messages.count({ conversation_id: CONV })).toBe(5);
  });
});

describe("§9.3 T3 追加增量：只新增游标之后的消息", () => {
  it("追加 10 条 → chat_messages 只新增 10 条；旧 5 条计入 cursor_filtered；游标推到新最大值", async () => {
    const first = await run(exportDir([0, 1, 2, 3, 4].map((i) => syntheticMessage(i))));
    expect(first.committed).toBe(5);
    const beforeMessages = store.messages.count({ conversation_id: CONV });

    const appended = Array.from({ length: 15 }, (_, index) => syntheticMessage(index));
    const second = await run(exportDir(appended));

    // §9.3 T3 的核心断言：只新增 10 条（L2 主键去重保证老的 5 条不重复落档）
    expect(store.messages.count({ conversation_id: CONV })).toBe(15);
    expect(store.messages.count({ conversation_id: CONV }) - beforeMessages).toBe(10);
    expect(second.cursor_filtered).toBe(5);

    // §6.5：被游标过滤的 5 条不得进入新 proposal（否则会重复审阅/重复审计）
    expect(second.proposals.created).toBe(1);
    expect(second.proposals.accepted).toBe(1);
    expect(second.proposals.queued).toBe(0);
    expect(lastSink?.created).toHaveLength(1);
    expect(lastSink?.created[0]?.target.message_ids).toHaveLength(10);
    expect(lastSink?.created[0]?.target.message_ids).toContain(`${CONV}:m014`);
    expect(lastSink?.created[0]?.target.message_ids).not.toContain(`${CONV}:m000`);

    // 已知粒度（committer.ts:96-98）：`commitStaged` 的粒度是 (batch_id, conversation_id)，
    // 一次 accept 会把该批该会话所有 staged 行置 committed，故计数器 = 15（含被过滤的 5 条），
    // 但 `INSERT OR IGNORE` 保证实际落档行只多 10 条（上面已断言）。
    expect(second.committed).toBe(15);

    expect(cursorOf()).toEqual({
      last_ts_ms: TS + 14_000,
      last_message_id: `${CONV}:m014`,
    });
  });

  it("同毫秒多消息：按 message_id 字典序判定，不丢同毫秒数据（§5.2）", async () => {
    const sameTs = TS;
    const dir = exportDir([
      syntheticMessage(0, { message_id: "a", ts_ms: sameTs }),
      syntheticMessage(1, { message_id: "b", ts_ms: sameTs }),
    ]);
    const first = await run(dir);
    expect(first.committed).toBe(2);
    expect(cursorOf()).toEqual({ last_ts_ms: sameTs, last_message_id: `${CONV}:b` });

    const second = await run(dir);
    expect(second.committed).toBe(0);
    expect(second.cursor_filtered).toBe(2);
  });
});

describe("§6.5 2A：Tier B 重跑去重（message_id 差集，不随 batch_id 漂移）", () => {
  it("同目录跑两次 → 第二次 created 0 / reused ≥1，且不落档、游标不推进", async () => {
    // 3 条消息，其中 1 条 content_type=other → 硬门槛 2 命中 CONTENT_TYPE_UNKNOWN，整会话进 Tier B
    const dir = exportDir([
      syntheticMessage(0),
      syntheticMessage(1, { content_type: "other" }),
      syntheticMessage(2),
    ]);
    const committer = createChatMessageCommitter(store);
    const sink = persistentSink(committer);
    const option = {
      store,
      dir,
      now: NOW,
      reader: "json" as const,
      source_id: SOURCE_ID,
      proposalSink: sink,
      chatCommitter: committer,
      only: ["张三"],
    };

    const first = await ingestExport(option);
    expect(first.tier).toEqual({ auto: 0, review: 1 });
    expect(first.committed).toBe(0);
    expect(first.proposals.created).toBe(1);
    expect(first.proposals.queued).toBe(1);
    expect(sink.created).toHaveLength(1);
    expect(sink.created[0]?.target.message_ids).toHaveLength(3);
    // 摘要粒度提示行：本 proposal 新增 3 条 / 本批该会话待落档 3 条
    expect(sink.created[0]?.proposed_body).toContain(
      "本次新增 3 条 / 该会话本批待落档 3 条（接受后整批落档）",
    );
    // Tier B 不落档 → §5.3 L3 游标不推进（这是重跑必然见到同一批消息的根因）
    expect(cursorOf()).toBeNull();
    expect(store.messages.count({ conversation_id: CONV })).toBe(0);

    const second = await ingestExport(option);

    // 2A 核心：同一批消息不得再新建 proposal（修复前为 created 1）
    expect(second.proposals.created).toBe(0);
    expect(second.proposals.queued).toBe(0);
    expect(second.proposals.reused).toBeGreaterThanOrEqual(1);
    // 既有 pending 已覆盖全部 3 条 → 全部计入 skipped_messages
    expect(second.proposals.skipped_messages).toBe(3);
    expect(second.cursor_filtered).toBe(0);
    expect(sink.created).toHaveLength(1);
    expect(store.messages.count({ conversation_id: CONV })).toBe(0);
    expect(cursorOf()).toBeNull();
  });

  it("重跑只把新增消息补成 1 条 proposal（run1 3 条 → run2 4 条 → 只新建第 4 条）", async () => {
    const committer = createChatMessageCommitter(store);
    const sink = persistentSink(committer);
    const dirOf = (count: number): string =>
      exportDir(
        Array.from({ length: count }, (_, index) =>
          syntheticMessage(index, index === 0 ? { content_type: "other" } : {}),
        ),
      );
    const option = (dir: string) => ({
      store,
      dir,
      now: NOW,
      reader: "json" as const,
      source_id: SOURCE_ID,
      proposalSink: sink,
      chatCommitter: committer,
      only: ["张三"],
    });

    await ingestExport(option(dirOf(3)));
    expect(sink.created).toHaveLength(1);

    const second = await ingestExport(option(dirOf(4)));
    expect(second.proposals.created).toBe(1);
    expect(second.proposals.reused).toBe(1);
    expect(sink.created).toHaveLength(2);
    // 新 proposal 只含新增的第 4 条（按 ts 升序的最后一条）
    expect(sink.created[1]?.target.message_ids).toEqual([`${CONV}:m003`]);
    // 1 条新增 / 本批该会话 4 条待落档（接受后整批落档）
    expect(sink.created[1]?.proposed_body).toContain(
      "本次新增 1 条 / 该会话本批待落档 4 条（接受后整批落档）",
    );
  });
});

describe("§6.2 规则 3 / §5.3 L3：TS_REGRESSION 不推进游标", () => {
  it("先采新版再采旧版 → 旧版整体进队列、0 落档、游标不后退", async () => {
    const newer = await run(exportDir([0, 1, 2, 3, 4].map((i) => syntheticMessage(i))));
    expect(newer.committed).toBe(5);
    const before = cursorOf();
    expect(before).toEqual({ last_ts_ms: TS + 4000, last_message_id: `${CONV}:m004` });

    // 旧导出：时间整体早于游标
    const olderDir = exportDir([
      syntheticMessage(0, { ts_ms: TS - 300_000 }),
      syntheticMessage(1, { ts_ms: TS - 240_000 }),
    ]);
    const older = await run(olderDir);

    expect(older.tier).toEqual({ auto: 0, review: 1 });
    expect(older.committed).toBe(0);
    expect(older.cursor_filtered).toBe(2);
    expect(store.messages.count({ conversation_id: CONV })).toBe(5);
    // 关键：游标停在原值（MAX 语义，不回退）
    expect(cursorOf()).toEqual(before);
  });

  it("advanceCursorState：更小的一批静默不生效；同毫秒取更大 message_id", () => {
    const current = { last_ts_ms: 1000, last_message_id: "b" };
    expect(advanceCursorState(current, [{ ts_ms: 999, message_id: "zzz" }])).toEqual(current);
    expect(advanceCursorState(current, [{ ts_ms: 1000, message_id: "a" }])).toEqual(current);
    expect(advanceCursorState(current, [{ ts_ms: 1000, message_id: "c" }])).toEqual({
      last_ts_ms: 1000,
      last_message_id: "c",
    });
    // 同毫秒下 current.last_message_id 为 null（未知）→ 采用 incoming，不错误回退
    expect(
      advanceCursorState({ last_ts_ms: 1000, last_message_id: null }, [
        { ts_ms: 1000, message_id: "a" },
      ]),
    ).toEqual({ last_ts_ms: 1000, last_message_id: "a" });
  });
});
