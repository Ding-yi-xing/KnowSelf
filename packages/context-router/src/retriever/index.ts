/**
 * retriever/index.ts — 混合检索器装配
 *
 * 组装 FTS5 + Vector → RRF 融合 → Reranker → Expand 流水线，
 * 对外暴露 IRetriever 接口。
 */

import type { RetrievedDoc, RetrieveQuery, RetrieverConfig } from "@knowself/contracts";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import type { RetrievalDb } from "../db";
import type { EmbedFn } from "../embedding";
import { hybridQuery } from "./hybrid";
import { rerank } from "./reranker";
import { expandToParents } from "./expand";

// ─── 内部计时器 ───────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

// ─── 接口 ─────────────────────────────────────────────────────────────

interface IRetriever {
  retrieve(query: RetrieveQuery): Promise<{ docs: RetrievedDoc[]; timings: RetrieverTimings }>;
}

interface RetrieverTimings {
  fts5: number;
  vector: number;
  rerank: number;
  expand: number;
}

interface RetrieverDeps {
  db: RetrievalDb;
  providerAdapter: ProviderAdapter;
  config: RetrieverConfig;
  embedFn: EmbedFn | null;
}

// ─── 装配 ─────────────────────────────────────────────────────────────

export function createHybridRetriever(deps: RetrieverDeps): IRetriever {
  return {
    async retrieve(query: RetrieveQuery) {
      const timings: RetrieverTimings = {
        fts5: 0,
        vector: 0,
        rerank: 0,
        expand: 0,
      };

      // 1. 并行召回 + RRF 融合
      const t0 = now();
      const fused = await hybridQuery({ db: deps.db, embedFn: deps.embedFn }, query);
      timings.fts5 = now() - t0;
      timings.vector = timings.fts5; // 并行，耗时相同

      if (fused.length === 0) {
        return { docs: [], timings };
      }

      // 2. Reranker
      const t1 = now();
      const { ranked } = await rerank(
        { providerAdapter: deps.providerAdapter, config: deps.config },
        {
          query: query.text,
          candidates: fused,
          topK: query.top_k,
        },
        deps.config,
      );
      timings.rerank = now() - t1;

      // 3. 子→父扩展 + 去重
      //    聊天结果（doc_source='message'）已是窗口级、parent_text 自带，不能走 chunks 回查，
      //    否则 SQL 里按 doc_id 查不到（chat 行在 chat_chunks 表）。
      const t2 = now();
      const profileDocs = ranked.filter((d) => d.doc_source !== "message");
      const chatDocs = ranked.filter((d) => d.doc_source === "message");
      const expanded = await expandToParents({ db: deps.db }, profileDocs);
      const docs = [...expanded, ...chatDocs].sort((a, b) => b.score - a.score);
      timings.expand = now() - t2;

      return { docs, timings };
    },
  };
}
