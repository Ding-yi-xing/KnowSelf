/**
 * `revertBatch`：批次逻辑回滚（DESIGN-13 §4.4；DESIGN-11 §7.5 能力 8 / §8.3）。
 * 步骤：① 批次置 `reverted` → ② **不删** `chat_messages`（append-only 触发器禁止 DELETE，
 * 读视图 `v_chat_messages` 自动过滤）→ ③ staging 置 `rejected` → ④ 按快照回退游标。
 * 幂等：已回滚批次重复调用返回 0 / 0（不抛错）。事件由 `store.ts` 在事务提交后发。
 */
import { BatchInvalidError } from "./errors";
import type { StagingRepo } from "./repository/staging";

export interface RevertBatchInput {
  batch_id: string;
  now: string;
}

export interface RevertBatchResult {
  rejected: number;
  restored: number;
}

export interface RevertDeps {
  staging: StagingRepo;
}

export function revertBatch(deps: RevertDeps, input: RevertBatchInput): RevertBatchResult {
  const batch = deps.staging.getBatch(input.batch_id);
  if (batch === null) throw new BatchInvalidError(`批次不存在: ${input.batch_id}`, input.batch_id);
  if (batch.reverted_at !== null) return { rejected: 0, restored: 0 };

  deps.staging.markBatchReverted(input);
  const rejected = deps.staging.rejectBatch(input).rejected;
  const restored = deps.staging.restoreCursors(input).restored;
  return { rejected, restored };
}
