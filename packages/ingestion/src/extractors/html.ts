/**
 * extractors/html.ts — HTML 提取器
 *
 * 用简单正则提取 HTML 中的纯文本，剥离标签与 script/style。
 * V2 可引入 @mozilla/readability + jsdom 做正文提取。
 */

import type { ExtractorContext } from "./types";
import type { SupportedMimeType, RawText } from "@knowself/contracts";
import { truncateText } from "./types";

const ACCEPTS: readonly SupportedMimeType[] = ["text/html"];

/** 移除 script / style 标签及其内容，再去除所有 HTML 标签。 */
function stripHtml(html: string): string {
  // 1. 移除 script 与 style 块（含其内容）
  const noScripts = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // 2. 移除所有 HTML 标签
  const noTags = noScripts.replace(/<[^>]+>/g, " ");
  // 3. 替换 HTML 实体
  const unescaped = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // 4. 压缩空白
  return unescaped.replace(/\s+/g, " ").trim();
}

/** 从 HTML 中提取 h1-h3 的大纲作为 sections。 */
function extractHeadings(html: string): RawText["sections"] {
  const sections: RawText["sections"] = [];
  const headingRe = /<h([1-3])\b[^>]*>(.+?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(html)) !== null) {
    const level = parseInt(match[1]!, 10);
    const heading = stripHtml(match[2]!).slice(0, 200);
    const bodyStart = headingRe.lastIndex;
    const nextIdx = findNextHeading(html, bodyStart);
    const body = stripHtml(html.slice(bodyStart, nextIdx)).slice(0, 50_000);
    sections.push({ heading, body: body || heading, level });
  }
  return sections.slice(0, 256);
}

function findNextHeading(html: string, from: number): number {
  const next = html.slice(from).search(/<h[1-3]\b/);
  return next === -1 ? html.length : from + next;
}

export const htmlExtractor = {
  accepts: ACCEPTS,

  async extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText> {
    const raw = typeof input === "string" ? input : input.toString("utf-8");
    const stripped = stripHtml(raw);
    const { text, truncated: _truncated } = truncateText(stripped, ctx.maxChars);
    const sections = extractHeadings(raw);
    const wordCount = text.split(/\s+/).filter(Boolean).length;

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
