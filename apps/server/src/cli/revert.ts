/**
 * ingest-chat CLI 的「回滚出口」+「撤销后强制复核」装配层（批 2b）。
 *
 * 为什么单独成模块：`ingest-chat.ts` 末尾直接 `main()`，import 它会连带启动 CLI
 * 并把 vitest 的 argv 喂给 parseArgs（process.exit）。把这些纯逻辑抽出来，
 * 既保持 `parseArgs` / `main` 结构不变（工单要求「不重构 CLI」），又让注入点可单测。
 *
 * 对应评审定稿：
 *   - 回滚四步 ③：索引重建放调用方（CLI），不塞进 person-store；
 *   - 11b：撤销收回预授权，重导命中 MANUAL_FLAG ⇒ Tier B；
 *   - 11d：解除条件是「接受并实际落档一批」，粘性（取 MAX(reverted_at)）。
 */
import type { IngestTierConfig } from "@knowself/chat-ingest";
import type { BatchRow, PersonStore } from "@knowself/person-store";

/** CLI 出口专用错误（与 person-store 的 BatchInvalidError 区分，便于给人类可读文案）。 */
export class RevertCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevertCommandError";
  }
}

/**
 * 只撤最近一个 `status='succeeded'` 的批次。
 *
 * `listBatches({status:'succeeded'})` 已按 `started_at DESC, batch_id ASC` 排序，
 * 首行即「最近一个成功批次」。回滚后该批次变成 `reverted` 自动退出候选集，
 * 于是更早的 succeeded 批次成为新的「最近」——这是预期行为。
 *
 * 原 batch_id 不复用：`assertBatchOpen` 只接受 running|succeeded，复用必抛
 * `BatchInvalidError`（**不改它**），CLI 只需明确输出「请用新批次重导」。
 */
export function assertRevertable(store: PersonStore, batchId: string): BatchRow {
  const target = store.staging.getBatch(batchId);
  if (target === null) {
    throw new RevertCommandError(`批次不存在：${batchId}`);
  }
  if (target.status !== "succeeded") {
    throw new RevertCommandError(`批次 ${batchId} 状态为 ${target.status}，只有 succeeded 可撤销`);
  }
  const latest = store.staging.listBatches({ status: "succeeded" })[0];
  if (latest === undefined || latest.batch_id !== batchId) {
    throw new RevertCommandError(
      `只能撤销最近一个 succeeded 批次（当前为 ${latest?.batch_id ?? "无"}），拒绝 ${batchId}`,
    );
  }
  return target;
}

/** 该批次涉及的会话（回滚后按会话重建索引用）。必须在 revertBatch **之前**采集：之后 staging 行会被置 rejected。 */
export function conversationIdsOfBatch(store: PersonStore, batchId: string): string[] {
  const rows = store.staging.listStaged({ batch_id: batchId });
  return [...new Set(rows.map((row) => row.conversation_id))].sort();
}

/**
 * 装配层注入点（11b）：把「因撤销而待复核」的会话集合合并进 `tierConfig.review`。
 *
 * 复用已有链路 `tierConfig.review → manual_flags → MANUAL_FLAG → Tier B`，
 * **判定链路一字不改**。裸 SQL 只在 person-store 的 review-required.ts 里。
 * CLI 每次导入都调用本函数 ⇒ 注入点可达（上一轮 chatCommitter 就是实现了却没注入）。
 *
 * UI 徽标消费判据（本批不做前端，留给 apps/web agent）：
 *   store.isReviewRequired(conversationId) === true ⇒ 「此前撤销 · 需重新确认」；
 *   last_reverted_at 由 listReviewRequiredConversations() 一并返回，零新增查询。
 */
export function deriveTierConfig(base: IngestTierConfig, store: PersonStore): IngestTierConfig {
  const required = store.listReviewRequiredConversations().map((row) => row.conversation_id);
  return { ...base, review: [...new Set([...(base.review ?? []), ...required])] };
}

export interface RevertDeps {
  store: PersonStore;
  now: string;
  /** 索引重建（回滚四步 ③）。失败必须冒泡，不许静默吞。 */
  rebuildChatIndex(
    conversationIds: readonly string[],
  ): Promise<{
    chunkCount: number;
    conversationCount: number;
    /** 批 2b 修复：整会话全被撤时清理掉的空会话残留索引数（可选，兼容旧实现）。 */
    cleanedEmptyConversations?: number;
  }>;
}

export interface RevertOutcome {
  batch_id: string;
  rejected: number;
  restored: number;
  conversation_ids: readonly string[];
  index_chunks: number;
  index_conversations: number;
  /** 空会话残留索引被清理的会话数（0 = 无此情形）；可选以兼容既有调用方。 */
  index_cleaned_empty?: number;
}

/**
 * 执行回滚：校验 → 采集受影响会话 → revertBatch → 按会话重建索引。
 * `rebuildChatIndex` 抛错时**不 catch**：批次已置 reverted，但检索索引仍是旧的，
 * 这个失败必须可见（工单「失败要可见，不静默吞」）。
 */
export async function runRevert(deps: RevertDeps, batchId: string): Promise<RevertOutcome> {
  assertRevertable(deps.store, batchId);
  const conversation_ids = conversationIdsOfBatch(deps.store, batchId);
  const result = deps.store.revertBatch({ batch_id: batchId, now: deps.now });
  const index = await deps.rebuildChatIndex(conversation_ids);
  return {
    batch_id: batchId,
    rejected: result.rejected,
    restored: result.restored,
    conversation_ids,
    index_chunks: index.chunkCount,
    index_conversations: index.conversationCount,
    index_cleaned_empty: index.cleanedEmptyConversations ?? 0,
  };
}

/**
 * 如实输出（通则「有成功提示的动作必须用返回值核销」）：
 * `restored` 单独成行并给出实际数字；`restored=0` 时明确说「本次未回退任何游标」，
 * 绝不写一个笼统的「撤销成功」把它盖过去。
 */
export function formatRevertOutput(outcome: RevertOutcome): string[] {
  const cursorLine =
    outcome.restored === 0
      ? `游标回退      ：restored=0（快照为空，本次未回退任何游标；请勿据此认为重导一定能带回旧数据）`
      : `游标回退      ：restored=${outcome.restored} 条`;
  return [
    "=== 回滚结果（批 2b）===",
    `批次          ：${outcome.batch_id} → status=reverted（聊天记录未物理删除，读视图与派生读数已过滤）`,
    `staging 置 rejected：${outcome.rejected} 条`,
    cursorLine,
    `检索索引重建  ：${outcome.index_conversations} 个会话 / ${outcome.index_chunks} chunk（受影响会话 ${outcome.conversation_ids.length} 个）`,
    // 如实反映「整会话全被撤」的清理：不把清理动作藏在一个看似「成功」的 0/0 后面
    `空会话残留清理：${outcome.index_cleaned_empty ?? 0} 个会话（该会话全部消息来自被撤批次时，旧 chunk 已删净）`,
    "提示          ：原 batch_id 已置 reverted，assertBatchOpen 只接受 running|succeeded，复用必抛 BatchInvalidError。请用新批次重导。",
  ];
}
