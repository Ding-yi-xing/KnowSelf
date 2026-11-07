/** JSON.parse 包装；失败返回 fallback，不抛错 */
export function parseJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON.stringify 包装 */
export function stringifyJsonColumn(value: unknown): string {
  return JSON.stringify(value);
}
