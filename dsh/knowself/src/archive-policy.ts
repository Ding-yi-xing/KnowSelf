/**
 * 自动归档策略（批次 2 / B2-3 + B2-4）：**判定 → 记录 → 按策略采纳 → 必要时蒸馏**。
 *
 * ## 为什么单独一层，不塞进 chat-import
 * `chat-import.ts` 已经 380 行，负责"导入"这一件事。归档判定是**另一条决策链**
 * （判定与采纳是两件事：判定一定要记，采纳要看开关），混进去会让"导入失败"与
 * "判定失败"两种错误难以区分。这里只依赖 `personStore` / `profileStore` / `ingestion`。
 *
 * ## 三条硬纪律
 *   1. **判定失败不阻断导入**：分类器抛错/模型不可用 → 该条留 pending，记 warning；
 *   2. **判定结果一定入库**（`suggested_target`/`confidence`/`classifier`），
 *      即使 `enabled=false` —— 否则用户永远看不到"系统本来想怎么归档"；
 *   3. **`discard` 永不自动采纳**：删数据必须由人点（哪怕置信度 0.99）。
 *
 * ## 与旧 `auto_commit` 的关系
 * `auto_commit=true` 是**显式全采纳**（用户自己说的），保持原样、优先级最高；
 * `auto_archive.enabled` 是**按判定选择性采纳**。两者都关时，全部进「待整理」。
 */
import type { PersonStore } from "@knowself/person-store";
import type { IngestionProposal } from "@knowself/contracts";
import type { KnowselfServices } from "./services.js";
import {
  classifyConversation,
  DEFAULT_THRESHOLDS,
  type ClassifyInput,
  type ClassifyThresholds,
  type ClassifyVerdict,
  type LlmClassifier,
} from "./archive-classifier.js";

/** 一次归档策略运行的结果（进导入回包，便于前端展示与事后核对）。 */
export interface AutoArchiveOutcome {
  /** 参与判定的 proposal 数。 */
  classified: number;
  /** 规则直接判掉的条数（不含 LLM）。 */
  by_rule: number;
  /** 落到 LLM 的条数。 */
  by_llm: number;
  /** 规则+LLM 都判不出来的条数（最终进 review）。 */
  undecided: number;
  /** 按策略自动采纳的条数。 */
  auto_accepted: number;
  /** 自动触发 distill 的次数（成功）。 */
  distilled: number;
  /** 非致命告警（分类失败、蒸馏失败等），**不阻断导入**。 */
  warnings: string[];
}

/** 空结果（未启用策略时也返回，保证回包字段稳定）。 */
export function emptyOutcome(): AutoArchiveOutcome {
  return {
    classified: 0,
    by_rule: 0,
    by_llm: 0,
    undecided: 0,
    auto_accepted: 0,
    distilled: 0,
    warnings: [],
  };
}

/**
 * 从 staging 行构造分类器输入。
 *
 * 为什么不看 `chat_conversations`：新会话在本阶段**还没落库**（还在 staging），
 * 会话表里查不到。所以 `kind` 从 `conversation_id` 的 `@chatroom` 后缀推断，
 * 发言人数从 staging 的 `sender_id` 去重得到 —— 这两个事实都足够跑规则。
 *
 * @param store 人物库
 * @param proposal 待判定的提案
 * @param batchId 本批次 id（圈定 staging 行）
 * @returns 分类器输入
 */
export function buildClassifyInput(
  store: PersonStore,
  proposal: IngestionProposal,
  batchId: string,
): ClassifyInput {
  const conversationId = (proposal.target as { conversation_id?: string }).conversation_id ?? "";
  const rows = store.staging.listStaged({ batch_id: batchId, conversation_id: conversationId });
  const speakers = new Set<string>();
  const contentTypes: Record<string, number> = {};
  const samples: string[] = [];
  for (const row of rows) {
    if (row.role !== "system") speakers.add(row.sender_id);
    contentTypes[row.content_type] = (contentTypes[row.content_type] ?? 0) + 1;
    if (samples.length < 200) samples.push(row.content);
  }
  const committed = store.conversations.get(conversationId);
  return {
    kind: committed?.kind ?? (conversationId.endsWith("@chatroom") ? "group" : "direct"),
    message_count: rows.length,
    speaker_count: speakers.size,
    samples,
    content_types: contentTypes,
    title: committed?.title ?? "",
  };
}

/**
 * 按 settings 的 `auto_archive` 跑一轮判定与（可选）采纳。
 *
 * @param input.services 装配后的服务（取 profileStore / ingestion / settings）
 * @param input.store 人物库（读 staging、写判定结果走 profile 库）
 * @param input.batchId 本批次 id
 * @param input.sourceId 本批次对应的资料 id（用于圈定"本次新建"的 proposal）
 * @param input.llm 可选 LLM 兜底（由调用方注入；不注入 = 规则判不了就 review）
 * @returns 见 {@link AutoArchiveOutcome}
 */
export async function runAutoArchive(input: {
  services: KnowselfServices;
  store: PersonStore;
  batchId: string;
  sourceId: string;
  llm?: LlmClassifier;
}): Promise<AutoArchiveOutcome> {
  const outcome = emptyOutcome();
  const { services, store, batchId, sourceId } = input;

  const profileStore = services.profileStore;
  const ingestion = services.ingestion;
  if (profileStore === undefined) {
    outcome.warnings.push("核心层未就绪：跳过自动归档判定");
    return outcome;
  }

  // `settings` 在生产装配里必有，但路由单测的 services 桩可能不提供 → 缺省按"关闭"处理
  const config = services.settings?.auto_archive;
  const thresholds: ClassifyThresholds = {
    group_speaker_threshold: config?.group_speaker_threshold ?? DEFAULT_THRESHOLDS.group_speaker_threshold,
    direct_message_threshold:
      config?.direct_message_threshold ?? DEFAULT_THRESHOLDS.direct_message_threshold,
  };
  const minConfidence = config?.min_confidence ?? 0.8;
  const enabled = config?.enabled === true;
  // LLM 兜底默认关闭：settings 没显式打开、或调用方没注入模型，都只跑规则。
  const llm = config?.use_llm === true ? input.llm : undefined;

  // 只判定**本批次/本资料**下的 pending：历史 pending 不该被这次导入顺手改判。
  // 提案仓储缺失（路由单测的 services 桩）时按"无候选"处理 —— 判定是增强，不是导入的前置条件。
  if (typeof profileStore.proposals?.listByStatus !== "function") {
    outcome.warnings.push("提案仓储未就绪：跳过自动归档判定");
    return outcome;
  }
  const candidates = profileStore.proposals
    .listByStatus("pending")
    .filter((proposal) => proposal.source_id === sourceId);

  const materialSources = new Set<string>();

  for (const proposal of candidates) {
    const kind = (proposal.target as { kind?: string }).kind;
    if (kind !== "chat_message") continue; // 只判聊天类；资料类走 distill
    let verdict: ClassifyVerdict | null = null;
    let source: "rule" | "llm" | "none" = "none";
    try {
      const built = buildClassifyInput(store, proposal, batchId);
      const decided = await classifyConversation(built, { thresholds, ...(llm === undefined ? {} : { llm }) });
      verdict = decided.verdict;
      source = decided.source;
    } catch (err) {
      outcome.warnings.push(
        `判定失败（proposal=${proposal.id}）：${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (verdict === null) {
      outcome.undecided += 1;
      continue;
    }
    outcome.classified += 1;
    if (source === "rule") outcome.by_rule += 1;
    else if (source === "llm") outcome.by_llm += 1;

    try {
      profileStore.proposals.setClassification(proposal.id, {
        target: verdict.target,
        confidence: verdict.confidence,
        classifier: verdict.classifier,
      });
    } catch (err) {
      outcome.warnings.push(
        `判定结果写入失败（proposal=${proposal.id}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 采纳策略：开关关 / 置信度不够 / 目标是 discard → 一律留在 pending（不静默丢）
    if (!enabled || verdict.target === "discard" || verdict.confidence < minConfidence) continue;
    if (ingestion === undefined) {
      outcome.warnings.push("摄入层未就绪：判定已记录，但无法自动采纳");
      continue;
    }
    try {
      ingestion.acceptProposal(proposal.id);
      outcome.auto_accepted += 1;
      if (verdict.target === "material") materialSources.add(sourceId);
    } catch (err) {
      outcome.warnings.push(
        `自动采纳失败（proposal=${proposal.id}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // B2-4：material 自动蒸馏（一次 source 只跑一次；失败只告警，不动已入库的消息）
  if (enabled && config?.auto_distill_material !== false && ingestion !== undefined) {
    for (const id of materialSources) {
      try {
        const source = profileStore.sources.get(id);
        await ingestion.runDistill(source, {
          provider_id: "",
          focus_hints: [],
          max_proposals: 8,
          force: false,
        });
        outcome.distilled += 1;
      } catch (err) {
        outcome.warnings.push(
          `自动蒸馏失败（source=${id}）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return outcome;
}
