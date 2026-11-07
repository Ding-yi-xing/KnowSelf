/**
 * reranker.ts — LLM Reranker
 *
 * 对混合召回的候选调用小 provider 做精排。
 * 失败时降级为 RRF 原始排序。
 */

import { z } from "zod";
import type { RetrievedDoc, RetrieverConfig, ProviderMessage } from "@knowself/contracts";
import type { ProviderAdapter } from "@knowself/provider-adapter";

// ─── 内部 Zod schema ──────────────────────────────────────────────────

const RerankOutputSchema = z.object({
  ranked_indices: z.array(z.number().int().min(0).max(99)).max(50),
});

// ─── deps ─────────────────────────────────────────────────────────────

interface RerankerDeps {
  providerAdapter: ProviderAdapter;
  config: RetrieverConfig;
}

// ─── prompt 构建 ──────────────────────────────────────────────────────

function buildRerankPrompt(query: string, candidates: string[]): string {
  const lines = candidates.map((text, i) => `${i}. ${text.slice(0, 2000)}`).join("\n\n---\n\n");

  return `你是一个检索重排助手。根据用户查询，对以下文档片段按相关度排序。

用户查询：${query}

候选文档片段：
${lines}

请选出与查询最相关的片段，按相关度降序返回其编号。
输出 JSON 格式：{"ranked_indices": [3, 0, 5, ...]}`;
}

// ─── 主函数 ───────────────────────────────────────────────────────────

export async function rerank(
  deps: RerankerDeps,
  input: {
    query: string;
    candidates: RetrievedDoc[];
    topK: number;
  },
  config: RetrieverConfig,
): Promise<{ ranked: RetrievedDoc[]; degraded: boolean }> {
  if (input.candidates.length === 0) {
    return { ranked: [], degraded: false };
  }

  // 候选 ≤ topK：无需重排
  if (input.candidates.length <= input.topK) {
    return { ranked: input.candidates, degraded: false };
  }

  const providerId =
    config.rerank_provider_id || deps.providerAdapter.pickProvider("rerank")?.id || "";

  if (!providerId) {
    return {
      ranked: input.candidates.slice(0, input.topK),
      degraded: true,
    };
  }

  try {
    const texts = input.candidates.map((d) => d.parent_text);
    const systemMsg: ProviderMessage = {
      role: "system",
      content: [
        {
          kind: "text",
          text: buildRerankPrompt(input.query, texts),
        },
      ],
    };

    const result = (await deps.providerAdapter.requestStructured({
      provider_id: providerId,
      messages: [
        systemMsg,
        {
          role: "user",
          content: [{ kind: "text", text: "请返回排序结果。" }],
        },
      ],
      schema: RerankOutputSchema,
      schemaName: "RerankOutput",
    })) as z.infer<typeof RerankOutputSchema>;

    // 按 ranked_indices 重排
    const ranked: RetrievedDoc[] = [];
    for (const idx of result.ranked_indices) {
      const doc = input.candidates[idx];
      if (doc && ranked.length < input.topK) {
        ranked.push({ ...doc, rerank_rank: ranked.length });
      }
    }

    // 补足未在 ranked_indices 中的候选
    for (let i = 0; i < input.candidates.length && ranked.length < input.topK; i++) {
      if (!result.ranked_indices.includes(i)) {
        ranked.push({ ...input.candidates[i]!, rerank_rank: ranked.length });
      }
    }

    return { ranked, degraded: false };
  } catch {
    // 降级：按 RRF 原始分数排序
    if (config.fallback_when_no_rerank) {
      const fallback = [...input.candidates].sort((a, b) => b.score - a.score).slice(0, input.topK);
      return { ranked: fallback, degraded: true };
    }
    return {
      ranked: input.candidates.slice(0, input.topK),
      degraded: true,
    };
  }
}
