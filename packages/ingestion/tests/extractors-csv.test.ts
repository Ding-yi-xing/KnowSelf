import { describe, it, expect } from "vitest";
import { csvExtractor } from "../dist/extractors/csv.js";
import { ExtractorFailedError } from "../dist/errors.js";
import type { ExtractorContext } from "../dist/extractors/types.js";

const ctx: ExtractorContext = {
  mimeType: "text/csv",
  originalName: "test.csv",
  maxChars: 1_000_000,
};

const SIMPLE_CSV = "name,age,city\nAlice,30,Beijing\nBob,25,Shanghai";

const CSV_WITH_QUOTES = `name,description
"Smith, John","He said ""hello"" to everyone"
"Doe, Jane","Lives in Paris, France"`;

const EMPTY_CSV = "";

describe("csvExtractor", () => {
  it("converts multi-column CSV to markdown table", async () => {
    const result = await csvExtractor.extract(SIMPLE_CSV, ctx);
    expect(result.text).toContain("| name | age | city |");
    expect(result.text).toContain("| --- | --- | --- |");
    expect(result.text).toContain("| Alice | 30 | Beijing |");
    expect(result.text).toContain("| Bob | 25 | Shanghai |");
  });

  it("handles quoted fields with commas and escaped quotes", async () => {
    const result = await csvExtractor.extract(CSV_WITH_QUOTES, ctx);
    expect(result.text).toContain("Smith, John");
    expect(result.text).toContain('He said "hello"');
    expect(result.text).toContain("Lives in Paris, France");
  });

  it("throws EXTRACTOR_FAILED for empty CSV", async () => {
    await expect(csvExtractor.extract(EMPTY_CSV, ctx)).rejects.toThrow(ExtractorFailedError);
  });

  it("respects maxChars truncation on long CSV", async () => {
    // Generate a large CSV
    let large = "col1,col2\n";
    for (let i = 0; i < 2000; i++) {
      large += `row${i}a,row${i}b\n`;
    }
    const smallCtx = { ...ctx, maxChars: 200 };
    const result = await csvExtractor.extract(large, smallCtx);
    expect(result.text.length).toBeLessThanOrEqual(200);
  });

  it("includes row_count in metadata.extra", async () => {
    const result = await csvExtractor.extract(SIMPLE_CSV, ctx);
    const extra = result.metadata.extra as { row_count?: number };
    // 1 header + 2 data rows = 3
    expect(extra.row_count).toBe(3);
  });
});
