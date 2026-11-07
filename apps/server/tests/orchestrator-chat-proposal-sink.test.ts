/**
 * orchestrator-chat-proposal-sink.test.ts — chat proposal 的生产 sink
 *
 * 覆盖：draft→IngestionProposal 字段映射 / §6.5（2A）只按 conversation 匹配 pending /
 *       忽略非 chat_message 与其它会话 / 不同 batch 同会话仍算 pending / scanLimit 告警 /
 *       accept 转发到 ingestion。
 */

import { describe, it, expect, vi } from "vitest";
import type { IngestionProposal } from "@knowself/contracts";
import type { ChatIngestProposalDraft } from "@knowself/chat-ingest";
import {
  createProfileProposalSink,
  draftToProposal,
} from "../src/orchestrator/chat-proposal-sink";

function makeDraft(overrides: Partial<ChatIngestProposalDraft> = {}): ChatIngestProposalDraft {
  return {
    id: "p-1",
    source_id: "s-1",
    target: {
      kind: "chat_message",
      batch_id: "b-1",
      conversation_id: "c-1",
      message_ids: ["m1", "m2"],
      tier: "auto",
      reason_codes: [],
    },
    proposed_body: "摘要",
    reasoning: "tier=auto; rule_version=chat-tier-v1; reason_codes=[]",
    source_excerpts: [],
    produced_by_provider: "chat-ingest:rule-v1",
    status: "pending",
    user_edited_body: null,
    created_at: "2026-11-06T00:00:00.000Z",
    decided_at: null,
    ...overrides,
  };
}

function makeStore(seed: IngestionProposal[] = []) {
  const inserted: IngestionProposal[][] = [];
  return {
    inserted,
    proposals: {
      insertMany(items: IngestionProposal[]) {
        inserted.push(items);
      },
      listByStatus(_status: "pending", _limit?: number) {
        return seed;
      },
      countByStatus() {
        // 扫描窗口的定量来源；与 listByStatus 的 seed 保持一致
        return { pending: seed.length };
      },
    },
  };
}

describe("draftToProposal", () => {
  it("字段逐一映射，target 结构保持不变", () => {
    const draft = makeDraft();
    const proposal = draftToProposal(draft);

    expect(proposal.id).toBe("p-1");
    expect(proposal.source_id).toBe("s-1");
    expect(proposal.target).toEqual(draft.target);
    expect(proposal.status).toBe("pending");
    expect(proposal.produced_by_provider).toBe("chat-ingest:rule-v1");
    expect(proposal.user_edited_body).toBeNull();
    expect(proposal.decided_at).toBeNull();
  });
});

describe("createProfileProposalSink", () => {
  it("create 把 draft 交给 insertMany", () => {
    const store = makeStore();
    const sink = createProfileProposalSink({
      profileStore: store,
      acceptProposal: vi.fn(),
    });

    sink.create(makeDraft());

    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]![0]!.id).toBe("p-1");
    expect(store.inserted[0]![0]!.target).toMatchObject({ kind: "chat_message", batch_id: "b-1" });
  });

  it("listPending 只返回同会话（conversation）的 chat_message pending，不看 batch", () => {
    const seed: IngestionProposal[] = [
      draftToProposal(makeDraft({ id: "hit" })),
      // 2A 修订：不同 batch 但同会话 → 仍算 pending（每次运行都换 batch_id）
      draftToProposal(
        makeDraft({ id: "other-batch-same-conv", target: { ...makeDraft().target, batch_id: "b-2" } }),
      ),
      draftToProposal(
        makeDraft({ id: "other-conv", target: { ...makeDraft().target, conversation_id: "c-9" } }),
      ),
      {
        ...draftToProposal(makeDraft({ id: "profile-card" })),
        target: { kind: "card_section", card_key: "work", section: "x" } as never,
      },
    ];
    const sink = createProfileProposalSink({
      profileStore: makeStore(seed),
      acceptProposal: vi.fn(),
    });

    const refs = sink.listPending({ conversation_id: "c-1" });

    expect(refs.map((ref) => ref.proposal_id)).toEqual(["hit", "other-batch-same-conv"]);
    expect(refs[0]!.message_ids).toEqual(["m1", "m2"]);
  });

  it("不同 batch 但同会话 → 仍算 pending（重跑去重的关键，§6.5 2A）", () => {
    const seed: IngestionProposal[] = [
      draftToProposal(
        makeDraft({ id: "run1", target: { ...makeDraft().target, batch_id: "batch-run-1" } }),
      ),
    ];
    const sink = createProfileProposalSink({
      profileStore: makeStore(seed),
      acceptProposal: vi.fn(),
    });

    const refs = sink.listPending({ conversation_id: "c-1" });

    expect(refs).toHaveLength(1);
    expect(refs[0]!.proposal_id).toBe("run1");
  });

  /**
   * B 方案：告警的唯一触发条件是「真的漏判了」（`pendingTotal > ceiling`，**严格大于**）。
   * 旧语义「`pendings.length >= scanLimit`」会把"恰好装满窗口、一条都没漏"也判成降级。
   */
  it("积压超过扫描上限 → console.warn 且 drainWarnings 出一条（含精确数字）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const seed = Array.from({ length: 2 }, (_, index) =>
        draftToProposal(makeDraft({ id: `p-${index}` })),
      );
      const sink = createProfileProposalSink({
        profileStore: makeStore(seed),
        acceptProposal: vi.fn(),
        scanLimit: 1, // pendingTotal = 2 > 1 → 真截断
      });

      sink.listPending({ conversation_id: "c-1" });

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("积压 2 条");
      expect(message).toContain("上限 1 条");

      const drained = sink.drainWarnings?.() ?? [];
      expect(drained).toHaveLength(1);
      expect(drained[0]).toContain("待整理积压 2 条");
      expect(drained[0]).toContain("本次去重可能不完整");
    } finally {
      warn.mockRestore();
    }
  });

  it("积压未超上限 → 不告警（pendingTotal = 3 < 5）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const seed = Array.from({ length: 3 }, (_, index) =>
        draftToProposal(makeDraft({ id: `p-${index}` })),
      );
      const sink = createProfileProposalSink({
        profileStore: makeStore(seed),
        acceptProposal: vi.fn(),
        scanLimit: 5,
      });

      sink.listPending({ conversation_id: "c-1" });

      expect(warn).not.toHaveBeenCalled();
      expect(sink.drainWarnings?.() ?? []).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  /** 边界：恰好等于上限 = 没有漏判，不得告警（旧 `>=` 语义会在此误报）。 */
  it("积压恰好等于上限 → 不告警（pendingTotal = 2 === ceiling）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const seed = Array.from({ length: 2 }, (_, index) =>
        draftToProposal(makeDraft({ id: `p-${index}` })),
      );
      const sink = createProfileProposalSink({
        profileStore: makeStore(seed),
        acceptProposal: vi.fn(),
        scanLimit: 2,
      });

      sink.listPending({ conversation_id: "c-1" });

      expect(warn).not.toHaveBeenCalled();
      expect(sink.drainWarnings?.() ?? []).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("多会话触发同一截断 → 告警去重，摘要只留一条", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const seed = Array.from({ length: 3 }, (_, index) =>
        draftToProposal(makeDraft({ id: `p-${index}` })),
      );
      const sink = createProfileProposalSink({
        profileStore: makeStore(seed),
        acceptProposal: vi.fn(),
        scanLimit: 1,
      });

      sink.listPending({ conversation_id: "c-1" });
      sink.listPending({ conversation_id: "c-2" });
      sink.listPending({ conversation_id: "c-3" });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(sink.drainWarnings?.() ?? []).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  /** `drainWarnings()` 必须「取走即清空」，否则同进程多次导入会把上次告警带进下次摘要。 */
  it("drainWarnings 取走即清空 → 第二次取到空数组（不跨轮泄漏）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const seed = Array.from({ length: 2 }, (_, index) =>
        draftToProposal(makeDraft({ id: `p-${index}` })),
      );
      const sink = createProfileProposalSink({
        profileStore: makeStore(seed),
        acceptProposal: vi.fn(),
        scanLimit: 1,
      });

      sink.listPending({ conversation_id: "c-1" });
      expect(sink.drainWarnings?.() ?? []).toHaveLength(1);
      // 第二轮：没有任何新增告警时，不得再吐出上一轮那条
      expect(sink.drainWarnings?.() ?? []).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("无匹配时返回空数组", () => {
    const sink = createProfileProposalSink({
      profileStore: makeStore([]),
      acceptProposal: vi.fn(),
    });
    expect(sink.listPending({ conversation_id: "nope" })).toEqual([]);
  });

  it("accept 转发到注入的 acceptProposal", () => {
    const acceptProposal = vi.fn();
    const sink = createProfileProposalSink({
      profileStore: makeStore(),
      acceptProposal,
    });

    sink.accept("p-1");

    expect(acceptProposal).toHaveBeenCalledWith("p-1");
  });
});
