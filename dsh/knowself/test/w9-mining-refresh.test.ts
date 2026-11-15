/**
 * W-9：`mining-refresh` 显式信号测试。
 *
 * 为什么值得单测：这是"回执说正在生成关系图，而图谱永远是旧的"的唯一防线。
 * 若信号退化成隐式（比如靠切面板触发），这里先红。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bumpMiningRefresh,
  getMiningRefreshToken,
  resetMiningRefreshForTest,
  subscribeMiningRefresh,
} from "../src/client/mining-refresh.js";

beforeEach(() => {
  resetMiningRefreshForTest();
});

describe("mining-refresh 显式信号", () => {
  it("bump 会通知所有订阅者，并递增 token", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeMiningRefresh(a);
    const offB = subscribeMiningRefresh(b);

    bumpMiningRefresh();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(getMiningRefreshToken()).toBe(1);

    offA();
    offB();
  });

  it("取消订阅后不再收到通知", () => {
    const listener = vi.fn();
    const off = subscribeMiningRefresh(listener);
    off();

    bumpMiningRefresh();

    expect(listener).not.toHaveBeenCalled();
    // token 仍然递增（它记录的是"数据变了几次"，与订阅者无关）
    expect(getMiningRefreshToken()).toBe(1);
  });

  it("某个订阅者抛错不影响其它订阅者", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const offBad = subscribeMiningRefresh(bad);
    const offGood = subscribeMiningRefresh(good);

    expect(() => bumpMiningRefresh()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    offBad();
    offGood();
  });
});
