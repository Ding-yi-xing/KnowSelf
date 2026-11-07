/**
 * extractors/types.ts — IExtractor 接口 + ExtractorContext
 *
 * 所有 extractor 实现此接口。extract 方法接收 Buffer 或 string，
 * 返回统一 RawText 形状。ExtractorContext 提供元信息便于日志 / 调试。
 */

import type { SupportedMimeType, RawText } from "@knowself/contracts";

/**
 * extract 的上下文，提供 mime、原始文件名、字符上限等元信息。
 */
export interface ExtractorContext {
  mimeType: SupportedMimeType;
  originalName: string;
  maxChars: number;
}

/**
 * 单种格式的提取器接口。
 * - accepts: 本 extractor 能处理的 MIME 类型列表
 * - extract: 从输入抽取纯文本（Buffer 来自文件，string 来自 URL 返回或粘贴文本）
 */
export interface IExtractor {
  readonly accepts: readonly SupportedMimeType[];
  extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText>;
}

/**
 * 将超过 maxChars 的文本截断并标记 truncated。
 * extractor 在返回前调此函数。
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true };
}
