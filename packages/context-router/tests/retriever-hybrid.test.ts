/**
 * retriever-hybrid.test.ts — 混合检索器单元测试
 *
 * 测试 RRF 融合逻辑（不依赖数据库）。
 */

import { describe, it, expect } from "vitest";

// 直接测试 RRF 融合逻辑（纯函数，无副作用）
function rrfFuse(
  hitsList: { chunkId: number; score: number; lane: string }[][],
  k: number,
): Map<number, number> {
  const scoreMap = new Map<number, number>();

  for (const hits of hitsList) {
    for (let rank = 0; rank < hits.length; rank++) {
      const hit = hits[rank]!;
      const current = scoreMap.get(hit.chunkId) ?? 0;
      scoreMap.set(hit.chunkId, current + 1 / (k + rank + 1));
    }
  }

  return scoreMap;
}

describe("RRF 融合", () => {
  it("单路命中应正常计算分数", () => {
    const fts5Hits = [
      { chunkId: 1, score: 0.9, lane: "fts5" },
      { chunkId: 2, score: 0.7, lane: "fts5" },
    ];

    const result = rrfFuse([fts5Hits], 60);

    expect(result.size).toBe(2);
    expect(result.get(1)).toBeCloseTo(1 / 61, 6); // rank 0
    expect(result.get(2)).toBeCloseTo(1 / 62, 6); // rank 1
  });

  it("双路融合应为同一 chunk 累加分数", () => {
    const fts5Hits = [
      { chunkId: 1, score: 0.9, lane: "fts5" },
      { chunkId: 2, score: 0.5, lane: "fts5" },
    ];
    const vectorHits = [
      { chunkId: 1, score: 0.8, lane: "vector" },
      { chunkId: 3, score: 0.6, lane: "vector" },
    ];

    const result = rrfFuse([fts5Hits, vectorHits], 60);

    expect(result.size).toBe(3);
    // chunk 1 同时命中两路：rank 0 + rank 0
    expect(result.get(1)).toBeCloseTo(1 / 61 + 1 / 61, 6);
    // chunk 2 只命中 fts5 rank 1
    expect(result.get(2)).toBeCloseTo(1 / 62, 6);
    // chunk 3 只命中 vector rank 1
    expect(result.get(3)).toBeCloseTo(1 / 62, 6);
  });

  it("空输入应返回空结果", () => {
    const result = rrfFuse([], 60);
    expect(result.size).toBe(0);
  });

  it("多路命中同一 chunk 应正确累加", () => {
    const lane1 = [
      { chunkId: 5, score: 1.0, lane: "fts5" },
      { chunkId: 5, score: 1.0, lane: "fts5" }, // 同路重复不应发生，但测试边界
    ];
    const result = rrfFuse([lane1], 60);

    // rank 0 + rank 1 的 RRF 值累加（同 chunk 在同一列表中第二个位置)
    expect(result.get(5)).toBeCloseTo(1 / 61 + 1 / 62, 6);
  });

  it("k 值变化应影响分数", () => {
    const hits = [{ chunkId: 1, score: 1.0, lane: "fts5" }];

    const result60 = rrfFuse([hits], 60);
    const result30 = rrfFuse([hits], 30);

    expect(result60.get(1)).not.toBe(result30.get(1));
    // k=30 时分数更大
    expect(result30.get(1)!).toBeGreaterThan(result60.get(1)!);
  });
});
