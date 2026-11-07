/**
 * l1-injector.ts — L1 核心档案注入
 *
 * 把 CoreProfileStored 注入为单条 system message，
 * 仅在 anthropic 协议时附加 cache_control（ephemeral）。
 */

import type { CoreProfileStored, Protocol, ProviderMessage } from "@knowself/contracts";

/** 构建 L1 system prompt 文本。 */
function buildL1Text(core: CoreProfileStored): string {
  const tagsLine = core.section_tags.length > 0 ? `\n标签：${core.section_tags.join("、")}` : "";
  return `你是 ${core.display_name} 的 AI 助手。以下是用户的核心档案，请在对话中始终参考：\n\n---\n${core.body}\n---${tagsLine}`;
}

/**
 * 将核心档案注入为 system message。
 * protocol === "anthropic" 时带 cache_control: { type: "ephemeral" }。
 */
export function injectL1(core: CoreProfileStored, protocol: Protocol): ProviderMessage {
  const msg: ProviderMessage = {
    role: "system",
    content: [{ kind: "text", text: buildL1Text(core) }],
  };

  if (protocol === "anthropic") {
    msg.cache_control = { type: "ephemeral" };
  }

  return msg;
}
