import { describe, expect, it } from "vitest";
import {
  buildReasoning,
  PROPOSAL_PROVIDER_ID,
  PROPOSAL_SHARD_SIZE,
  PROPOSED_BODY_LIMIT,
  ProposalBuilder,
  type ProposalMessageLike,
} from "../src/proposal";

const NOW = "2026-09-10T10:00:00.000Z";
const CONV = "wechat:wxid_aaaaaaaaaaaa22";
const BASE_TS = new Date("2024-01-02T13:45:00+08:00").getTime();

function message(index: number, over: Partial<ProposalMessageLike> = {}): ProposalMessageLike {
  return {
    message_id: `${CONV}:m${String(index).padStart(5, "0")}`,
    ts_ms: BASE_TS + index * 1000,
    sender_name: "张三",
    content: `第 ${index} 条`,
    content_type: "text",
    role: "other",
    ...over,
  };
}

function builder(over: { tier?: "auto" | "review"; reason_codes?: readonly string[] } = {}): ProposalBuilder {
  return new ProposalBuilder({
    source_id: "00000000-0000-0000-0000-000000000001",
    batch_id: "10000000-0000-0000-0000-000000000001",
    now: NOW,
    conversation: { conversation_id: CONV, title: "张三", kind: "direct" },
    tier: over.tier ?? "review",
    reason_codes: over.reason_codes ?? ["ID_FALLBACK"],
    id_factory: () => "20000000-0000-0000-0000-000000000001",
  });
}

describe("ProposalBuilder — §6.4 分片 / §6.3 审计字段", () => {
  it("≤2000 条/片；2000 条 = 1 片，2001 条 = 2 片", () => {
    expect(PROPOSAL_SHARD_SIZE).toBe(2000);
    const messages = Array.from({ length: PROPOSAL_SHARD_SIZE }, (_, i) => message(i));
    const one = builder().plan({ messages });
    expect(one.proposals).toHaveLength(1);
    expect(one.proposals[0]?.target.message_ids).toHaveLength(PROPOSAL_SHARD_SIZE);

    const two = builder().plan({
      messages: [...messages, message(PROPOSAL_SHARD_SIZE)],
    });
    expect(two.proposals).toHaveLength(2);
    expect(two.proposals[0]?.target.message_ids).toHaveLength(2000);
    expect(two.proposals[1]?.target.message_ids).toHaveLength(1);
  });

  it("按 (ts_ms, message_id) 升序切分，target 字段齐全", () => {
    const plan = builder({ tier: "review", reason_codes: ["ID_FALLBACK"] }).plan({
      messages: [message(2), message(0), message(1)],
    });
    const proposal = plan.proposals[0];
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;
    expect(proposal.target).toEqual({
      kind: "chat_message",
      batch_id: "10000000-0000-0000-0000-000000000001",
      conversation_id: CONV,
      // W-31：标题随 target 持久化（落档时写 chat_conversations.title）。
      // 断言仍然逐字段全等，只是把新增字段也纳入 —— 不是放宽，是收紧。
      conversation_title: "张三",
      message_ids: [message(0).message_id, message(1).message_id, message(2).message_id],
      tier: "review",
      reason_codes: ["ID_FALLBACK"],
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.produced_by_provider).toBe(PROPOSAL_PROVIDER_ID);
    expect(proposal.produced_by_provider).toBe("chat-ingest:rule-v1");
    expect(proposal.source_excerpts).toEqual([]);
    expect(proposal.user_edited_body).toBeNull();
    expect(proposal.decided_at).toBeNull();
    expect(proposal.created_at).toBe(NOW);
  });

  it("reasoning 逐字为 tier/rule_version/reason_codes", () => {
    expect(buildReasoning("auto", [])).toBe(
      "tier=auto; rule_version=chat-tier-v2; reason_codes=[]",
    );
    expect(buildReasoning("review", ["ID_FALLBACK", "MANUAL_FLAG"])).toBe(
      "tier=review; rule_version=chat-tier-v2; reason_codes=[ID_FALLBACK,MANUAL_FLAG]",
    );
  });

  it("proposed_body 是人类可读摘要且 ≤8000 字符（不是原文全文）", () => {
    const messages = Array.from({ length: 2000 }, (_, i) =>
      message(i, { content: "长".repeat(200) }),
    );
    const plan = builder().plan({ messages });
    const body = plan.proposals[0]?.proposed_body ?? "";
    expect(body.length).toBeLessThanOrEqual(PROPOSED_BODY_LIMIT);
    expect(body).toContain("会话：张三");
    expect(body).toContain(`会话 ID：${CONV}`);
    expect(body).toContain("消息条数：2000");
    expect(body).toContain("前 5 条预览");
    // 不是全文：2000 条 × 200 字远超 8000
    expect(body.length).toBeLessThan(2000 * 200);
  });

  it("Tier A 的 reason_codes 为空数组、reasoning 标注 auto", () => {
    const plan = builder({ tier: "auto", reason_codes: [] }).plan({ messages: [message(0)] });
    const proposal = plan.proposals[0];
    expect(proposal?.target.tier).toBe("auto");
    expect(proposal?.target.reason_codes).toEqual([]);
    expect(proposal?.reasoning).toContain("tier=auto");
  });
});

describe("ProposalBuilder — §6.5 重跑去重（2A：message_id 集合差集）", () => {
  it("staging.proposal_id 非空的消息跳过", () => {
    const plan = builder().plan({
      messages: [message(0), message(1)],
      already_proposed_message_ids: [message(0).message_id],
    });
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual([message(1).message_id]);
    expect(plan.skipped).toBe(1);
  });

  /**
   * 2A 修订（评审结论）：既有 pending 只按 `message_ids` 差集排除，
   * 不再「同批次已有 pending → 整批复用」。故 m1 被覆盖、m2 属新增。
   */
  it("既有 pending 覆盖 m1 → 只对新增的 m2 建 proposal，并复用该 pending", () => {
    const existing = [
      { proposal_id: "30000000-0000-0000-0000-000000000001", message_ids: [message(0).message_id] },
    ];
    const plan = builder().plan({ messages: [message(0), message(1)], existing_pending: existing });
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual([message(1).message_id]);
    expect(plan.reused).toEqual(existing);
    expect(plan.skipped).toBe(1);
  });

  /** 修复核心断言：run1={m1..m5} → run2={m1..m6} 只应新增 **1 条** proposal（仅 m6）。 */
  it("run1 覆盖 m0..m4，run2 输入 m0..m5 → 只产出含 m5 的 1 条 proposal", () => {
    const run1 = [0, 1, 2, 3, 4].map((index) => message(index));
    const existing = [
      {
        proposal_id: "30000000-0000-0000-0000-000000000010",
        message_ids: run1.map((m) => m.message_id),
      },
    ];
    const run2 = [0, 1, 2, 3, 4, 5].map((index) => message(index));
    const plan = builder().plan({ messages: run2, existing_pending: existing });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual([message(5).message_id]);
    expect(plan.reused).toEqual(existing);
    expect(plan.skipped).toBe(5);
  });

  it("run2 与 run1 完全相同 → fresh 为空、不产 proposal、reused 非空", () => {
    const run1 = [0, 1, 2, 3, 4].map((index) => message(index));
    const existing = [
      {
        proposal_id: "30000000-0000-0000-0000-000000000011",
        message_ids: run1.map((m) => m.message_id),
      },
    ];
    const plan = builder().plan({ messages: run1, existing_pending: existing });

    expect(plan.proposals).toEqual([]);
    expect(plan.reused).toEqual(existing);
    expect(plan.skipped).toBe(5);
  });

  it("既有 pending 与本次输入无交集 → 不算 reused（会话内有别的待审 proposal）", () => {
    const unrelated = [
      {
        proposal_id: "30000000-0000-0000-0000-000000000012",
        message_ids: [message(9).message_id],
      },
    ];
    const plan = builder().plan({
      messages: [message(0), message(1)],
      existing_pending: unrelated,
    });
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual([
      message(0).message_id,
      message(1).message_id,
    ]);
    expect(plan.reused).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it("无消息 → 无 proposal", () => {
    const plan = builder().plan({ messages: [] });
    expect(plan.proposals).toEqual([]);
    expect(plan.reused).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it("已绑定 proposal 与既有 pending 同时存在 → 各自排除、只对剩余消息新建（§6.5）", () => {
    const existing = [
      { proposal_id: "30000000-0000-0000-0000-000000000002", message_ids: [message(1).message_id] },
    ];
    const plan = builder().plan({
      messages: [message(0), message(1), message(2)],
      already_proposed_message_ids: [message(0).message_id],
      existing_pending: existing,
    });
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]?.target.message_ids).toEqual([message(2).message_id]);
    expect(plan.reused).toEqual(existing);
    // 1 条已绑定 + 1 条被既有 pending 覆盖
    expect(plan.skipped).toBe(2);
  });
});

/** 2A 附带：`commitStaged` 是会话级粒度，摘要须显式告知「本 proposal 新增 N / 本批待落档 M」。 */
describe("ProposalBuilder — proposed_body 粒度提示行（2A）", () => {
  it("提供 M → 末尾一行写明 N / M", () => {
    const withM = new ProposalBuilder({
      source_id: "00000000-0000-0000-0000-000000000001",
      batch_id: "10000000-0000-0000-0000-000000000001",
      now: NOW,
      conversation: { conversation_id: CONV, title: "张三", kind: "direct" },
      tier: "review",
      reason_codes: ["ID_FALLBACK"],
      conversation_pending_commit_count: 42,
    });
    const body = withM.plan({ messages: [message(0)] }).proposals[0]?.proposed_body ?? "";
    expect(body).toContain("本次新增 1 条 / 该会话本批待落档 42 条（接受后整批落档）");
    expect(body.trimEnd().endsWith("（接受后整批落档）")).toBe(true);
  });

  it("未提供 M → 省略该行（不编造数值）", () => {
    const body = builder().plan({ messages: [message(0)] }).proposals[0]?.proposed_body ?? "";
    expect(body).not.toContain("本次新增");
    expect(body).not.toContain("待落档");
  });
});

/** §6.4 分片边界补充：契约硬约束「单片 message_ids ≤ 2000」。 */
describe("ProposalBuilder — 分片边界（§6.4 / contracts message_ids.max(2000)）", () => {
  function uniqueIdBuilder(): ProposalBuilder {
    let seq = 0;
    return new ProposalBuilder({
      source_id: "00000000-0000-0000-0000-000000000001",
      batch_id: "10000000-0000-0000-0000-000000000001",
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

  it("4000 条 → 2 片各 2000；跨片无重复、并集等于全集；proposal id 互不相同", () => {
    const messages = Array.from({ length: 4000 }, (_, index) => message(index));
    const plan = uniqueIdBuilder().plan({ messages });

    expect(plan.proposals).toHaveLength(2);
    expect(plan.proposals.map((p) => p.target.message_ids.length)).toEqual([2000, 2000]);

    const ids = plan.proposals.flatMap((p) => p.target.message_ids);
    expect(new Set(ids).size).toBe(4000);
    expect(new Set(ids)).toEqual(new Set(messages.map((m) => m.message_id)));
    expect(new Set(plan.proposals.map((p) => p.id)).size).toBe(2);
  });

  it("2001 条：第 2 片恰好 1 条，且是 (ts_ms, message_id) 全序的最后一条", () => {
    const messages = Array.from({ length: 2001 }, (_, index) => message(index));
    // 打乱输入顺序，验证分片前先排序（§5.2「不依赖文件行序」）
    const shuffled = [messages[2000]!, ...messages.slice(1, 2000), messages[0]!];
    const plan = uniqueIdBuilder().plan({ messages: shuffled });

    expect(plan.proposals).toHaveLength(2);
    expect(plan.proposals[0]?.target.message_ids[0]).toBe(message(0).message_id);
    expect(plan.proposals[1]?.target.message_ids).toEqual([message(2000).message_id]);
  });

  it("单片消息数永不超过 2000（2001/4000 两种规模）", () => {
    for (const total of [2001, 4000]) {
      const plan = uniqueIdBuilder().plan({
        messages: Array.from({ length: total }, (_, index) => message(index)),
      });
      for (const proposal of plan.proposals) {
        expect(proposal.target.message_ids.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it("多片时 proposed_body 标注分片序号（第 1/2 片）", () => {
    const plan = uniqueIdBuilder().plan({
      messages: Array.from({ length: 2001 }, (_, index) => message(index)),
    });
    expect(plan.proposals[0]?.proposed_body).toContain("（第 1/2 片）");
    expect(plan.proposals[1]?.proposed_body).toContain("（第 2/2 片）");
  });
});
