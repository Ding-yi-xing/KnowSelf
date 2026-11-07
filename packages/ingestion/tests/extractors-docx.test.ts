import { describe, it, expect } from "vitest";
import { docxExtractor } from "../src/extractors/docx";
import { ExtractorFailedError } from "../src/errors";

describe("docxExtractor", () => {
  it("accepts 数组包含 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'", () => {
    expect(docxExtractor.accepts).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("extract 任意输入抛 ExtractorFailedError", async () => {
    await expect(docxExtractor.extract(Buffer.from("test"), {} as any)).rejects.toThrow(
      ExtractorFailedError,
    );
  });

  it("抛出的 error.code === 'EXTRACTOR_FAILED'", async () => {
    try {
      await docxExtractor.extract(Buffer.from("test"), {} as any);
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractorFailedError);
      expect((err as ExtractorFailedError).code).toBe("EXTRACTOR_FAILED");
    }
  });
});
