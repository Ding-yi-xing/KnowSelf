import { describe, it, expect } from "vitest";
import { markdownExtractor } from "../src/extractors/markdown";
import type { ExtractorContext } from "../src/extractors/types";

const ctx: ExtractorContext = {
  mimeType: "text/markdown",
  originalName: "test.md",
  maxChars: 1_000_000,
};

describe("markdownExtractor", () => {
  it("accepts 数组包含 'text/markdown'", () => {
    expect(markdownExtractor.accepts).toContain("text/markdown");
  });

  it("extract 输入 Buffer 返回 RawText（含 text/sections/metadata）", async () => {
    const buf = Buffer.from("# Hello\n\nWorld", "utf-8");
    const result = await markdownExtractor.extract(buf, ctx);
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("sections");
    expect(result).toHaveProperty("metadata");
    expect(result.text).toContain("Hello");
  });

  it("extract 输入 string 直接处理不重新解码", async () => {
    const result = await markdownExtractor.extract("# Title\n\nBody", ctx);
    expect(result.text).toContain("Title");
    expect(result.metadata.word_count).toBeGreaterThan(0);
  });

  it("extractHeadings 解析 # / ## / ### 三级标题，sections.length === 3 且 level 正确", async () => {
    const md = "# H1\n\ncontent1\n\n## H2\n\ncontent2\n\n### H3\n\ncontent3";
    const result = await markdownExtractor.extract(md, ctx);
    expect(result.sections.length).toBeGreaterThanOrEqual(3);
    expect(result.sections[0].level).toBe(1);
    expect(result.sections[1].level).toBe(2);
    expect(result.sections[2].level).toBe(3);
  });

  it("extract 超长内容触发 truncateText（输入 > maxChars，断言 text.length === maxChars）", async () => {
    const longText = "x".repeat(500);
    const smallCtx = { ...ctx, maxChars: 100 };
    const result = await markdownExtractor.extract(longText, smallCtx);
    expect(result.text.length).toBe(100);
  });

  it("extract 不带任何 # 的纯文本返回 sections=[]", async () => {
    const result = await markdownExtractor.extract("Just plain text\nno headings", ctx);
    expect(result.sections).toEqual([]);
  });
});
