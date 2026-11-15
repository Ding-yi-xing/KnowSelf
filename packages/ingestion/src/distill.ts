/**
 * distill.ts — runDistill 蒸馏主流程
 *
 * 1. 选 provider（distill 用途）
 * 2. 取候选 cards / journal dates
 * 3. 构造 messages + structured output 调用
 * 4. 将结果写入 proposals 表
 * 5. 更新 source 状态
 */

import type {
  SourceStored,
  IngestRequest,
  IngestResponse,
  IngestionProposal,
  ProviderMessage,
} from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import { DistillOutputSchema, buildDistillPrompt, writeToProposalTarget } from "./distill-prompt";
import { DistillFailedError } from "./errors";

/** runDistill 的依赖。 */
export interface DistillDeps {
  store: ProfileStore;
  providerAdapter: ProviderAdapter;
  distillProviderId: string;
  now?: () => string;
}

/**
 * 执行一次蒸馏：读 source → 查 profile → 调 LLM → 写 proposals。
 */
export async function runDistill(
  deps: DistillDeps,
  source: SourceStored,
  req: IngestRequest,
): Promise<IngestResponse> {
  const startTime = Date.now();
  const now = deps.now ?? (() => new Date().toISOString());

  // 0. Idempotency applies only to prior content output. A pending
  // source_distill row is a review request and must not suppress model work.
  //    根因：`routes/sources-write.ts` 的 createSource 内部已蒸一次，REST 再调
  //    `POST /sources/:id/distill` 就是第二次，会产出同义重复提案。
  const pendingBefore = listPendingProposals(deps, source.id);
  if (req.force !== true && pendingBefore.length > 0) {
    deps.store.sources.updateStatus(source.id, "pending_review", now());
    return {
      source_id: source.id,
      produced_proposal_ids: pendingBefore.map((p) => p.id),
      duration_ms: Date.now() - startTime,
      token_usage: { input_tokens: 0, output_tokens: 0 },
      reused: true,
    };
  }

  deps.store.sources.updateStatus(source.id, "distilling", now());

  // force removes only pending content output. source_distill review requests
  // are deliberately retained by the repository operation.
  if (req.force === true && pendingBefore.length > 0) {
    deps.store.proposals.deletePendingBySource(source.id);
  }

  // 1. 选 provider
  const providerId = req.provider_id || deps.distillProviderId;
  const provider = deps.providerAdapter.pickProvider("distill");
  const effectiveProviderId = provider?.id ?? providerId;
  if (!provider && !providerId) {
    deps.store.sources.updateError(source.id, "No distill provider configured", now());
    throw new DistillFailedError("No distill provider configured");
  }

  // 2. 取候选数据
  const cards = listCardSummaries(deps.store);
  const journalDates = listJournalDateSummaries(deps.store);

  // 3. 构造 prompt
  const messages: ProviderMessage[] = buildDistillPrompt(
    source,
    { cards, journalDates },
    req.focus_hints ?? [],
    req.max_proposals ?? 8,
  );

  // 4. 调 structured output
  let result: unknown;
  try {
    result = await deps.providerAdapter.requestStructured({
      provider_id: effectiveProviderId,
      messages,
      schema: DistillOutputSchema,
      schemaName: "DistillOutput",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.store.sources.updateError(source.id, msg, now());
    throw new DistillFailedError(msg);
  }

  // 5. 校验 & 转换（兼容 { writes: [...] } 和直接 [...]）
  const parsed = parseDistillOutputOrThrow(deps, source.id, result, now);
  const writes = Array.isArray(parsed) ? parsed : parsed.writes;
  const proposals = writes.map((w) =>
    writeToProposal(deps, source, w, effectiveProviderId, now),
  );

  // 6. 写入 proposals
  deps.store.transaction(() => {
    if (proposals.length > 0) {
      deps.store.proposals.insertMany(proposals);
    }
    deps.store.sources.updateStatus(
      source.id,
      proposals.length > 0 ? "pending_review" : "completed",
      now(),
    );
  });

  const durationMs = Date.now() - startTime;

  return {
    source_id: source.id,
    produced_proposal_ids: proposals.map((p) => p.id),
    duration_ms: durationMs,
    token_usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

/**
 * Lists pending content proposals for a source. `source_distill` represents a
 * review request, not prior model output, and is excluded from this gate.
 *
 * 防御式实现：注入的 store 若没有 `proposals.listBySource`（部分单测桩只关心
 * `insertMany`），当作「没有 pending」处理，绝不因缺方法而炸掉蒸馏主流程。
 *
 * @param deps runDistill 依赖
 * @param sourceId 资料 id
 * @returns pending 提案列表（可能为空）
 */
function listPendingProposals(
  deps: DistillDeps,
  sourceId: string,
): { id: string }[] {
  const repo = deps.store.proposals as {
    listBySource?: (id: string) => { id: string; status: string; target?: { kind?: string } }[];
  };
  if (typeof repo.listBySource !== "function") return [];
  try {
    return repo
      .listBySource(sourceId)
      .filter((p) => p.status === "pending" && p.target?.kind !== "source_distill");
  } catch {
    return [];
  }
}

function listCardSummaries(store: ProfileStore): { key: string; title: string; summary: string }[] {  try {
    return store.cards.list().map((c) => ({
      key: c.key,
      title: c.title,
      summary: c.summary,
    }));
  } catch {
    return [];
  }
}

function parseDistillOutputOrThrow(
  deps: DistillDeps,
  sourceId: string,
  result: unknown,
  now: () => string,
): ReturnType<typeof DistillOutputSchema.parse> {
  try {
    return DistillOutputSchema.parse(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.store.sources.updateError(sourceId, msg, now());
    throw new DistillFailedError(msg);
  }
}

function listJournalDateSummaries(store: ProfileStore): string[] {
  try {
    return store.journal.listDates().map((d) => d.date);
  } catch {
    return [];
  }
}

function writeToProposal(
  deps: DistillDeps,
  source: SourceStored,
  w: {
    target: { targetKind: string; cardKey?: string; section?: string; date?: string };
    body: string;
    reasoning: string;
    excerpts: { start: number; end: number }[];
  },
  providerId: string,
  now: () => string,
): IngestionProposal {
  return {
    id: crypto.randomUUID(),
    source_id: source.id,
    target: writeToProposalTarget(w as Parameters<typeof writeToProposalTarget>[0]),
    proposed_body: w.body,
    reasoning: w.reasoning,
    source_excerpts: w.excerpts,
    produced_by_provider: providerId,
    status: "pending",
    user_edited_body: null,
    created_at: now(),
    decided_at: null,
  };
}
