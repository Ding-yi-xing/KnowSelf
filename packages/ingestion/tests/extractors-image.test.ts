import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageExtractor } from "../src/extractors/image";
import type { ExtractorContext } from "../src/extractors/types";

const { recognizeMock } = vi.hoisted(() => ({
  recognizeMock: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  default: {
    recognize: recognizeMock,
  },
}));

describe("imageExtractor", () => {
  beforeEach(() => {
    recognizeMock.mockReset();
  });

  it("accepts common image MIME types", () => {
    expect(imageExtractor.accepts).toContain("image/png");
    expect(imageExtractor.accepts).toContain("image/jpeg");
    expect(imageExtractor.accepts).toContain("image/webp");
    expect(imageExtractor.accepts).toContain("image/gif");
  });

  it("extracts OCR text for image files", async () => {
    recognizeMock.mockResolvedValue({
      data: {
        text: "今天跑步 5 公里\nRead more books",
        confidence: 91,
      },
    });
    const ctx: ExtractorContext = {
      mimeType: "image/png",
      originalName: "vision-board.png",
      maxChars: 1_000,
    };

    const result = await imageExtractor.extract(Buffer.from([0x89, 0x50, 0x4e, 0x47]), ctx);

    expect(result.text).toContain("图片资料");
    expect(result.text).toContain("vision-board.png");
    expect(result.text).toContain("OCR识别文本");
    expect(result.text).toContain("今天跑步 5 公里");
    expect(result.metadata.extra.ocr_performed).toBe(true);
    expect(result.metadata.extra.ocr_has_text).toBe(true);
    expect(result.metadata.extra.ocr_confidence).toBe(91);
    expect(recognizeMock).toHaveBeenCalledWith(expect.any(Buffer), "eng+chi_sim", {
      logger: expect.any(Function),
    });
  });

  it("falls back to metadata text when OCR fails", async () => {
    recognizeMock.mockRejectedValue(new Error("bad image"));
    const ctx: ExtractorContext = {
      mimeType: "image/png",
      originalName: "vision-board.png",
      maxChars: 1_000,
    };

    const result = await imageExtractor.extract(Buffer.from([0x89, 0x50, 0x4e, 0x47]), ctx);

    expect(result.text).toContain("图片资料");
    expect(result.text).toContain("OCR 识别失败");
    expect(result.metadata.extra.ocr_performed).toBe(true);
    expect(result.metadata.extra.ocr_has_text).toBe(false);
    expect(result.metadata.extra.ocr_error).toBe("bad image");
  });
});
