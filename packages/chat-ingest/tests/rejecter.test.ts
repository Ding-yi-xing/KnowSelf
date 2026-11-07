/**
 * rejecter.test.ts — 批 1.5 拒绝器工厂（与 committer 对称）
 *
 * 核心判据不是「行数相等」，而是**内容级不变量**：
 * 调用成功后，`target.message_ids` 覆盖的消息在全部批次中不得再存在 `status='staged'` 行。
 * 不满足必须抛错，**绝不静默返回成功**。
 */

import { describe, it, expect, vi } from "vitest";
import {
  createChatMessageRejecter,
  type ChatMessageCommitTargetLike,
  type ChatRejectStoreLike,
} from "../src/committer";
import { isChatIngestError } from "../src/errors";

const CONV = "wechat:conv-1";

function target(messageIds: readonly string[]): ChatMessageCommitTargetLike {
  return {
    kind: "chat_message",
    batch_id: "b1",
    conversation_id: CONV,
    message_ids: messageIds,
    tier: "review",
    reason_codes: ["ID_FALLBACK"],
  };
}

function makeStore(overrides: {
  rejected?: number;
  remaining_staged?: number;
} = {}): ChatRejectStoreLike & {
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    staging: {
      rejectStagedCrossBatch: vi.fn((q: unknown) => {
        calls.push(q);
        return {
          rejected: overrides.rejected ?? 2,
          remaining_staged: overrides.remaining_staged ?? 0,
        };
      }),
    },
  };
}

const input = (messageIds: readonly string[]) => ({
  proposal_id: "p1",
  target: target(messageIds),
  now: "2026-11-07T10:00:00.000Z",
});

describe("createChatMessageRejecter（批 1.5）", () => {
  it("正常拒绝：按 message_ids 跨批委派，返回 rejected", () => {
    const store = makeStore({ rejected: 3, remaining_staged: 0 });
    const rejecter = createChatMessageRejecter(store);

    expect(rejecter.reject(input(["m1", "m2"]))).toEqual({ rejected: 3 });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      conversation_id: CONV,
      proposal_id: "p1",
      message_ids: ["m1", "m2"],
    });
  });

  it("内容级不变量失败 → 抛 INVALID_TARGET_REF，不静默成功", () => {
    const store = makeStore({ rejected: 1, remaining_staged: 1 });
    const rejecter = createChatMessageRejecter(store);

    let thrown: unknown = null;
    try {
      rejecter.reject(input(["m1"]));
    } catch (cause) {
      thrown = cause;
    }

    expect(isChatIngestError(thrown)).toBe(true);
    expect((thrown as { code?: string }).code).toBe("INVALID_TARGET_REF");
    expect(String((thrown as Error).message)).toContain("视为未生效");
  });

  it("幂等：rejected=0 且 remaining_staged=0 时正常返回，不抛错", () => {
    const store = makeStore({ rejected: 0, remaining_staged: 0 });
    expect(createChatMessageRejecter(store).reject(input(["m1"]))).toEqual({ rejected: 0 });
  });

  it("target.kind 非 chat_message → 拒绝", () => {
    const store = makeStore();
    const bad = { ...input(["m1"]), target: { ...target(["m1"]), kind: "card_section" } };
    expect(() => createChatMessageRejecter(store).reject(bad as never)).toThrow();
    expect(store.calls).toHaveLength(0);
  });

  it("message_ids 为空 → 拒绝（contracts 约束）", () => {
    const store = makeStore();
    expect(() => createChatMessageRejecter(store).reject(input([]))).toThrow();
    expect(store.calls).toHaveLength(0);
  });

  it("message_ids 超过 2000 → 拒绝（contracts 约束）", () => {
    const store = makeStore();
    const ids = Array.from({ length: 2001 }, (_, i) => `m${i}`);
    expect(() => createChatMessageRejecter(store).reject(input(ids))).toThrow();
    expect(store.calls).toHaveLength(0);
  });

  it("仓储层抛错 → 包装为 INVALID_TARGET_REF，不吞异常", () => {
    const store: ChatRejectStoreLike = {
      staging: {
        rejectStagedCrossBatch: () => {
          throw new Error("sqlite busy");
        },
      },
    };
    let thrown: unknown = null;
    try {
      createChatMessageRejecter(store).reject(input(["m1"]));
    } catch (cause) {
      thrown = cause;
    }
    expect(isChatIngestError(thrown)).toBe(true);
    expect((thrown as { code?: string }).code).toBe("INVALID_TARGET_REF");
  });
});
