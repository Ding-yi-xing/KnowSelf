/**
 * W-6/E：蒸馏幂等测试。
 *
 * 背景（QA 实测）：W-5 造出的测试 source 上出现了两簇各 8 条提案
 * （03:07:31.950Z / 03:07:50.738Z），是同 238 字原文蒸馏两遍的结果。
 * 根因是 `routes/sources-write.ts` 的 `createSource` 内部已经
 * `await ingestion.runDistill(...)` 一次，REST 再调
 * `POST /sources/:id/distill` 就是第二次。
 *
 * 约定：
 *   - 默认幂等：已有 `pending` 提案 → 不调模型，返回既有 id + `reused: true`
 *   - `force: true`：先删该 source 的旧 `pending`（**不动 accepted/rejected**）再重跑
 *
 * ## 为什么 import `../src` 而不是 `../dist`
 * 见 `packages/provider-adapter/tests/redaction.test.ts` 头注（W-6/D 假绿问题）。
 */
import { describe, it, expect, vi } from "vitest";
import { runDistill } from "../src/distill";
import type { SourceStored, IngestionProposal } from "@knowself/contracts";

const sampleSource: SourceStored = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "paste",
  original_name: "idempotent.md",
  mime_type: "text/markdown",
  file_path: null,
  url: null,
  extracted_text: "我叫周十，做后端十年，喜欢爬山。".repeat(6),
  truncated: false,
  char_count: 120,
  user_note: "",
  user_tags: [],
  status: "raw",
  metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
  last_ingested_at: null,
  last_error: null,
};

/** 构造一条最小 pending proposal（只用到 id / status / source_id）。 */
function makeProposal(id: string, sourceId: string, status: "pending" | "accepted" | "rejected") {
  return {
    id,
    source_id: sourceId,
    target: { kind: "core" },
    proposed_body: `body-${id}`,
    reasoning: "r",
    source_excerpts: [],
    produced_by_provider: "p",
    status,
    user_edited_body: null,
    created_at: "2026-01-01T00:00:00.000Z",
    decided_at: null,
  } as IngestionProposal;
}

/** 模型每次输出 2 条 write（模拟 N=2 的一批）。 */
const MODEL_OUTPUT = {
  writes: [
    { target: { targetKind: "core" }, body: "整体画像", reasoning: "理由", excerpts: [] },
    {
      target: { targetKind: "card_section", cardKey: "work", section: "职业" },
      body: "后端十年",
      reasoning: "理由",
      excerpts: [],
    },
  ],
};

/**
 * 构造测试依赖。
 *
 * @param existing 该 source 已有的提案（用于验证幂等 / force）
 * @returns deps + 可断言的 spy
 */
function makeDeps(existing: IngestionProposal[]) {
  // 内存里的提案表：deletePendingBySource / insertMany 会真实改动它，
  // 这样「force 后数量仍为 N」「accepted 不受影响」才是真断言而非 spy 断言。
  const rows: IngestionProposal[] = [...existing];

  const proposals = {
    listBySource: vi.fn((sourceId: string) => rows.filter((r) => r.source_id === sourceId)),
    insertMany: vi.fn((items: IngestionProposal[]) => {
      rows.push(...items);
    }),
    deletePendingBySource: vi.fn((sourceId: string) => {
      const keep = rows.filter((r) => !(r.source_id === sourceId && r.status === "pending"));
      const removed = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return removed;
    }),
  };

  const sources = {
    updateStatus: vi.fn(),
    updateError: vi.fn(),
  };

  const store = {
    cards: { list: vi.fn(() => []) },
    journal: { listDates: vi.fn(() => []) },
    sources,
    proposals,
    transaction: vi.fn((fn: () => unknown) => fn()),
  } as never;

  const providerAdapter = {
    pickProvider: vi.fn(() => ({ id: "distill-provider" })),
    requestStructured: vi.fn(async () => MODEL_OUTPUT),
  } as never;

  return {
    deps: {
      store,
      providerAdapter,
      distillProviderId: "configured-provider",
      now: () => "2026-01-02T00:00:00.000Z",
    },
    rows,
    proposals,
    sources,
    providerAdapter: providerAdapter as unknown as {
      requestStructured: ReturnType<typeof vi.fn>;
    },
  };
}

/** runDistill 的标准入参。 */
const BASE_REQ = { provider_id: "", focus_hints: [], max_proposals: 8 };

describe("runDistill 幂等（W-6/E）", () => {
  it("首次蒸馏：调模型并产出 N 条，reused 不为 true", async () => {
    const { deps, rows, providerAdapter } = makeDeps([]);

    const res = await runDistill(deps, sampleSource, BASE_REQ);

    expect(providerAdapter.requestStructured).toHaveBeenCalledTimes(1);
    expect(res.produced_proposal_ids).toHaveLength(2);
    expect(res.reused).toBeUndefined();
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  it("再次蒸馏：不调模型，reused=true，提案数不变", async () => {
    const { deps, rows, providerAdapter } = makeDeps([]);

    await runDistill(deps, sampleSource, BASE_REQ);
    providerAdapter.requestStructured.mockClear();

    const again = await runDistill(deps, sampleSource, BASE_REQ);

    expect(providerAdapter.requestStructured).not.toHaveBeenCalled();
    expect(again.reused).toBe(true);
    expect(again.produced_proposal_ids).toHaveLength(2);
    // 提案总数没有被第二轮叠加
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  it("force=true：旧 pending 被替换，数量仍为 N（不叠加）", async () => {
    const { deps, rows, proposals, providerAdapter } = makeDeps([]);

    await runDistill(deps, sampleSource, BASE_REQ);
    const firstIds = rows.map((r) => r.id);

    const forced = await runDistill(deps, sampleSource, { ...BASE_REQ, force: true });

    expect(providerAdapter.requestStructured).toHaveBeenCalledTimes(2);
    expect(proposals.deletePendingBySource).toHaveBeenCalledWith(sampleSource.id);
    expect(forced.reused).toBeUndefined();
    expect(forced.produced_proposal_ids).toHaveLength(2);
    // 仍是 2 条（旧的被删、新的插入），没有变成 4 条
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
    // 新一批 id 与旧一批不同 → 确实是重蒸
    for (const id of forced.produced_proposal_ids) {
      expect(firstIds).not.toContain(id);
    }
  });

  it("force=true 不动 accepted / rejected 历史提案", async () => {
    const accepted = makeProposal("acc-1", sampleSource.id, "accepted");
    const rejected = makeProposal("rej-1", sampleSource.id, "rejected");
    const { deps, rows } = makeDeps([accepted, rejected]);

    const res = await runDistill(deps, sampleSource, { ...BASE_REQ, force: true });

    expect(res.produced_proposal_ids).toHaveLength(2);
    expect(rows.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain("acc-1");
    expect(rows.map((r) => r.id)).toContain("rej-1");
  });

  it("只有 accepted / rejected 时默认仍会调模型（不算幂等命中）", async () => {
    const accepted = makeProposal("acc-1", sampleSource.id, "accepted");
    const { deps, providerAdapter } = makeDeps([accepted]);

    const res = await runDistill(deps, sampleSource, BASE_REQ);

    expect(providerAdapter.requestStructured).toHaveBeenCalledTimes(1);
    expect(res.reused).toBeUndefined();
    expect(res.produced_proposal_ids).toHaveLength(2);
  });

  it("pending source_distill does not suppress a content distillation", async () => {
    const review = {
      ...makeProposal("review-1", sampleSource.id, "pending"),
      target: {
        kind: "source_distill" as const,
        confidence: 0.4,
        classifier: "dsh-session-rule-v1",
        reason: "review before distilling",
      },
    };
    const { deps, providerAdapter } = makeDeps([review]);

    const result = await runDistill(deps, sampleSource, BASE_REQ);

    expect(providerAdapter.requestStructured).toHaveBeenCalledTimes(1);
    expect(result.reused).toBeUndefined();
  });
});
