/**
 * W-2 跨面板 handoff 测试（`panel-jump.ts`）。
 *
 * 三条不变式：
 *   ① **一次性**：`consumeFocusedPerson()` 读后即清，第二次返回 null；
 *   ② **已挂载优先**：有订阅者时同步通知且**不留存**（否则下次挂载会重复消费）；
 *   ③ **未挂载兜底**：无订阅者时留存，等面板挂载后消费。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeFocusedPerson,
  focusPerson,
  resetPanelJumpForTest,
  subscribeFocusedPerson,
} from "../src/client/panel-jump.js";

beforeEach(() => {
  resetPanelJumpForTest();
});

describe("panel-jump 一次性投递", () => {
  it("写入后消费一次拿到值，第二次返回 null", () => {
    focusPerson("p-1");
    expect(consumeFocusedPerson()).toBe("p-1");
    expect(consumeFocusedPerson()).toBeNull();
  });

  it("空 personId 被忽略（不覆盖已有待投递目标）", () => {
    focusPerson("p-1");
    focusPerson("");
    expect(consumeFocusedPerson()).toBe("p-1");
  });

  it("未写入时消费得到 null", () => {
    expect(consumeFocusedPerson()).toBeNull();
  });
});

describe("panel-jump 订阅路径", () => {
  it("有订阅者时：同步收到通知，且 pending 不被留存", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeFocusedPerson((id) => seen.push(id));

    focusPerson("p-2");

    expect(seen).toEqual(["p-2"]);
    // 已投递 → 再消费应该拿不到（避免下次挂载时重复选中）
    expect(consumeFocusedPerson()).toBeNull();
    unsubscribe();
  });

  it("多个订阅者都收到", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeFocusedPerson(a);
    const offB = subscribeFocusedPerson(b);

    focusPerson("p-3");

    expect(a).toHaveBeenCalledWith("p-3");
    expect(b).toHaveBeenCalledWith("p-3");
    offA();
    offB();
  });

  it("取消订阅后不再收到通知（回落为留存 + 消费）", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFocusedPerson(listener);
    unsubscribe();

    focusPerson("p-4");

    expect(listener).not.toHaveBeenCalled();
    // 没有订阅者 → 留存，供挂载时消费
    expect(consumeFocusedPerson()).toBe("p-4");
  });

  it("连续两次投递：后一次覆盖前一次（只保留最后目标）", () => {
    focusPerson("p-5");
    focusPerson("p-6");
    expect(consumeFocusedPerson()).toBe("p-6");
  });
});
