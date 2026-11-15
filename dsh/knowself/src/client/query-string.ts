/**
 * 查询串拼装（client 端 REST 端口共用的小工具，M3 波 3 抽出）。
 *
 * 画像 / 日志 / 待整理 / 资料端口（`profile-port.ts`）与图谱端口（`graph-port.ts`）
 * 需要完全一致的拼串规则：**跳过 `undefined`**（未提供的参数不出现在 URL 里，
 * 避免把「不过滤」写成 `?status=`），键与值都做 `encodeURIComponent`。
 * 抽成一个模块而不是各自复制一份，保证两个端口的 URL 形状不会漂移
 * （`test/profile-port.test.ts` / `test/m3c-client.test.ts` 各自断言了 URL 字面量）。
 *
 * 零依赖、纯函数。
 */

/**
 * 拼 query string。
 * @param params 键值对序列（值为 `undefined` = 不参与查询）
 * @returns `""`（无参数）或 `"?a=1&b=2"`
 */
export function toQueryString(
  params: readonly (readonly [string, string | undefined])[],
): string {
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (value === undefined) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}
