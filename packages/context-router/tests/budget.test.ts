/**
 * budget.test.ts — token 预算裁剪单元测试
 */

import { describe, it, expect } from "vitest";
import { trimToBudget } from "../src/budget";
import type { ProviderMessage } from "@knowself/contracts";

function txt(text: string): ProviderMessage {
  return {
    role: "system",
    content: [{ kind: "text", text }],
  };
}

function userMsg(text: string): ProviderMessage {
  return {
    role: "user",
    content: [{ kind: "text", text }],
  };
}

describe("trimToBudget", () => {
  const l1 = txt("L1 核心档案：这是一个简短的自我介绍。");

  const l2 = [
    txt("L2 卡片A：工作相关信息。" + "x".repeat(300)),
    txt("L2 卡片B：兴趣爱好。" + "y".repeat(200)),
  ];

  const l3 = txt("L3 检索结果：" + "z".repeat(500));

  const history = [userMsg("用户之前的问题？"), txt("之前的系统回复。" + "a".repeat(100))];

  const userTurn = userMsg("当前用户问题？");

  const budgets = {
    l1: 500,
    l2: 1000,
    l3: 800,
    history: 500,
    total: 3000,
  };

  it("正常预算下应返回全部消息", () => {
    const result = trimToBudget({
      l1,
      l2,
      l3,
      history,
      userTurn,
      budgets: { ...budgets, total: 100000 },
    });

    expect(result.degradedAggressive).toBe(false);
    expect(result.messages.length).toBeGreaterThanOrEqual(5);
    expect(result.messages[0]).toStrictEqual(l1);
    expect(result.messages[result.messages.length - 1]).toStrictEqual(userTurn);
  });

  it("应始终保留 L1 和 userTurn", () => {
    const result = trimToBudget({
      l1,
      l2,
      l3: null,
      history: [],
      userTurn,
      budgets: { ...budgets, total: 10 },
    });

    const roles = result.messages.map((m) => m.role);
    expect(roles[0]).toBe("system"); // L1
    expect(roles[roles.length - 1]).toBe("user"); // userTurn
  });

  it("L3 为 null 时应正确处理", () => {
    const result = trimToBudget({
      l1,
      l2,
      l3: null,
      history,
      userTurn,
      budgets: { ...budgets, total: 100000 },
    });

    expect(result.degradedAggressive).toBe(false);
    // 验证 L3 不存在（不应有 L3 的文本内容）
    const l3Included = result.messages.some((m) =>
      m.content.some(
        (b) => b.kind === "text" && (b as { text: string }).text.includes("z".repeat(500)),
      ),
    );
    expect(l3Included).toBe(false);
  });

  it("预算不足时应触发 aggressive 降级", () => {
    const result = trimToBudget({
      l1,
      l2,
      l3,
      history: [userMsg("很长很长很长很长很长很长很长很长的历史消息" + "x".repeat(2000))],
      userTurn,
      budgets: { ...budgets, total: 200 },
    });

    expect(result.degradedAggressive).toBe(true);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("空历史时不应报错", () => {
    const result = trimToBudget({
      l1,
      l2: [],
      l3: null,
      history: [],
      userTurn,
      budgets,
    });

    expect(result.messages.length).toBeGreaterThanOrEqual(2);
  });
});
