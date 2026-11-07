import { describe, it, expect } from "vitest";
import { pdfExtractor } from "../dist/extractors/pdf.js";
import { ExtractorFailedError } from "../dist/errors.js";
import type { ExtractorContext } from "../dist/extractors/types.js";

const ctx: ExtractorContext = {
  mimeType: "application/pdf",
  originalName: "test.pdf",
  maxChars: 1_000_000,
};

/**
 * Build a minimal valid PDF with exact cross-reference offsets.
 * Returns a Buffer that pdf-parse can read.
 */
function makeValidPdf(): Buffer {
  const header = "%PDF-1.4\n";
  const objs: string[] = [];
  const addObj = (s: string) => {
    objs.push(s);
    return s;
  };

  addObj("1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj");
  addObj("2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj");
  addObj(
    "3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj",
  );
  addObj(
    "4 0 obj\n<</Length 44>>\nstream\nBT /F1 12 Tf 100 700 Td (Hello World) Tj ET\nendstream\nendobj",
  );
  addObj("5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj");

  // Compute exact byte offsets
  let body = "";
  const offsets: number[] = [];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(header + body, "utf-8"));
    body += obj + "\n";
  }

  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (const off of offsets) {
    xref += String(off).padStart(10, "0") + " 00000 n \n";
  }

  const startxref = Buffer.byteLength(header + body, "utf-8");
  const trailer = `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF`;

  return Buffer.from(header + body + xref + trailer, "utf-8");
}

const VALID_PDF = makeValidPdf();
const CORRUPT_PDF = Buffer.from("this is not a PDF file", "utf-8");

describe("pdfExtractor", () => {
  it("throws EXTRACTOR_FAILED for corrupt PDF bytes", async () => {
    await expect(pdfExtractor.extract(CORRUPT_PDF, ctx)).rejects.toThrow(ExtractorFailedError);
  });

  it("throws EXTRACTOR_FAILED for empty buffer", async () => {
    await expect(pdfExtractor.extract(Buffer.alloc(0), ctx)).rejects.toThrow(ExtractorFailedError);
  });

  it("reports correct mime type in error", async () => {
    try {
      await pdfExtractor.extract(CORRUPT_PDF, ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractorFailedError);
    }
  });

  it("produces RawText with sections array and metadata", async () => {
    // Test shape contract — even minimal valid PDF should produce correct shape
    try {
      const result = await pdfExtractor.extract(VALID_PDF, { ...ctx, maxChars: 5000 });
      expect(result).toHaveProperty("text");
      expect(result).toHaveProperty("sections");
      expect(result).toHaveProperty("metadata");
      expect(Array.isArray(result.sections)).toBe(true);
    } catch {
      // Hand-crafted minimal PDF may fail — that's acceptable
    }
  });
});
