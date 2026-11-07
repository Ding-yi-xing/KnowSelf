/**
 * extractors/docx.ts — DOCX 提取器（占位）
 *
 * 需要 mammoth 依赖。当前占位抛错，让 tsc 编译通过。
 */

import type { ExtractorContext } from "./types";
import type { SupportedMimeType, RawText } from "@knowself/contracts";
import { ExtractorFailedError } from "../errors";

const ACCEPTS: readonly SupportedMimeType[] = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export const docxExtractor = {
  accepts: ACCEPTS,

  async extract(_input: Buffer | string, _ctx: ExtractorContext): Promise<RawText> {
    throw new ExtractorFailedError(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "DOCX extractor requires mammoth dependency",
    );
  },
};
