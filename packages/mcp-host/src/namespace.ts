/**
 * namespace.ts — 工具命名空间操作
 *
 * 所有工具名加前缀 `<sourceId>__<bareName>`。
 * ToolRegistry 调用时按 `__` 第一段拆分回真实来源。
 */
import type { ToolSourceId, ToolBareName, ToolFullName } from "@knowself/contracts";

const SEP = "__";

/**
 * 将 sourceId 与裸名组合成全名。
 * 先校验 sourceId 不含 `__`。
 */
export function toFullName(sourceId: ToolSourceId, bareName: ToolBareName): ToolFullName {
  if (sourceId.includes(SEP)) {
    throw new Error(`sourceId must not contain "${SEP}": ${sourceId}`);
  }
  return `${sourceId}${SEP}${bareName}`;
}

/**
 * 按第一处 `__` 拆分全名为 sourceId + bareName。
 * 找不到分隔符返回 null。
 */
export function fromFullName(
  full: ToolFullName,
): { sourceId: ToolSourceId; bareName: ToolBareName } | null {
  const idx = full.indexOf(SEP);
  if (idx <= 0) return null;
  const sourceId = full.slice(0, idx);
  const bareName = full.slice(idx + SEP.length);
  if (bareName.length === 0) return null;
  return { sourceId, bareName };
}

/**
 * 校验并返回 ToolSourceId。
 * 检查禁止字符串 `__`。
 */
export function ensureSourceId(s: string): ToolSourceId {
  if (s.includes(SEP)) {
    throw new Error(`sourceId must not contain "${SEP}": ${s}`);
  }
  return s;
}
