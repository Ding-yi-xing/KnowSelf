/**
 * 批次 2 / B2-3 + B2-4：策略层（判定入库 → 按开关采纳 → material 自动蒸馏）。
 *
 * 三条要被钉死的纪律：
 *   1. **判定一定记录**（即使总开关是关的）—— 否则用户永远看不到"系统本来想怎么归档"；
 *   2. **discard 永不自动采纳**（哪怕置信度 0.99）—— 删数据必须人点；
 *   3. **判定/蒸馏失败不阻断导入**，只进 warnings。
 */
import { describe, expect, it, vi } from "vitest";
import { runAutoArchive } from "../src/archive-policy.js";
import type { KnowselfServices } from "../src/services.js";
import type { PersonStore } from "@knowself/person-store";

const BATCH = "batch-1";
const SOURCE = "src-1";

/** 一条 chat_message proposal 桩。 */
function proposal(id: string, conversationId = "wechat:c1") {
  return {
    id,
    source_id: SOURCE,
    target: { kind: "chat_message", conversation_id: conversationId, message_ids: [id] },
    status: "pending",
  };
}

/**
 * 造依赖。
 * @param over 覆盖项（proposal 列表 / settings / staging 行）
 */
function setup(over: {
  proposals?: ReturnType<typeof proposal>[];
  auto_archive?: Record<string, unknown>;
  stagingRows?: { sender_id: string; role: string; content: string; content_type: string }[];
  conversation?: { kind: string; title: string } | null;
} = {}): {
  services: KnowselfServices;
  store: PersonStore;
  acceptProposal: ReturnType<typeof vi.fn>;
  setClassification: ReturnType<typeof vi.fn>;
  runDistill: ReturnType<typeof vi.fn>;
} {
  const proposals = over.proposals ?? [proposal("p1")];
  const stagingRows = over.stagingRows ?? [
    { sender_id: "wxid_a", role: "other", content: "今天吃什么", content_type: "text" },
    { sender_id: "me", role: "me", content: "随便", content_type: "text" },
  ];
  const acceptProposal = vi.fn();
  const setClassification = vi.fn();
  const runDistill = vi.fn(async () => ({ produced_proposal_ids: [] }));

  const profileStore = {
    proposals: {
      listByStatus: (status: string) => (status === "pending" ? proposals : []),
      setClassification,
    },
    sources: { get: () => ({ id: SOURCE }) },
  };
  const services = {
    profileStore,
    ingestion: { acceptProposal, runDistill },
    settings: { auto_archive: over.auto_archive },
  } as unknown as KnowselfServices;

  const store = {
    staging: { listStaged: () => stagingRows },
    conversations: { get: () => over.conversation ?? null },
  } as unknown as PersonStore;

  return { services, store, acceptProposal, setClassification, runDistill };
}

describe("B2-3 策略：判定记录与采纳", () => {
  it("总开关关闭：判定结果照常入库，但**不采纳**", async () => {
    const { services, store, acceptProposal, setClassification } = setup({
      // 100 条单聊 → 规则能判（person），这样才验证得了"关掉开关仍然记录判定"
      stagingRows: Array.from({ length: 100 }, () => ({
        sender_id: "wxid_a",
        role: "other",
        content: "在吗",
        content_type: "text",
      })),
      auto_archive: { enabled: false },
    });
    const outcome = await runAutoArchive({ services, store, batchId: BATCH, sourceId: SOURCE });
    expect(setClassification).toHaveBeenCalledTimes(1);
    expect(acceptProposal).not.toHaveBeenCalled();
    expect(outcome.classified).toBe(1);
    expect(outcome.auto_accepted).toBe(0);
  });

  it("开关打开 + 置信度达标 → 采纳", async () => {
    const { services, store, acceptProposal } = setup({
      // 单聊 100 条 → rule:direct-substantial，confidence 0.8
      stagingRows: Array.from({ length: 100 }, () => ({
        sender_id: "wxid_a",
        role: "other",
        content: "在吗",
        content_type: "text",
      })),
      auto_archive: { enabled: true, min_confidence: 0.8 },
    });
    const outcome = await runAutoArchive({ services, store, batchId: BATCH, sourceId: SOURCE });
    expect(acceptProposal).toHaveBeenCalledWith("p1");
    expect(outcome.auto_accepted).toBe(1);
  });

  it("置信度不够 → 留在 pending（不静默丢）", async () => {
    const { services, store, acceptProposal, setClassification } = setup({
      stagingRows: Array.from({ length: 100 }, () => ({
        sender_id: "wxid_a",
        role: "other",
        content: "在吗",
        content_type: "text",
      })),
      auto_archive: { enabled: true, min_confidence: 0.95 },
    });
    const outcome = await runAutoArchive({ services, store, batchId: BATCH, sourceId: SOURCE });
    expect(setClassification).toHaveBeenCalledTimes(1);
    expect(acceptProposal).not.toHaveBeenCalled();
    expect(outcome.auto_accepted).toBe(0);
  });

  it("discard 永不自动采纳（哪怕开关打开、置信度 0.99）", async () => {
    const { services, store, acceptProposal, setClassification } = setup({
      conversation: { kind: "direct", title: "某某科技公众号" },
      auto_archive: { enabled: true, min_confidence: 0.5 },
    });
    await runAutoArchive({ services, store, batchId: BATCH, sourceId: SOURCE });
    expect(setClassification).toHaveBeenCalledWith("p1", expect.objectContaining({ target: "discard" }));
    expect(acceptProposal).not.toHaveBeenCalled();
  });

  it("判定抛错 → 只记 warning，不抛出（不阻断导入）", async () => {
    const { services, store } = setup({ auto_archive: { enabled: true } });
    const brokenStore = {
      staging: {
        listStaged: () => {
          throw new Error("staging 崩了");
        },
      },
      conversations: { get: () => null },
    } as unknown as PersonStore;
    await expect(
      runAutoArchive({ services, store: brokenStore, batchId: BATCH, sourceId: SOURCE }),
    ).resolves.toEqual(expect.objectContaining({ warnings: expect.arrayContaining([expect.stringContaining("判定失败")]) }));
    void store;
  });
});

describe("B2-4 material 自动蒸馏", () => {
  it("material 被采纳 → 触发一次 distill", async () => {
    const { services, store, runDistill } = setup({
      stagingRows: [{ sender_id: "wxid_a", role: "other", content: "记住：我下周三体检", content_type: "text" }],
      auto_archive: { enabled: true, auto_distill_material: true, min_confidence: 0.8 },
    });
    const outcome = await runAutoArchive({ services, store, batchId: BATCH, sourceId: SOURCE });
    expect(outcome.auto_accepted).toBe(1);
    expect(runDistill).toHaveBeenCalledTimes(1);
    expect(outcome.distilled).toBe(1);
  });

  it("蒸馏失败 → 记 warning，不影响已采纳结果", async () => {
    const { services, store, runDistill } = setup({
      stagingRows: [{ sender_id: "wxid_a", role: "other", content: "记住：我下周三体检", content_type: "text" }],
      auto_archive: { enabled: true, auto_distill_material: true, min_confidence: 0.8 },
    });
    runDistill.mockRejectedValueOnce(new Error("no provider"));
    const outcome = await runAutoArchive({ services, store, batchId: BATCH, sourceId: SOURCE });
    expect(outcome.auto_accepted).toBe(1);
    expect(outcome.distilled).toBe(0);
    expect(outcome.warnings.some((w) => w.includes("自动蒸馏失败"))).toBe(true);
  });
});
