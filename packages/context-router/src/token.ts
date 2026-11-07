/**
 * token.ts — 简易 token 计数器
 *
 * MVP 阶段用字符数 / 3.5 估算；后续可替换为 tiktoken / Anthropic tokenizer。
 * countTokens 是纯函数；getTokenCounter 按 protocol 返回对应计数器。
 */

import type { Protocol } from "@knowself/contracts";

/**
 * 估算文本的 token 数。
 * 默认用字符数 / 3.5（中英文混合场景的粗略经验值）。
 */
export function countTokens(text: string, _protocol?: Protocol): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.5));
}

/**
 * 按 provider protocol 返回对应的 token 计数函数。
 * MVP 阶段所有 protocol 共享同一简易计数器。
 */
export function getTokenCounter(_protocol?: Protocol): (s: string) => number {
  return (text: string) => countTokens(text);
}
