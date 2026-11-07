/**
 * files.ts — Source 字节文件的存取
 *
 * 所有 source file 存入 `<sourcesDir>/<sourceId><ext>`。
 * kind=paste 的 source 没有物理文件，走 sourceFilePath 返回 null。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { SupportedMimeType, SourceStored } from "@knowself/contracts";
import { mimeToExt } from "./mime";

/**
 * 将文件字节写入 sourcesDir 下，文件名为 `<sourceId><ext>`。
 * 返回相对 sourcesDir 的路径。
 */
export async function saveSourceFile(
  sourcesDir: string,
  sourceId: string,
  bytes: Buffer,
  mime: SupportedMimeType,
): Promise<string> {
  const ext = mimeToExt(mime);
  const filename = `${sourceId}${ext}`;
  const fullPath = path.join(sourcesDir, filename);

  await fs.mkdir(sourcesDir, { recursive: true });
  await fs.writeFile(fullPath, bytes);

  return filename;
}

/**
 * 删除 source 的物理文件（相对 sourcesDir）。
 */
export async function removeSourceFile(sourcesDir: string, relativePath: string): Promise<void> {
  const fullPath = path.join(sourcesDir, relativePath);
  try {
    await fs.unlink(fullPath);
  } catch {
    // 文件不存在不是错误——幂等删除
  }
}

/**
 * 根据 SourceStored 计算其源文件的绝对路径。
 * kind=paste 或 file_path 为 null 时返回 null。
 */
export function sourceFilePath(sourcesDir: string, source: SourceStored): string | null {
  if (!source.file_path) return null;
  return path.join(sourcesDir, source.file_path);
}
