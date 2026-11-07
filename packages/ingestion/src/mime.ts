/**
 * mime.ts — MIME 类型推断与校验
 *
 * 从文件扩展名推断 SupportedMimeType；对已获取的 content-type 做白名单检查。
 */

import type { SupportedMimeType } from "@knowself/contracts";

/** 扩展名（含点）到 SupportedMimeType 的映射表。 */
const EXT_TO_MIME: Record<string, SupportedMimeType> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 所有受支持的 MIME 字符串集合，用于白名单检查。 */
const SUPPORTED_MIMES: Set<string> = new Set(Object.values(EXT_TO_MIME));

/**
 * 按文件名扩展名推断受支持的 MIME 类型。
 * 找不到匹配的扩展名返回 null。
 */
export function inferMime(filename: string): SupportedMimeType | null {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return null;
  const ext = filename.slice(lastDot).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * 检查给定 MIME 字符串是否在支持白名单中。
 */
export function isSupportedMime(m: string): boolean {
  return SUPPORTED_MIMES.has(m);
}

/**
 * 把 inferMime 的结果对应的扩展名反查出来。
 * 主要用于从 mime_type 推导源码文件的扩展名。
 */
export function mimeToExt(mime: SupportedMimeType): string {
  for (const [ext, m] of Object.entries(EXT_TO_MIME)) {
    if (m === mime) return ext;
  }
  // 默认回退；理论上不会走到这里
  return ".bin";
}
