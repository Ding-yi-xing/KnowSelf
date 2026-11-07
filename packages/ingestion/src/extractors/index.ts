/**
 * extractors/index.ts — Extractor 注册表
 *
 * 按 MIME 类型路由到对应 extractor 实现。
 * pickExtractor 找不到对应实现时抛 UnsupportedMimeError。
 */

import type { SupportedMimeType } from "@knowself/contracts";
import type { IExtractor } from "./types";
import { textExtractor } from "./text";
import { markdownExtractor } from "./markdown";
import { htmlExtractor } from "./html";
import { pdfExtractor } from "./pdf";
import { docxExtractor } from "./docx";
import { csvExtractor } from "./csv";
import { xlsxExtractor } from "./xlsx";
import { imageExtractor } from "./image";
import { UnsupportedMimeError } from "../errors";

/** 已注册的全部 extractor 实例。 */
const ALL_EXTRACTORS: readonly IExtractor[] = [
  textExtractor,
  markdownExtractor,
  htmlExtractor,
  pdfExtractor,
  docxExtractor,
  csvExtractor,
  xlsxExtractor,
  imageExtractor,
];

/** mime → extractor 的快速索引，在首次调用时构建。 */
let _byMime: Map<SupportedMimeType, IExtractor> | null = null;

function buildMimeIndex(): Map<SupportedMimeType, IExtractor> {
  if (_byMime) return _byMime;
  _byMime = new Map();
  for (const e of ALL_EXTRACTORS) {
    for (const m of e.accepts) {
      _byMime.set(m, e);
    }
  }
  return _byMime;
}

/**
 * 按 MIME 类型选取 extractor。
 * 找不到匹配的实现时抛 UnsupportedMimeError。
 */
export function pickExtractor(mime: SupportedMimeType): IExtractor {
  const index = buildMimeIndex();
  const ex = index.get(mime);
  if (!ex) {
    throw new UnsupportedMimeError(mime);
  }
  return ex;
}

/**
 * 列出所有已注册的 extractor（调试用）。
 */
export function listExtractors(): readonly IExtractor[] {
  return ALL_EXTRACTORS;
}

export type { IExtractor, ExtractorContext } from "./types";
export { truncateText } from "./types";
