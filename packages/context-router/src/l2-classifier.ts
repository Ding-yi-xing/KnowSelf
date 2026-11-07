/**
 * l2-classifier.ts — L2 卡片分类器
 *
 * 根据用户 query 从候选卡片中选出相关卡片。
 * forceCardKeys 非空直接返回；cards ≤ max 全选；
 * 否则调 providerAdapter.requestStructured 做 LLM 分类。
 */

import { z } from "zod";
import type { CardSummary, CardKey, RetrieverConfig, ProviderMessage } from "@knowself/contracts";
import type { ProviderAdapter } from "@knowself/provider-adapter";

// ─── 内部 Zod schema（LLM 分类器输出） ────────────────────────────────

const ClassifyOutputSchema = z.object({
  selected_keys: z.array(z.string().min(1).max(48)).max(10),
  reasoning: z.string().max(512).default(""),
});

// ─── deps 类型 ────────────────────────────────────────────────────────

interface ClassifierDeps {
  providerAdapter: ProviderAdapter;
  config: RetrieverConfig;
}

interface ClassifyInput {
  query: string;
  cards: CardSummary[];
  config: RetrieverConfig;
  forceCardKeys?: CardKey[];
}

// ─── 分类器 prompt 构建 ───────────────────────────────────────────────

function buildClassifyPrompt(cards: CardSummary[], maxCards: number): string {
  const cardLines = cards
    .map((c, i) => `${i + 1}. key="${c.key}" 标题="${c.title}" 摘要="${c.summary}"`)
    .join("\n");

  return `你是一个档案分类助手。用户有一组个人信息卡片，你需要根据用户的提问选出最相关的卡片。

可用卡片：
${cardLines}

请选出最多 ${maxCards} 张与用户提问最相关的卡片，按相关度降序排列。
输出 JSON 格式：{"selected_keys": ["card_key1", ...], "reasoning": "一句话说明理由"}`;
}

// ─── 降级策略 ─────────────────────────────────────────────────────────

function degradeClassify(input: ClassifyInput): {
  selectedKeys: CardKey[];
  reasoning: string;
  degraded: boolean;
} {
  const strategy = input.config.fallback_when_no_classify;

  if (strategy === "all_cards") {
    return {
      selectedKeys: input.cards.map((c) => c.key),
      reasoning: "分类器降级：全选所有卡片",
      degraded: true,
    };
  }

  if (strategy === "last_used") {
    // MVP：无上次记录，退化为全不选
    return {
      selectedKeys: [],
      reasoning: "分类器降级：无上次使用记录，跳过 L2",
      degraded: true,
    };
  }

  // strategy === "none"
  return {
    selectedKeys: [],
    reasoning: "分类器降级：none 策略，跳过 L2",
    degraded: true,
  };
}

// ─── 主函数 ───────────────────────────────────────────────────────────

export async function classifyCards(
  deps: ClassifierDeps,
  input: ClassifyInput,
): Promise<{ selectedKeys: CardKey[]; reasoning: string; degraded: boolean }> {
  // 强制指定卡片：直接返回
  if (input.forceCardKeys && input.forceCardKeys.length > 0) {
    return {
      selectedKeys: input.forceCardKeys,
      reasoning: "用户手动指定卡片",
      degraded: false,
    };
  }

  // 无卡片或无需分类
  if (input.cards.length === 0) {
    return { selectedKeys: [], reasoning: "无可用卡片", degraded: false };
  }

  // 卡片数 ≤ 上限：全选
  const maxCards = input.config.classifier_max_cards;
  if (input.cards.length <= maxCards) {
    return {
      selectedKeys: input.cards.map((c) => c.key),
      reasoning: `卡片总数 ${input.cards.length} ≤ 上限 ${maxCards}，全选`,
      degraded: false,
    };
  }

  // 调 LLM 分类
  const providerId =
    input.config.classifier_provider_id || deps.providerAdapter.pickProvider("classify")?.id || "";

  if (!providerId) {
    return degradeClassify(input);
  }

  try {
    const systemMsg: ProviderMessage = {
      role: "system",
      content: [
        {
          kind: "text",
          text: buildClassifyPrompt(input.cards, maxCards),
        },
      ],
    };

    const result = (await deps.providerAdapter.requestStructured({
      provider_id: providerId,
      messages: [
        systemMsg,
        {
          role: "user",
          content: [{ kind: "text", text: input.query }],
        },
      ],
      schema: ClassifyOutputSchema,
      schemaName: "L2ClassifyOutput",
    })) as z.infer<typeof ClassifyOutputSchema>;

    return {
      selectedKeys: result.selected_keys,
      reasoning: result.reasoning,
      degraded: false,
    };
  } catch {
    return degradeClassify(input);
  }
}
