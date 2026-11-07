/**
 * qa-2a-diff.test.ts — QA 独立验收：2A「Tier B 提案去重改为 conversation 作用域 + message_id 差集」。
 *
 * 与 `proposal.test.ts` 刻意不共用 fixture / 断言：本文件按验收基线（1~4）重新造数据，
 * 每条断言都从「用户可感知的后果」出发（重跑会不会多出一条覆盖相同消息的 proposal），
 * 而不是复用工程师用例的输入输出。
 *
 * 造数约定：`message_id` 直接用 `m1`…`mN`（对应基线里的 {m1..m5} → {m1..m6}），
 * 内容全部为合成占位（DESIGN-11 §9.1 铁律 2）。
 */
import { describe, expect, it } from "vitest";
import {
  ProposalBuilder,
  selectUnproposedMessages,
  type ChatIngestProposalDraft,
  type PendingProposalRef,
  type ProposalMessageLike,
} from "../src/proposal";

const T0 = new Date("2024-01-02T13:45:00+08:00").getTime();
const SOURCE_ID = "00000000-0000-0000-0000-0000000000a2";
const CONV = "wechat:wxid_aaaaaaaaaaaa99";
const BATCH = "10000000-0000-0000-0000-0000000000a2";
const NOW = "2026-11-06T10:00:00.000Z";

/** 第 n 条合成消息（1-based，id = `m<n>`）。 */
function m(n: number, over: Partial<ProposalMessageLike> = {}): ProposalMessageLike {
  return {
    message_id: `m${n}`,
    ts_ms: T0 + n * 1000,
    sender_name: "张三",
    content: `第 ${n} 条合成消息`,
    content_type: "text",
    role: "other",
    ...over,
  };
}

/** `range(1, 5)` → m1..m5。 */
function range(from: number, to: number): ProposalMessageLike[] {
  const out: ProposalMessageLike[] = [];
  for (let n = from; n <= to; n += 1) out.push(m(n));
  return out;
}

function ids(messages: readonly ProposalMessageLike[]): string[] {
  return messages.map((message) => message.message_id);
}

/** proposal id 互不相同的 builder（分片时会有多条）。 */
function builder(): ProposalBuilder {
  let seq = 0;
  return new ProposalBuilder({
    source_id: SOURCE_ID,
    batch_id: BATCH,
    now: NOW,
    conversation: { conversation_id: CONV, title: "张三", kind: "direct" },
    tier: "review",
    reason_codes: ["ID_FALLBACK"],
    id_factory: () => {
      seq += 1;
      return `20000000-0000-0000-0000-${String(seq).padStart(12, "0")}`;
    },
  });
}

function pendingOf(id: string, message_ids: readonly string[]): PendingProposalRef {
  return { proposal_id: id, message_ids };
}

/** 所有「已入队 + 新建」覆盖到的 message_id（用于断言无重复覆盖）。 */
function allCoveredIds(
  pendings: readonly PendingProposalRef[],
  created: readonly ChatIngestProposalDraft[],
): string[] {
  return [
    ...pendings.flatMap((ref) => [...ref.message_ids]),
    ...created.flatMap((proposal) => proposal.target.message_ids),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
//  基线 1（核心）：run1 {m1..m5} → run2 {m1..m6} 只新增覆盖 m6 的 1 条
// ──────────────────────────────────────────────────────────────────────────

describe("基线 1 — 增量差集：只补「真正新增」的消息", () => {
  it("{m1..m5} → {m1..m6}：只新建 1 条、只含 m6，且不存在覆盖 m1..m6 的条目", () => {
    const run1Pending = [pendingOf("p-run1", ids(range(1, 5)))];

    const plan = builder().plan({ messages: range(1, 6), existing_pending: run1Pending });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual(["m6"]);
    // 反证修复前的行为：不能有一条覆盖 m1..m6 的 proposal
    expect(plan.proposals[0]?.target.message_ids).not.toContain("m1");
    expect(plan.proposals[0]?.target.message_ids).not.toHaveLength(6);
    expect(plan.reused).toEqual(run1Pending);
    expect(plan.skipped).toBe(5);
    // 覆盖无重复：m1..m6 恰好各被覆盖一次
    const covered = allCoveredIds(run1Pending, plan.proposals);
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual(ids(range(1, 6)).sort());
  });

  it("连续三轮 {m1..m5} → {m1..m6} → {m1..m7}：每轮只补上一条增量", () => {
    const run1 = builder().plan({ messages: range(1, 5) });
    expect(run1.proposals).toHaveLength(1);
    const pendings: PendingProposalRef[] = [
      pendingOf("p-run1", run1.proposals[0]!.target.message_ids),
    ];

    const run2 = builder().plan({ messages: range(1, 6), existing_pending: pendings });
    expect(run2.proposals.map((proposal) => proposal.target.message_ids)).toEqual([["m6"]]);
    pendings.push(pendingOf("p-run2", run2.proposals[0]!.target.message_ids));

    const run3 = builder().plan({ messages: range(1, 7), existing_pending: pendings });
    expect(run3.proposals.map((proposal) => proposal.target.message_ids)).toEqual([["m7"]]);
    expect(run3.reused).toHaveLength(2);

    const covered = allCoveredIds(pendings, run3.proposals);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered).toHaveLength(7);
  });

  it("既有 pending 只覆盖前 3 条（上次跑一半）→ 只补 m4..m6 的 1 条", () => {
    const plan = builder().plan({
      messages: range(1, 6),
      existing_pending: [pendingOf("p-partial", ids(range(1, 3)))],
    });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual(["m4", "m5", "m6"]);
    expect(plan.skipped).toBe(3);
  });

  it("去重发生在分片之前：2100 条输入、前 2000 条已被覆盖 → 1 片 100 条（不是 2 片）", () => {
    const plan = builder().plan({
      messages: range(1, 2100),
      existing_pending: [pendingOf("p-big", ids(range(1, 2000)))],
    });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toHaveLength(100);
    expect(plan.proposals[0]?.target.message_ids[0]).toBe("m2001");
    expect(plan.proposals[0]?.target.message_ids.at(-1)).toBe("m2100");
  });
});

// ──────────────────────────────────────────────────────────────────────────
//  基线 2：同一集合重跑 → 不新建、reused 非空
// ──────────────────────────────────────────────────────────────────────────

describe("基线 2 — 同一集合重跑：created 0 / reused 非空", () => {
  it("run1 = run2 → proposals 为空、reused 指向既有 pending、skipped 全量", () => {
    const existing = [pendingOf("p-run1", ids(range(1, 5)))];
    const plan = builder().plan({ messages: range(1, 5), existing_pending: existing });

    expect(plan.proposals).toEqual([]);
    expect(plan.reused).toEqual(existing);
    expect(plan.skipped).toBe(5);
  });

  it("严格子集重跑（输入 {m1..m3}、pending 覆盖 {m1..m5}）→ 也不新建", () => {
    const plan = builder().plan({
      messages: range(1, 3),
      existing_pending: [pendingOf("p-run1", ids(range(1, 5)))],
    });

    expect(plan.proposals).toEqual([]);
    expect(plan.reused).toHaveLength(1);
    expect(plan.skipped).toBe(3);
  });

  it("不产空 message_ids 的 proposal（contracts 要求 1..2000）", () => {
    const plan = builder().plan({
      messages: range(1, 2),
      existing_pending: [pendingOf("p-run1", ids(range(1, 2)))],
    });
    expect(plan.proposals).toEqual([]);
    expect(plan.proposals.some((proposal) => proposal.target.message_ids.length === 0)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
//  基线 3：差集边界
// ──────────────────────────────────────────────────────────────────────────

describe("基线 3 — 差集边界", () => {
  it("本次输入全部已被既有 pending 覆盖 → 不产 proposal", () => {
    const plan = builder().plan({
      messages: range(1, 4),
      existing_pending: [pendingOf("p-a", ids(range(1, 2))), pendingOf("p-b", ids(range(3, 4)))],
    });
    expect(plan.proposals).toEqual([]);
    expect(plan.reused.map((ref) => ref.proposal_id)).toEqual(["p-a", "p-b"]);
    expect(plan.skipped).toBe(4);
  });

  it("多条 pending 互相重叠 → 不重复计数 skipped", () => {
    // p-a 覆盖 m1..m3，p-b 覆盖 m2..m4；输入 m1..m4 全被覆盖
    const plan = builder().plan({
      messages: range(1, 4),
      existing_pending: [pendingOf("p-a", ids(range(1, 3))), pendingOf("p-b", ids(range(2, 4)))],
    });
    expect(plan.proposals).toEqual([]);
    expect(plan.skipped).toBe(4);
    expect(plan.reused).toHaveLength(2);
  });

  it("本次输入为空 → 不崩、不产 proposal、reused 为空", () => {
    expect(() => selectUnproposedMessages({ messages: [] })).not.toThrow();
    const plan = builder().plan({ messages: [], existing_pending: [pendingOf("p-a", ["m1"])] });
    expect(plan.proposals).toEqual([]);
    expect(plan.reused).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it("本次输入为空但既有 pending 非空 → 不误算 reused（无交集即非复用）", () => {
    const selected = selectUnproposedMessages({
      messages: [],
      existing_pending: [pendingOf("p-a", ["m1", "m2"])],
    });
    expect(selected.fresh).toEqual([]);
    expect(selected.reused).toEqual([]);
  });

  it("reused 只算「有交集」的 pending，不是会话内全部 pending", () => {
    const touching = pendingOf("p-touching", ["m1", "m2"]);
    const unrelatedA = pendingOf("p-unrelated-a", ["m20", "m21"]);
    const unrelatedB = pendingOf("p-unrelated-b", ["m30"]);
    const selected = selectUnproposedMessages({
      messages: [m(1), m(2), m(3)],
      existing_pending: [touching, unrelatedA, unrelatedB],
    });

    expect(selected.reused.map((ref) => ref.proposal_id)).toEqual(["p-touching"]);
    expect(selected.reused).toHaveLength(1);
    // 只有 touched 的 m1/m2 被挡掉；无交集 pending 的 m20/m21/m30 不影响 fresh
    expect(selected.fresh.map((message) => message.message_id)).toEqual(["m3"]);
    expect(selected.skipped).toBe(2);
  });

  it("pending 里含空 message_ids → 不影响判定、不崩", () => {
    const selected = selectUnproposedMessages({
      messages: [m(1)],
      existing_pending: [pendingOf("p-empty", [])],
    });
    expect(selected.fresh.map((message) => message.message_id)).toEqual(["m1"]);
    expect(selected.reused).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
//  基线 4（回归）：staging 绑定优先 + skipped 语义 = bound + covered
// ──────────────────────────────────────────────────────────────────────────

describe("基线 4 — 回归：already_proposed 优先、skipped 语义不变", () => {
  it("同时被 bound 与 covered 的消息只计 1 次 skipped（不重复计数）", () => {
    const plan = builder().plan({
      messages: [m(1), m(2), m(3)],
      already_proposed_message_ids: ["m1", "m2"],
      existing_pending: [pendingOf("p-a", ["m2", "m3"])],
    });

    // m1/m2 被 staging 绑定挡掉，m3 被 pending 覆盖挡掉 → 3
    expect(plan.skipped).toBe(3);
    expect(plan.proposals).toEqual([]);
    // m2 同时命中两条排除口，仍只算 1 次
    expect(plan.skipped).toBe(2 + 1);
  });

  it("skipped = 被 bound 挡掉 + 被 covered 挡掉（两个分量都可单独观测）", () => {
    const plan = builder().plan({
      messages: range(1, 5),
      already_proposed_message_ids: ["m1"],
      existing_pending: [pendingOf("p-a", ["m2", "m3"])],
    });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual(["m4", "m5"]);
    expect(plan.skipped).toBe(3);
  });

  it("staging 绑定单独生效（无 pending 时行为与修复前一致）", () => {
    const plan = builder().plan({
      messages: range(1, 3),
      already_proposed_message_ids: ["m2"],
    });
    expect(plan.proposals[0]?.target.message_ids).toEqual(["m1", "m3"]);
    expect(plan.skipped).toBe(1);
    expect(plan.reused).toEqual([]);
  });

  it("pending 覆盖的消息不在本次输入里 → 对 skipped / fresh 无影响，但不算 reused", () => {
    const selected = selectUnproposedMessages({
      messages: [m(1), m(2)],
      existing_pending: [pendingOf("p-a", ["m9"])],
    });
    expect(selected.skipped).toBe(0);
    expect(selected.reused).toEqual([]);
    expect(selected.fresh).toHaveLength(2);
  });

  it("Tier A / Tier B 走同一条去重路径（tier 不影响差集结果）", () => {
    const tierA = new ProposalBuilder({
      source_id: SOURCE_ID,
      batch_id: BATCH,
      now: NOW,
      conversation: { conversation_id: CONV, title: "张三", kind: "direct" },
      tier: "auto",
      reason_codes: [],
    });
    const plan = tierA.plan({
      messages: range(1, 6),
      existing_pending: [pendingOf("p-run1", ids(range(1, 5)))],
    });
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual(["m6"]);
    expect(plan.proposals[0]?.target.tier).toBe("auto");
  });
});

// ──────────────────────────────────────────────────────────────────────────
//  风险 B：reused 语义变化（整批命中 → 有交集即复用）的可见影响面
// ──────────────────────────────────────────────────────────────────────────

describe("风险 B — reused 语义：按 proposal 计数（有交集即复用）", () => {
  it("两条 pending 各与输入有交集 → reused = 2（不是消息数、也不是整批命中数）", () => {
    const plan = builder().plan({
      messages: range(1, 7),
      existing_pending: [pendingOf("p-1", ids(range(1, 3))), pendingOf("p-2", ids(range(4, 6)))],
    });

    expect(plan.reused).toHaveLength(2);
    expect(plan.proposals.map((proposal) => proposal.target.message_ids)).toEqual([["m7"]]);
    // reused 是 proposal 数，与新增消息数无对应关系
    expect(plan.reused).not.toHaveLength(1);
  });

  it("严格命中 1 条 pending 时 reused 也是 1（新旧语义在此场景一致）", () => {
    const plan = builder().plan({
      messages: range(1, 5),
      existing_pending: [pendingOf("p-1", ids(range(1, 5)))],
    });
    expect(plan.reused).toHaveLength(1);
    expect(plan.proposals).toEqual([]);
  });
});
