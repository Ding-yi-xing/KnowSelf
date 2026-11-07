/**
 * orchestrator-chat-index-sync.test.ts — 落档事件驱动的聊天索引增量重建
 *
 * 覆盖：只订阅 messages_committed / 会话 id 合并去重 / 串行不并发 /
 *       失败不中断后续 / stop 后不再重建。
 */

import { describe, it, expect, vi } from "vitest";
import { startChatIndexSync, type ChatIndexChangeEvent } from "../src/orchestrator/chat-index-sync";

function createEmitter() {
  const listeners = new Set<(e: ChatIndexChangeEvent) => void>();
  return {
    onCommitted(listener: (e: ChatIndexChangeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: ChatIndexChangeEvent) {
      for (const l of listeners) l(event);
    },
    size() {
      return listeners.size;
    },
  };
}

describe("startChatIndexSync", () => {
  it("messages_committed 事件触发按会话重建", async () => {
    const emitter = createEmitter();
    const rebuild = vi.fn(async () => undefined);
    const sync = startChatIndexSync({ onCommitted: emitter.onCommitted, rebuild });

    emitter.emit({ kind: "messages_committed", conversation_ids: ["c1", "c2"] });
    await sync.idle();

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(["c1", "c2"]);
    sync.stop();
  });

  it("忽略非 messages_committed 事件", async () => {
    const emitter = createEmitter();
    const rebuild = vi.fn(async () => undefined);
    const sync = startChatIndexSync({ onCommitted: emitter.onCommitted, rebuild });

    emitter.emit({ kind: "batch_reverted", conversation_ids: ["c1"] });
    emitter.emit({ kind: "person_merged", person_ids: ["p1"] } as ChatIndexChangeEvent);
    await sync.idle();

    expect(rebuild).not.toHaveBeenCalled();
    sync.stop();
  });

  it("conversation_ids 为空时不触发", async () => {
    const emitter = createEmitter();
    const rebuild = vi.fn(async () => undefined);
    const sync = startChatIndexSync({ onCommitted: emitter.onCommitted, rebuild });

    emitter.emit({ kind: "messages_committed" });
    emitter.emit({ kind: "messages_committed", conversation_ids: [] });
    await sync.idle();

    expect(rebuild).not.toHaveBeenCalled();
    sync.stop();
  });

  it("连续事件合并去重，且重建串行不并发", async () => {
    const emitter = createEmitter();
    let inFlight = 0;
    let maxConcurrent = 0;
    const calls: string[][] = [];

    const rebuild = vi.fn(async (ids: readonly string[]) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      calls.push([...ids]);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });

    const sync = startChatIndexSync({ onCommitted: emitter.onCommitted, rebuild });

    emitter.emit({ kind: "messages_committed", conversation_ids: ["c1"] });
    emitter.emit({ kind: "messages_committed", conversation_ids: ["c1", "c2"] });
    emitter.emit({ kind: "messages_committed", conversation_ids: ["c3"] });
    await sync.idle();

    expect(maxConcurrent).toBe(1);
    // 同一会话可能出现在连续两批（第一批取走后、第二批又并入）——重建按会话幂等，重复无害；
    // 这里只要求「所有会话都被覆盖」且「批次不超过 2」。
    expect([...new Set(calls.flat())].sort()).toEqual(["c1", "c2", "c3"]);
    expect(calls.length).toBeLessThanOrEqual(2);
    sync.stop();
  });

  it("重建失败只回调 onError，不中断后续事件", async () => {
    const emitter = createEmitter();
    const onError = vi.fn();
    let attempt = 0;
    const rebuild = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("sqlite busy");
    });

    const sync = startChatIndexSync({ onCommitted: emitter.onCommitted, rebuild, onError });

    emitter.emit({ kind: "messages_committed", conversation_ids: ["c1"] });
    await sync.idle();
    emitter.emit({ kind: "messages_committed", conversation_ids: ["c2"] });
    await sync.idle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toEqual(["c1"]);
    expect(rebuild).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it("stop 后取消订阅且不再重建", async () => {
    const emitter = createEmitter();
    const rebuild = vi.fn(async () => undefined);
    const sync = startChatIndexSync({ onCommitted: emitter.onCommitted, rebuild });

    expect(emitter.size()).toBe(1);
    sync.stop();
    expect(emitter.size()).toBe(0);

    emitter.emit({ kind: "messages_committed", conversation_ids: ["c1"] });
    await sync.idle();
    expect(rebuild).not.toHaveBeenCalled();
  });
});
