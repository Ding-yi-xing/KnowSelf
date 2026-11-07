import { describe, it, expect } from "vitest";
import { htmlExtractor } from "../dist/extractors/html.js";
import type { ExtractorContext } from "../dist/extractors/types.js";

const ctx: ExtractorContext = {
  mimeType: "text/html",
  originalName: "test.html",
  maxChars: 1_000_000,
};

const FULL_PAGE = `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article>
    <h1>Main Title</h1>
    <p>This is the main content of the page. It has multiple sentences and should be extracted properly by the HTML extractor.</p>
    <h2>Section Two</h2>
    <p>This is the second section with additional content that should appear after the first heading in the extracted output.</p>
  </article>
  <aside>Sidebar content that should be stripped.</aside>
  <script>console.log('script should be removed completely');</script>
  <style>body { color: red; }</style>
</body></html>`;

const SHORT_PAGE = "<html><body><p>Hi</p></body></html>";

const NO_BODY_PAGE = "<html><head><title>No body here</title></head></html>";

describe("htmlExtractor", () => {
  it("extracts text content from HTML page", async () => {
    const result = await htmlExtractor.extract(FULL_PAGE, ctx);
    expect(result.text.length).toBeGreaterThan(50);
    expect(result.text).toContain("Main Title");
    expect(result.text).toContain("Section Two");
  });

  it("strips script and style tags", async () => {
    const result = await htmlExtractor.extract(FULL_PAGE, ctx);
    expect(result.text).not.toContain("console.log");
    expect(result.text).not.toContain("body { color: red");
  });

  it("strips HTML tags from output", async () => {
    const result = await htmlExtractor.extract(FULL_PAGE, ctx);
    expect(result.text).not.toContain("<script>");
    expect(result.text).not.toContain("<style>");
    expect(result.text).not.toContain("<nav>");
  });

  it("extracts headings as sections with correct level", async () => {
    const result = await htmlExtractor.extract(FULL_PAGE, ctx);
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    expect(result.sections[0]!.heading).toBe("Main Title");
    expect(result.sections[0]!.level).toBe(1);
    expect(result.sections[1]!.heading).toBe("Section Two");
    expect(result.sections[1]!.level).toBe(2);
  });

  it("handles very short pages gracefully", async () => {
    const result = await htmlExtractor.extract(SHORT_PAGE, ctx);
    // Should not crash; may or may not have content
    expect(result.text).toBeDefined();
  });

  it("handles pages without body tag", async () => {
    const result = await htmlExtractor.extract(NO_BODY_PAGE, ctx);
    expect(result.text).toBeDefined();
  });

  it("respects maxChars truncation", async () => {
    const smallCtx = { ...ctx, maxChars: 10 };
    const result = await htmlExtractor.extract(FULL_PAGE, smallCtx);
    expect(result.text.length).toBeLessThanOrEqual(10);
  });
});
