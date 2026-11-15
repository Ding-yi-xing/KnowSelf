/**
 * W-9 C：**合成 fixture** 打通「消息落库 → 挖掘 → 图谱出边」。
 *
 * ## ⚠ fixture 必须经 `stageMessages` → `commitStaged` 落库
 * `chat_members` 的唯一写入口是 `store.commitStaged(...)`（`commit-steps.ts:96 upsertMembers`），
 * `members` 仓库也没挂到 `PersonStore` 上。**直接 INSERT persons/conversations/messages
 * 造出来的 fixture 是假的**：mining 的 `listMembers` 看不到第三方，边永远是 0，
 * 测试会「绿得毫无意义」。这一点是 W-9 讨论中确认的，写在这里防止以后有人图快改回去。
 *
 * ## 边界
 * 只用**合成数据**（`u1/u2/u3` 三个虚构账号 + 我），不读、不引用任何本机聊天记录路径，
 * 代码里也没有任何默认目录扫描。
 */
import { describe, expect, it } from "vitest";
import { createPersonStore } from "@knowself/person-store";
import { runMiningPipeline } from "@knowself/mining";

const NOW = "2026-11-12T00:00:00.000Z";
const BATCH = "w9-fixture";
const CONV = "conv-group-1";

/** 三个虚构参与者 + 我，每人 20 条，共 80 条，全部落在一个群会话里。 */
const SENDERS = [
  { id: "u1", name: "甲" },
  { id: "u2", name: "乙" },
  { id: "u3", name: "丙" },
];

/**
 * 造 80 条 staging 行（每人 20 条，含互相 @ 的内容，让共现/提及都有东西可算）。
 */
function makeRows(total = 20) {
  const rows: Record<string, unknown>[] = [];
  let seq = 0;
  for (const sender of SENDERS) {
    for (let i = 0; i < total; i += 1) {
      seq += 1;
      rows.push({
        message_id: `m-${sender.id}-${i}`,
        platform: "other",
        sender_id: sender.id,
        sender_name: sender.name,
        role: "other",
        ts_ms: Date.parse("2026-11-01T00:00:00.000Z") + seq * 60_000,
        msg_date: "2026-11-01",
        // 互相 @，制造 mention 边；同群共现制造 co_presence 边
        content: `@${SENDERS[(SENDERS.indexOf(sender) + 1) % SENDERS.length]!.name} 第 ${i} 条：聊聊爬山和咖啡`,
        content_type: "text",
        reply_to: null,
        meta: "{}",
        // StagingTier 只有 auto / review；写别的值会被 CHECK 拒绝，而 INSERT OR IGNORE 会静默丢弃（changes=0）
        tier: "auto",
        reason_codes: "[]",
        status: "pending",
        proposal_id: null,
      });
    }
  }
  return rows;
}

describe("W-9：合成 fixture → 挖掘 → 图谱", () => {
  it("3 个第三方 + 我 各 20 条，经 commitStaged 落库后 mining 产出人与边", async () => {
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });

    // staging 行有指向 chat_conversations 的外键：会话必须先存在，否则 INSERT OR IGNORE 会静默丢弃
    store.conversations.upsertFromCommit(
      {
        conversation_id: CONV,
        platform: "other",
        kind: "group",
        title: "三人小组",
        owner_person_id: "me",
        member_count: 4,
      },
      NOW,
    );

    // ingest_batches 也是外键目标：批次必须先 begin，否则 staging 行同样被静默丢弃
    store.staging.beginBatch({
      batch_id: BATCH,
      platform: "other",
      extractor: "w9-fixture",
      tool_version: "0.1.7",
      now: NOW,
    });

    const staged = store.staging.stageMessages({
      batch_id: BATCH,
      conversation_id: CONV,
      rows: makeRows(20) as never,
      now: NOW,
    });
    expect(staged.inserted).toBe(60);

    const committed = store.commitStaged({
      batch_id: BATCH,
      conversation_id: CONV,
      proposal_id: "p-1",
      now: NOW,
      conversation: {
        conversation_id: CONV,
        platform: "other",
        kind: "group",
        title: "三人小组",
        owner_person_id: "me",
        member_count: 4,
      },
    } as never);
    expect(committed.committed).toBe(60);

    // 落库后：第三方 person 必须存在（这是 mining 出边的前提）
    const persons = store.listPersons().filter((p) => p.person_id !== "me");
    expect(persons.length).toBeGreaterThanOrEqual(3);

    const mined = await runMiningPipeline({ store, write: true });

    expect(mined.snapshotId).not.toBeNull();
    expect(mined.graph?.snapshot.nodes.length ?? 0).toBeGreaterThan(0);
    // 关键断言：**边 > 0**（同群共现 + @提及）
    expect(mined.graph?.snapshot.edges.length ?? 0).toBeGreaterThan(0);
    expect(mined.persons).toBeGreaterThanOrEqual(3);

    // 关于 relationships 表：**挖掘管线不写它**（packages/mining/src/pipeline.ts 里没有任何
    // relationships 引用，写入方为空）。所以本测试的主判据是**快照 edges**，不在这里断言
    // `relationships > 0`——那会变成「要求一个设计上不写的东西」。
    // 详见 docs/units/testing/staging-write-traps.md 与 ISS-010。

    // 幂等：同一批次再 stage 一次，一条都不会新增
    const again = store.staging.stageMessages({
      batch_id: BATCH,
      conversation_id: CONV,
      rows: makeRows(20) as never,
      now: NOW,
    });
    expect(again.inserted).toBe(0);
    expect(again.ignored).toBe(60);

    store.close();
  }, 60_000);
});
