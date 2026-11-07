/**
 * build.ts — 主上下文构建流水线
 *
 * 完整流程：
 *   L1 注入 → L2 分类 → L2 注入 → L3 检索 → 扩展 → 预算裁剪 → 返回 messages
 */

import type {
  BuildContextInput,
  BuildContextResult,
  BuildContextMetadata,
  ProviderMessage,
  Protocol,
  RetrieverConfig,
} from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import type { RetrievalDb } from "./db";
import type { EmbedFn } from "./embedding";
import { injectL1 } from "./l1-injector";
import { classifyCards } from "./l2-classifier";
import { injectL2 } from "./l2-injector";
import { createHybridRetriever } from "./retriever/index";
import { trimToBudget } from "./budget";
import { countTokens } from "./token";

// ─── deps ─────────────────────────────────────────────────────────────

interface BuildDeps {
  profileStore: ProfileStore;
  providerAdapter: ProviderAdapter;
  config: RetrieverConfig;
  db: RetrievalDb;
  embedFn: EmbedFn | null;
}

// ─── 内部工具 ─────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

function detectProtocol(providerId: string, adapter: ProviderAdapter): Protocol {
  const providers = adapter.listProviders();
  const found = providers.find((p) => p.id === providerId);
  return found?.protocol ?? "openai";
}

/** 估算 ProviderMessage 数组的总 token 数。 */
function msgTokens(msg: ProviderMessage): number {
  const texts = msg.content
    .filter((b) => b.kind === "text")
    .map((b) => (b as { kind: "text"; text: string }).text);
  return texts.reduce((sum, t) => sum + countTokens(t), 0);
}

/** 将 RetrievedDoc 转为 L3 system message。 */
function docToMessage(doc: { parent_text: string }): ProviderMessage {
  return {
    role: "system",
    content: [
      {
        kind: "text",
        text: `参考资料：\n${doc.parent_text}`,
      },
    ],
  };
}

// ─── 主流水线 ─────────────────────────────────────────────────────────

export async function buildContext(
  deps: BuildDeps,
  input: BuildContextInput,
): Promise<BuildContextResult> {
  const protocol = detectProtocol(input.provider_id, deps.providerAdapter);
  const timings = {
    classify: 0,
    fts5: 0,
    vector: 0,
    rerank: 0,
    expand: 0,
    budget: 0,
    total: 0,
  };
  const degradations: BuildContextMetadata["degradations"] = [];
  const tTotal = now();

  // ── 1. L1 注入 ─────────────────────────────────────────────────
  const core = deps.profileStore.core.get();
  const l1 = injectL1(core, protocol);
  const l1Tokens = msgTokens(l1);

  // ── 2. L2 分类 + 注入 ──────────────────────────────────────────
  const tClassify = now();
  const cards = deps.profileStore.cards.list();
  const { selectedKeys, degraded: classifyDegraded } = await classifyCards(
    { providerAdapter: deps.providerAdapter, config: deps.config },
    {
      query: input.query,
      cards,
      config: deps.config,
      forceCardKeys: input.force_card_keys,
    },
  );
  timings.classify = now() - tClassify;
  if (classifyDegraded) {
    degradations.push("classifier_failed");
  }

  // 按 selectedKeys 读取完整卡片
  const selectedCards = selectedKeys
    .map((key) => {
      try {
        return deps.profileStore.cards.get(key);
      } catch {
        return null;
      }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const l2 = injectL2(selectedCards, protocol);
  const l2Tokens = l2.reduce((sum, m) => sum + msgTokens(m), 0);

  // ── 3. L3 检索 ─────────────────────────────────────────────────
  let l3Docs: Awaited<ReturnType<ReturnType<typeof createHybridRetriever>["retrieve"]>>["docs"] =
    [];
  let l3Tokens = 0;

  if (!input.skip_l3_retrieval && deps.config.enabled) {
    const retriever = createHybridRetriever({
      db: deps.db,
      providerAdapter: deps.providerAdapter,
      config: deps.config,
      embedFn: deps.embedFn,
    });

    const { docs, timings: retTimings } = await retriever.retrieve({
      text: input.query,
      top_k: input.override_top_k ?? deps.config.rerank_top_k,
      recall_per_lane: 30,
      filter_sources: [],
      date_range: null,
      exclude_doc_ids: [],
      include_score: true,
    });

    l3Docs = docs;
    timings.fts5 = retTimings.fts5;
    timings.vector = retTimings.vector;
    timings.rerank = retTimings.rerank;
    timings.expand = retTimings.expand;
  }

  // L3 → messages
  const l3Messages: ProviderMessage[] = l3Docs.map(docToMessage);
  l3Tokens = l3Messages.reduce((sum, m) => sum + msgTokens(m), 0);

  // ── 4. 历史消息 + 用户本轮 ──────────────────────────────────────
  const history: ProviderMessage[] = input.history.map((h) => ({
    role: (h.role as ProviderMessage["role"]) ?? "user",
    content: (h.content as ProviderMessage["content"]) ?? [],
  }));

  const userTurn: ProviderMessage = {
    role: "user",
    content: [{ kind: "text", text: input.query }],
  };

  // ── 5. 预算裁剪 ─────────────────────────────────────────────────
  const tBudget = now();
  const l3Single = l3Messages.length > 0 ? l3Messages[0]! : null;
  const { messages, degradedAggressive } = trimToBudget({
    l1,
    l2,
    l3: l3Single,
    history,
    userTurn,
    budgets: {
      l1: deps.config.token_budget_l1,
      l2: deps.config.token_budget_l2,
      l3: deps.config.token_budget_l3,
      history: deps.config.token_budget_history,
      total: deps.config.token_budget,
    },
  });
  timings.budget = now() - tBudget;
  if (degradedAggressive) {
    degradations.push("budget_trim_aggressive");
  }

  timings.total = now() - tTotal;

  // ── 6. 组装结果 ─────────────────────────────────────────────────
  const totalTokenEstimate = messages.reduce((sum, m) => sum + msgTokens(m), 0);

  const metadata: BuildContextMetadata = {
    l1_tokens: l1Tokens,
    l2_card_keys: selectedKeys,
    l2_tokens: l2Tokens,
    l3_doc_ids: l3Docs.map((d) => d.doc_id),
    l3_tokens: l3Tokens,
    history_tokens: history.reduce((sum, m) => sum + msgTokens(m), 0),
    total_tokens: totalTokenEstimate,
    expected_cache_hits: protocol === "anthropic" ? l1Tokens + l2Tokens : 0,
    degradations,
    timings_ms: timings,
  };

  return {
    messages: messages as BuildContextResult["messages"],
    metadata,
  };
}
