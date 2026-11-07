/**
 * budget.ts — token 预算裁剪
 *
 * 按各级预算裁剪 messages，优先保留 L1 > L2 > L3 > history。
 * 超出总预算时按 aggressive 模式从后往前截断。
 */

import type { ProviderMessage } from "@knowself/contracts";
import { countTokens } from "./token";

// ─── 入参 / 出参 ──────────────────────────────────────────────────────

interface BudgetInput {
  l1: ProviderMessage;
  l2: ProviderMessage[];
  l3: ProviderMessage | null;
  history: ProviderMessage[];
  userTurn: ProviderMessage;
  budgets: {
    l1: number;
    l2: number;
    l3: number;
    history: number;
    total: number;
  };
}

// ─── 工具函数 ─────────────────────────────────────────────────────────

/** 估算单条 ProviderMessage 的 token 数。 */
function msgTokens(msg: ProviderMessage): number {
  const texts = msg.content
    .filter((b) => b.kind === "text")
    .map((b) => (b as { kind: "text"; text: string }).text);
  return texts.reduce((sum, t) => sum + countTokens(t), 0);
}

/** 估算 ProviderMessage 数组的总 token 数。 */
function totalTokens(msgs: ProviderMessage[]): number {
  return msgs.reduce((sum, m) => sum + msgTokens(m), 0);
}

/** 将单个 message 截断到 token 预算内。 */
function trimMessage(msg: ProviderMessage, budget: number): ProviderMessage {
  const content = msg.content.map((block) => {
    if (block.kind !== "text") return block;
    const text = (block as { kind: "text"; text: string }).text;
    if (countTokens(text) <= budget) return block;
    // 从末尾截断，保留头部
    let truncated = text;
    while (countTokens(truncated) > budget && truncated.length > 0) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.8));
    }
    return { kind: "text", text: truncated + "\n...[已截断]" };
  });
  return { ...msg, content: content as ProviderMessage["content"] };
}

// ─── 主函数 ───────────────────────────────────────────────────────────

export function trimToBudget(input: BudgetInput): {
  messages: ProviderMessage[];
  degradedAggressive: boolean;
} {
  const { l1, l2, l3, history, userTurn, budgets } = input;
  let degradedAggressive = false;

  // 各级独立裁剪
  const trimmedL1 = trimMessage(l1, budgets.l1);
  const trimmedL2 = l2.map((m) => trimMessage(m, Math.floor(budgets.l2 / Math.max(l2.length, 1))));

  let trimmedL3: ProviderMessage | null = null;
  if (l3) {
    trimmedL3 = trimMessage(l3, budgets.l3);
  }

  // 历史消息裁剪：从旧到新保留，不超过 history 预算
  const trimmedHistory: ProviderMessage[] = [];
  let histTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    const ht = msgTokens(h);
    if (histTokens + ht <= budgets.history) {
      trimmedHistory.unshift(h);
      histTokens += ht;
    } else {
      break;
    }
  }

  // 组装全部 messages
  const allMessages: ProviderMessage[] = [
    trimmedL1,
    ...trimmedL2,
    ...(trimmedL3 ? [trimmedL3] : []),
    ...trimmedHistory,
    userTurn,
  ];

  // 总预算检查
  const used = totalTokens(allMessages);
  if (used <= budgets.total) {
    return { messages: allMessages, degradedAggressive: false };
  }

  // Aggressive 模式：从后往前删（保留 L1 + userTurn）
  degradedAggressive = true;
  const result: ProviderMessage[] = [trimmedL1];

  // 保留 L2（但可能压缩）
  for (const m of trimmedL2) {
    const t = msgTokens(m);
    if (totalTokens(result) + t + msgTokens(userTurn) <= budgets.total) {
      result.push(m);
    } else {
      break;
    }
  }

  // 尽量保留 history 的尾部
  const remaining = budgets.total - totalTokens(result) - msgTokens(userTurn);
  if (remaining > 0) {
    let histSum = 0;
    const keptHistory: ProviderMessage[] = [];
    for (let i = trimmedHistory.length - 1; i >= 0; i--) {
      const h = trimmedHistory[i]!;
      const ht = msgTokens(h);
      if (histSum + ht <= remaining) {
        keptHistory.unshift(h);
        histSum += ht;
      } else {
        break;
      }
    }
    result.push(...keptHistory);
  }

  result.push(userTurn);

  return { messages: result, degradedAggressive };
}
