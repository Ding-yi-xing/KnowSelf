/**
 * extractors/text.ts — 纯文本提取器
 *
 * 无格式转换，直接返回 Buffer 解码后的字符串。
 */

import type { ExtractorContext } from "./types";
import type { SupportedMimeType, RawText } from "@knowself/contracts";
import { truncateText } from "./types";

const ACCEPTS: readonly SupportedMimeType[] = ["text/plain"];

export const textExtractor = {
  accepts: ACCEPTS,

  async extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText> {
    const raw = typeof input === "string" ? input : input.toString("utf-8");
    const { text, truncated: _truncated } = truncateText(raw, ctx.maxChars);
    const wordCount = raw.split(/\s+/).filter(Boolean).length;

    return {
      text,
      sections: [],
      metadata: {
        title: ctx.originalName || undefined,
        word_count: wordCount,
        extra: {},
      },
    };
  },
};
