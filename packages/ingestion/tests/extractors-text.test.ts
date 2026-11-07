import { describe, it, expect } from "vitest";
import { textExtractor } from "../src/extractors/text";
import type { ExtractorContext } from "../src/extractors/types";

const ctx: ExtractorContext = {
  mimeType: "text/plain",
  originalName: "test.txt",
  maxChars: 1_000_000,
};

describe("textExtractor", () => {
  it("accepts 数组包含 'text/plain'", () => {
    expect(textExtractor.accepts).toContain("text/plain");
  });

  it("extract 输入 Buffer 正确 utf-8 解码", async () => {
    const buf = Buffer.from("你好世界", "utf-8");
    const result = await textExtractor.extract(buf, ctx);
    expect(result.text).toBe("你好世界");
  });

  it("extract 输入纯字符串原样返回", async () => {
    const result = await textExtractor.extract("hello world", ctx);
    expect(result.text).toBe("hello world");
  });

  it("extract 计算 word_count 正确（用 \\s+ 分词，过滤空串）", async () => {
    const result = await textExtractor.extract("hello world foo bar", ctx);
    expect(result.metadata.word_count).toBe(4);
  });
});
