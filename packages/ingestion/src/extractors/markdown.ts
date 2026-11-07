/**
 * extractors/markdown.ts — Markdown 提取器
 *
 * 直接返回 RawText。文本即原始 Markdown 源码。
 * V2 可引入 markdown-it / remark 做 AST 级结构化抽取（标题→sections）。
 */

import type { ExtractorContext } from "./types";
import type { SupportedMimeType, RawText } from "@knowself/contracts";
import { truncateText } from "./types";

const ACCEPTS: readonly SupportedMimeType[] = ["text/markdown"];

/** 从行中提取可能的标题信息（# 开头的行）。 */
function extractHeadings(md: string): RawText["sections"] {
  const lines = md.split("\n");
  const sections: RawText["sections"] = [];
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const level = match[1]!.length;
    const heading = match[2]!.trim().slice(0, 200);
    const bodyStart = md.indexOf(line) + line.length;
    const nextHeadingIdx = findNextHeadingIndex(md, bodyStart);
    const bodyText = md.slice(bodyStart, nextHeadingIdx).trim().slice(0, 50_000);
    sections.push({ heading, body: bodyText || heading, level });
  }
  return sections.slice(0, 256);
}

function findNextHeadingIndex(md: string, from: number): number {
  const next = md.slice(from).search(/^#{1,6}\s/m);
  return next === -1 ? md.length : from + next;
}

export const markdownExtractor = {
  accepts: ACCEPTS,

  async extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText> {
    const raw = typeof input === "string" ? input : input.toString("utf-8");
    const { text, truncated: _truncated } = truncateText(raw, ctx.maxChars);
    const sections = extractHeadings(raw);
    const wordCount = raw.split(/\s+/).filter(Boolean).length;

    return {
      text,
      sections,
      metadata: {
        title: ctx.originalName || undefined,
        word_count: wordCount,
        extra: {},
      },
    };
  },
};
