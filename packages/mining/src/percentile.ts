/**
 * `Percentile`（DESIGN-12 §3.3.2/§3.3.4）：分位数计算。
 * 采用 nearest-rank（`ceil(p * n) - 1` 取位）——确定性、可解释（附录 B #6）；
 * 空样本返回 `null`（调用方决定是否落指标行）。
 * 近似直方图（§3.3.4 的 1000 桶对数直方图）由 reply-latency 组件在超 `HISTOGRAM_THRESHOLD` 时使用。
 */

/** 升序样本中第 p 百分位（0 < p ≤ 1）；空数组返回 null。 */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const index = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(index, sortedAsc.length - 1))] ?? null;
}

/** 排序后取 P50 / P90 / 均值（DESIGN-12 指标键 11/19/20/21/23）。 */
export function describeSamples(
  samples: readonly number[],
): { p50: number | null; p90: number | null; mean: number | null } {
  if (samples.length === 0) return { p50: null, p90: null, mean: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    mean: sum / sorted.length,
  };
}

/** 1000 桶对数直方图近似分位数（§3.3.4 大样本降级路径）；返回 `{ bucket_index, approximate: true }` 语义的 JSON 载荷。 */
export function logHistogram(
  samples: readonly number[],
  bucketCount = 1000,
): { histogram: number[]; maxValue: number; approximate: true } {
  const maxValue = samples.reduce((acc, value) => Math.max(acc, value), 1);
  const histogram = Array.from({ length: bucketCount }, () => 0);
  for (const value of samples) {
    const bucket = Math.min(
      bucketCount - 1,
      Math.floor((Math.log(value + 1) / Math.log(maxValue + 1)) * bucketCount),
    );
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
  return { histogram, maxValue, approximate: true };
}

export const Percentile = { percentile, describeSamples, logHistogram };
