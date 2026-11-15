/**
 * W-9：`POST /write/proposals-accept-batch` 测试（3 条）。
 *
 * 这个端点存在的理由写在源码头注里：导入默认 `auto_commit=false` 是对的，
 * 但没有批量采纳就变成「导入 80 条 → 点 80 次」，功能在产品上不可用。
 */
import { describe, expect, it, vi } from "vitest";
import { acceptProposalsBatch } from "../src/routes/proposals-batch.js";
import { BadRequestError } from "../src/routes/http.js";

/** 造一条 pending proposal（只保留端点用到的字段）。 */
function proposal(id: string, sourceId: string, status = "pending", kind = "chat_message") {
  return { id, source_id: sourceId, status, target: { kind } };
}

/** 最小 services 桩。 */
function makeServices(opts: {
  pending?: ReturnType<typeof proposal>[];
  knownSource?: string;
  acceptThrows?: string[];
} = {}) {
  const { pending = [], knownSource = "src-1", acceptThrows = [] } = opts;
  const acceptProposal = vi.fn((id: string) => {
    if (acceptThrows.includes(id)) throw new Error("boom");
  });
  const services = {
    ingestion: {
      listProposalsByStatus: vi.fn(() => pending),
      acceptProposal,
    },
    profileStore: {
      sources: {
        get: (id: string) => {
          if (id !== knownSource) throw new Error("not found");
          return { id };
        },
      },
    },
  } as never;
  return { services, acceptProposal };
}

describe("POST /write/proposals-accept-batch（W-9）", () => {
  it("采纳该资料下所有 pending 的 chat_message proposal，回包计数正确", async () => {
    const pending = [
      proposal("p1", "src-1"),
      proposal("p2", "src-1"),
      proposal("p3", "src-2"), // 其它资料：不该被碰
      proposal("p4", "src-1", "pending", "distill"), // 非 chat_message：不该被碰
    ];
    const { services, acceptProposal } = makeServices({ pending });

    const result = await acceptProposalsBatch(services, { source_id: "src-1", reason: "w9" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ accepted: 2, failed: 0, failed_ids: [] });
    expect(acceptProposal.mock.calls.map((c) => c[0])).toEqual(["p1", "p2"]);
  });

  it("已决策（accepted / rejected）的不动——只采纳 pending", async () => {
    const pending = [
      proposal("p1", "src-1", "pending"),
      proposal("p2", "src-1", "accepted"),
      proposal("p3", "src-1", "rejected"),
    ];
    // 端点自己按 status='pending' 查，桩只回一条 pending（模拟真实 repo 行为）
    const { services, acceptProposal } = makeServices({
      pending: pending.filter((p) => p.status === "pending"),
    });

    const result = await acceptProposalsBatch(services, { source_id: "src-1" });

    expect(result.body).toMatchObject({ accepted: 1 });
    expect(acceptProposal).toHaveBeenCalledTimes(1);
    expect(acceptProposal).toHaveBeenCalledWith("p1");
  });

  it("未知 source_id → 404；缺 source_id/batch_id → 400；只给 batch_id → 400", async () => {
    const { services } = makeServices({ knownSource: "src-1" });

    const notFound = await acceptProposalsBatch(services, { source_id: "nope" });
    expect(notFound.status).toBe(404);

    await expect(acceptProposalsBatch(services, {})).rejects.toBeInstanceOf(BadRequestError);
    await expect(acceptProposalsBatch(services, { batch_id: "b1" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("单条采纳失败不中断其余，failed_ids 如实返回", async () => {
    const pending = [proposal("p1", "src-1"), proposal("p2", "src-1")];
    const { services } = makeServices({ pending, acceptThrows: ["p1"] });

    const result = await acceptProposalsBatch(services, { source_id: "src-1" });

    expect(result.body).toEqual({ accepted: 1, failed: 1, failed_ids: ["p1"] });
  });
});
