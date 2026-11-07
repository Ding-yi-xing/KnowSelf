/**
 * l2-injector.ts — L2 卡片注入
 *
 * 把选中的 CardWithSections 注入为 system messages 数组，
 * 仅在 anthropic 协议时附加 cache_control（ephemeral）。
 */

import type { CardWithSections, Protocol, ProviderMessage } from "@knowself/contracts";

/** 将单张卡片格式化为注入文本。 */
function formatCard(card: CardWithSections): string {
  const header = `## 卡片：${card.card.title}\n摘要：${card.card.summary}`;
  if (card.sections.length === 0) return header;

  const sectionsText = card.sections.map((s) => `### ${s.title}\n${s.body}`).join("\n\n");
  return `${header}\n\n${sectionsText}`;
}

/**
 * 将选中卡片注入为 system messages 数组。
 * protocol === "anthropic" 时每条 message 带 cache_control。
 */
export function injectL2(cards: CardWithSections[], protocol: Protocol): ProviderMessage[] {
  if (cards.length === 0) return [];

  return cards.map((card) => {
    const msg: ProviderMessage = {
      role: "system",
      content: [{ kind: "text", text: formatCard(card) }],
    };

    if (protocol === "anthropic") {
      msg.cache_control = { type: "ephemeral" };
    }

    return msg;
  });
}
