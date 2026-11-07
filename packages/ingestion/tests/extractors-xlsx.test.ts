import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { xlsxExtractor } from "../dist/extractors/xlsx.js";
import { ExtractorFailedError } from "../dist/errors.js";
import type { ExtractorContext } from "../dist/extractors/types.js";
import ExcelJS from "exceljs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ctx: ExtractorContext = {
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  originalName: "test.xlsx",
  maxChars: 1_000_000,
};

let xlsxPath: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ks-xlsx-"));
  xlsxPath = join(tmpDir, "test.xlsx");

  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet("Sales");
  s1.addRow(["Product", "Qty", "Price"]);
  s1.addRow(["Widget", "10", "$5.00"]);
  s1.addRow(["Gadget", "3", "$12.50"]);

  const _s2 = wb.addWorksheet("Empty");
  // Leave empty

  const s3 = wb.addWorksheet("Users");
  s3.addRow(["Name", "Role"]);
  s3.addRow(["Alice", "Admin"]);

  await wb.xlsx.writeFile(xlsxPath);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("xlsxExtractor", () => {
  it("extracts non-empty sheets to markdown", async () => {
    const buf = readFileSync(xlsxPath);
    const result = await xlsxExtractor.extract(buf, ctx);

    expect(result.text).toContain("## Sales");
    expect(result.text).toContain("| Product | Qty | Price |");
    expect(result.text).toContain("| Widget | 10 | $5.00 |");

    expect(result.text).toContain("## Users");
    expect(result.text).toContain("| Alice | Admin |");
  });

  it("skips empty sheets", async () => {
    const buf = readFileSync(xlsxPath);
    const result = await xlsxExtractor.extract(buf, ctx);
    expect(result.text).not.toContain("## Empty");
  });

  it("reports correct sheet_count in metadata.extra", async () => {
    const buf = readFileSync(xlsxPath);
    const result = await xlsxExtractor.extract(buf, ctx);
    const extra = result.metadata.extra as { sheet_count?: number };
    expect(extra.sheet_count).toBe(2); // Sales + Users, not Empty
  });

  it("throws EXTRACTOR_FAILED for corrupt xlsx", async () => {
    const bad = Buffer.from("not an xlsx file");
    await expect(xlsxExtractor.extract(bad, ctx)).rejects.toThrow(ExtractorFailedError);
  });

  it("respects maxChars truncation", async () => {
    const buf = readFileSync(xlsxPath);
    const smallCtx = { ...ctx, maxChars: 20 };
    const result = await xlsxExtractor.extract(buf, smallCtx);
    expect(result.text.length).toBeLessThanOrEqual(20);
  });
});
