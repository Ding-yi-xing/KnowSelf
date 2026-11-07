import type { ExtractorContext } from "./types";
import type { SupportedMimeType, RawText } from "@knowself/contracts";
import { ExtractorFailedError } from "../errors";
import { truncateText } from "./types";
import pdfParse from "pdf-parse";

const ACCEPTS: readonly SupportedMimeType[] = ["application/pdf"];

export const pdfExtractor = {
  accepts: ACCEPTS,

  async extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText> {
    const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
    if (buf.length === 0 || isPdfEmpty(buf)) {
      throw new ExtractorFailedError("application/pdf", "PDF has no extractable text");
    }

    let data: { text: string; numpages: number };
    try {
      data = await pdfParse(buf);
    } catch (err) {
      throw new ExtractorFailedError(
        "application/pdf",
        err instanceof Error ? err.message : "pdf-parse failed",
      );
    }

    const { text } = truncateText((data.text ?? "").replace(/\s+/g, " ").trim(), ctx.maxChars);

    return {
      text,
      sections: [],
      metadata: {
        title: ctx.originalName || undefined,
        page_count: data.numpages,
        word_count: text.split(/\s+/).filter(Boolean).length,
        extra: {},
      },
    };
  },
};

// Minimal PDF header check to detect obviously non-PDF / empty files
function isPdfEmpty(buf: Buffer): boolean {
  const head = buf.slice(0, 5).toString("utf-8");
  return head !== "%PDF-";
}
