/**
 * JSON 列读写包装（DESIGN-13 §2.2）。
 * 口径与 `packages/profile-store/src/json.ts` 一致：解析失败按 fallback 兜底，**不抛错**。
 */

/** `JSON.parse` 包装；失败返回 fallback。 */
export function parseJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** `JSON.stringify` 包装。 */
export function stringifyJsonColumn(value: unknown): string {
  return JSON.stringify(value);
}
