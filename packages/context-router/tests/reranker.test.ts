/**
 * reranker.test.ts 鈥?LLM Reranker 鍗曞厓娴嬭瘯锛坢ock provider 璋冪敤锛? */

import { describe, it, expect, vi } from "vitest";
import { rerank } from "../src/retriever/reranker";
import type { RetrievedDoc, RetrieverConfig } from "@knowself/contracts";
import type { ProviderAdapter } from "@knowself/provider-adapter";

function makeDoc(overrides?: Partial<RetrievedDoc>): RetrievedDoc {
  return {
    chunk_id: "1",
    doc_id: "card_test",
    doc_source: "card",
    doc_path: "card_test",
    parent_text: "Test document content.",
    tokens: 10,
    score: 0.5,
    lanes: ["fts5"],
    rerank_rank: null,
    tags: [],
    updated_at: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

function mockProvider(): ProviderAdapter {
  return {
    requestStructured: vi.fn(),
    pickProvider: vi.fn(),
  } as unknown as ProviderAdapter;
}

const baseConfig: RetrieverConfig = {
  enabled: true,
  embedding_model_id: "qwen3-embedding:0.6b",
  embedding_cache_dir: "data/models",
  chunk_target_tokens: 256,
  chunk_overlap_tokens: 32,
  parent_max_tokens: 2000,
  rrf_k: 60,
  rerank_provider_id: "",
  rerank_model: "",
  rerank_top_k: 30,
  rerank_timeout_ms: 15000,
  classifier_provider_id: "",
  classifier_max_cards: 3,
  token_budget: 20000,
  token_budget_l1: 1500,
  token_budget_l2: 2500,
  token_budget_l3: 4000,
  token_budget_history: 6000,
  freshness_boost: 0.1,
  memory_load_threshold: 5000,
  fallback_when_no_embed: true,
  fallback_when_no_rerank: true,
  fallback_when_no_classify: "last_used",
};

describe("rerank", () => {
  it("鍊欓€夋暟涓?0 鏃剁洿鎺ヨ繑鍥?{ ranked: [], degraded: false }", async () => {
    const provider = mockProvider();
    const result = await rerank(
      { providerAdapter: provider, config: baseConfig },
      { query: "娴嬭瘯", candidates: [], topK: 5 },
      baseConfig,
    );

    expect(result.ranked).toHaveLength(0);
    expect(result.degraded).toBe(false);
    expect(provider.requestStructured).not.toHaveBeenCalled();
  });

  it("鍊欓€夋暟 鈮?topK 鏃舵棤闇€璋冨皬妯″瀷锛岀洿鎺ュ師搴忚繑鍥?degraded=false", async () => {
    const provider = mockProvider();
    const candidates = [makeDoc({ score: 0.9 }), makeDoc({ score: 0.5 })];

    const result = await rerank(
      { providerAdapter: provider, config: baseConfig },
      { query: "娴嬭瘯", candidates, topK: 3 },
      baseConfig,
    );

    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.score).toBe(0.9);
    expect(result.ranked[1]!.score).toBe(0.5);
    expect(result.degraded).toBe(false);
    expect(provider.requestStructured).not.toHaveBeenCalled();
  });

  it("provider_id 涓?pickProvider 閮界己澶辨椂杩斿洖鍓?topK 涓?degraded=true", async () => {
    const provider = mockProvider();
    provider.pickProvider = vi.fn(() => null);
    const candidates = [
      makeDoc({ score: 0.9, parent_text: "A" }),
      makeDoc({ score: 0.5, parent_text: "B" }),
      makeDoc({ score: 0.3, parent_text: "C" }),
    ];

    const result = await rerank(
      { providerAdapter: provider, config: baseConfig },
      { query: "娴嬭瘯", candidates, topK: 2 },
      { ...baseConfig, rerank_provider_id: "" },
    );

    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.score).toBe(0.9);
    expect(result.ranked[1]!.score).toBe(0.5);
    expect(result.degraded).toBe(true);
    expect(provider.requestStructured).not.toHaveBeenCalled();
  });

  it("requestStructured 姝ｅ父杩斿洖 ranked_indices 鏃舵寜鎸囧畾椤哄簭鎺掑垪涓?rerank_rank 浠?0 閫掑", async () => {
    const provider = mockProvider();
    provider.requestStructured = vi.fn(async () => ({
      ranked_indices: [4, 2, 0],
    }));
    const candidates = [
      makeDoc({ score: 0.1, chunk_id: "1" }),
      makeDoc({ score: 0.2, chunk_id: "2" }),
      makeDoc({ score: 0.3, chunk_id: "3" }),
      makeDoc({ score: 0.4, chunk_id: "4" }),
      makeDoc({ score: 0.9, chunk_id: "5" }),
    ];

    const result = await rerank(
      { providerAdapter: provider, config: baseConfig },
      { query: "娴嬭瘯", candidates, topK: 3 },
      { ...baseConfig, rerank_provider_id: "test-provider" },
    );

    expect(result.ranked).toHaveLength(3);
    // ranked_indices [4,2,0] 鈫?candidates[4](chunk_id"5"), candidates[2](chunk_id"3"), candidates[0](chunk_id"1")
    expect(result.ranked[0]!.chunk_id).toBe("5");
    expect(result.ranked[0]!.rerank_rank).toBe(0);
    expect(result.ranked[1]!.chunk_id).toBe("3");
    expect(result.ranked[1]!.rerank_rank).toBe(1);
    expect(result.ranked[2]!.chunk_id).toBe("1");
    expect(result.ranked[2]!.rerank_rank).toBe(2);
    expect(result.degraded).toBe(false);
  });

  it("requestStructured 鎶涢敊涓?fallback_when_no_rerank=true 鏃舵寜 RRF 鍒嗘暟闄嶅簭瑁佸墠 topK, degraded=true", async () => {
    const provider = mockProvider();
    provider.requestStructured = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    const candidates = [
      makeDoc({ score: 0.3, chunk_id: "1" }),
      makeDoc({ score: 0.9, chunk_id: "2" }),
      makeDoc({ score: 0.5, chunk_id: "3" }),
    ];

    const result = await rerank(
      { providerAdapter: provider, config: baseConfig },
      { query: "娴嬭瘯", candidates, topK: 2 },
      { ...baseConfig, rerank_provider_id: "test-provider", fallback_when_no_rerank: true },
    );

    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.chunk_id).toBe("2");
    expect(result.ranked[1]!.chunk_id).toBe("3");
    expect(result.degraded).toBe(true);
  });

  it("requestStructured 鎶涢敊涓?fallback_when_no_rerank=false 鏃惰繑鍥炲師搴忓墠 topK, degraded=true", async () => {
    const provider = mockProvider();
    provider.requestStructured = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    const candidates = [
      makeDoc({ score: 0.3, chunk_id: "1" }),
      makeDoc({ score: 0.9, chunk_id: "2" }),
      makeDoc({ score: 0.5, chunk_id: "3" }),
    ];

    const result = await rerank(
      { providerAdapter: provider, config: baseConfig },
      { query: "娴嬭瘯", candidates, topK: 2 },
      { ...baseConfig, rerank_provider_id: "test-provider", fallback_when_no_rerank: false },
    );

    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.chunk_id).toBe("1");
    expect(result.ranked[1]!.chunk_id).toBe("2");
    expect(result.degraded).toBe(true);
  });

  it("ranked_indices 涓秺鐣岀储寮曡蹇界暐锛屾湭鍦ㄦ暟缁勪腑鐨勫€欓€変細鍥炲～鍒板熬閮ㄧ洿鑷冲噾瓒?topK", async () => {
    const provider = mockProvider();
    provider.requestStructured = vi.fn(async () => ({
      ranked_indices: [9, 0], // 9 瓒婄晫锛? 鏈夋晥
    }));
    const candidates = [
      makeDoc({ score: 0.1, chunk_id: "1", parent_text: "A" }),
      makeDoc({ score: 0.2, chunk_id: "2", parent_text: "B" }),
      makeDoc({ score: 0.3, chunk_id: "3", parent_text: "C" }),
      makeDoc({ score: 0.4, chunk_id: "4", parent_text: "D" }),
      makeDoc({ score: 0.5, chunk_id: "5", parent_text: "E" }),
    ];

    const result = await rerank(
      { providerAdapter: provider, config: baseConfig },
      { query: "娴嬭瘯", candidates, topK: 3 },
      { ...baseConfig, rerank_provider_id: "test-provider" },
    );

    expect(result.ranked).toHaveLength(3);
    // 绱㈠紩 9 瓒婄晫琚拷鐣ワ紱绱㈠紩 0 鎺掑湪棣栦綅锛涘墿浣欏€欓€夋寜鍘熷簭鍥炲～(candidates[1], candidates[2])
    expect(result.ranked[0]!.chunk_id).toBe("1");
    expect(result.ranked[0]!.rerank_rank).toBe(0);
    expect(result.ranked[1]!.chunk_id).toBe("2");
    expect(result.ranked[1]!.rerank_rank).toBe(1);
    expect(result.ranked[2]!.chunk_id).toBe("3");
    expect(result.ranked[2]!.rerank_rank).toBe(2);
    expect(result.degraded).toBe(false);
  });
});
