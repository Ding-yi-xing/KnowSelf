/**
 * `commitStaged`：落档事务编排（DESIGN-13 §4.3；DESIGN-11 §7.5 能力 5）。
 * 单事务（persons.sqlite）内按序：批次校验 → 会话 UPSERT → 发送者解析 → 成员 UPSERT →
 * 消息 `INSERT OR IGNORE` → staging 置位 → 统计重算 → 游标推进；事件在事务外发（由 `store.ts` 负责）。
 * 步骤实现见 `commit-steps.ts`（§2.2 行预算拆分）。
 * 幂等（DESIGN-11 §8.4 场景 ②）：重复调用 `committed=0` / `skipped=N`，**不抛错**。
 */
import { BatchInvalidError } from "./errors";
import {
  advanceCursor,
  resolveConversation,
  resolveSenders,
  toMessageInsert,
  upsertMembers,
  type CommitStagedInput,
  type CommitStagedResult,
  type StepDeps,
} from "./commit-steps";
import type { MessagesRepo } from "./repository/messages";

export type { CommitStagedInput, CommitStagedResult } from "./commit-steps";

export interface CommitDeps extends StepDeps {
  messages: MessagesRepo;
}

function assertBatchOpen(deps: CommitDeps, batchId: string): void {
  const batch = deps.staging.getBatch(batchId);
  if (batch === null) throw new BatchInvalidError(`批次不存在: ${batchId}`, batchId);
  if (batch.status !== "running" && batch.status !== "succeeded") {
    throw new BatchInvalidError(`批次状态不可落档: ${batch.status}`, batchId);
  }
}

export function commitStaged(deps: CommitDeps, input: CommitStagedInput): CommitStagedResult {
  assertBatchOpen(deps, input.batch_id);
  const rows = deps.staging.listStaged({
    batch_id: input.batch_id,
    conversation_id: input.conversation_id,
    status: "staged",
  });
  if (rows.length === 0) {
    return deps.staging.commitStaged(input);
  }

  deps.conversations.upsertFromCommit(resolveConversation(deps, input, rows), input.now);
  const personIds = resolveSenders(deps, rows, input.now);
  upsertMembers(deps, input, rows, personIds);
  deps.messages.insertOrIgnore(rows.map((row) => toMessageInsert(row, input.now)));

  const result = deps.staging.commitStaged(input);
  deps.conversations.recomputeStats(input.conversation_id, input.now);
  deps.conversations.recomputeMemberStats(input.conversation_id, input.now);
  advanceCursor(deps, input, rows);
  return result;
}
