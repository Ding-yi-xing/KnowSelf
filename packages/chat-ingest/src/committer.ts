/**
 * `ChatMessageCommitter` 实现（DESIGN-11 §7.3）。
 *
 * 注入位置：`apps/server` 组装 `createChatMessageCommitter({ store })` 后传给
 * `createIngestion({ ..., chatCommitter })`；`acceptProposal` 的 `chat_message` 分支调用它。
 *
 * 硬约束：
 *   1. **幂等**：重复调用返回 `skipped > 0`，不抛错（§7.3 / §8.4 场景 ②）；
 *   2. 只调 person-store 的**公开 API**（`staging.listStaged` 读行 → `commitStaged` 落档），
 *      **禁止** `new Database(...)`、禁止直接 SQL 写 `chat_messages`；
 *   3. **禁止** `buildLink` / `links.insert` / `proposalToWriteRequest`（§7.4，profile 链路无关）；
 *   4. 不 import `person-store`：用结构化接口注入（参照 `context-router` 的 `ChatIndexSource`）。
 */
import { ChatIngestError } from "./errors";

/** `target.message_ids` 上限（§6.4 / contracts 硬约束）。 */
const MAX_MESSAGE_IDS = 2000;

/** staging 行形状子集（`person-store` 的 `StagingRow` 结构满足）。 */
export interface ChatStagingRowLike {
  message_id: string;
  status: "staged" | "committed" | "rejected";
  proposal_id: string | null;
}

/** 落档所需的最小 store 能力面（`PersonStore` 满足）。 */
export interface ChatCommitStoreLike {
  staging: {
    listStaged(q: {
      batch_id: string;
      conversation_id?: string;
      status?: "staged" | "committed" | "rejected";
      limit?: number;
      offset?: number;
    }): readonly ChatStagingRowLike[];
  };
  /** person-store 门面：单事务落档（含 staging 置位 + 统计重算 + 游标推进 + 事件）。 */
  commitStaged(input: {
    batch_id: string;
    conversation_id: string;
    proposal_id: string;
    now: string;
  }): { committed: number; skipped: number };
}

/** 与 `packages/contracts/src/chat-ingest.ts` **结构等价**（不新增包依赖）。 */
export interface ChatMessageCommitTargetLike {
  kind: "chat_message";
  batch_id: string;
  conversation_id: string;
  message_ids: readonly string[];
  tier: "auto" | "review";
  reason_codes: readonly string[];
}

export interface ChatMessageCommitInputLike {
  proposal_id: string;
  source_id: string;
  target: ChatMessageCommitTargetLike;
  now: string;
}

/** 与 contracts `ChatMessageCommitter` 结构等价。 */
export interface ChatMessageCommitterLike {
  commit(input: ChatMessageCommitInputLike): { committed: number; skipped: number };
}

function assertTarget(target: ChatMessageCommitTargetLike): void {
  if (target.kind !== "chat_message") {
    throw new ChatIngestError(
      "INVALID_TARGET_REF",
      `提交器只接受 chat_message target，收到：${String(target.kind)}`,
    );
  }
  if (target.message_ids.length === 0) {
    throw new ChatIngestError("INVALID_TARGET_REF", "target.message_ids 不得为空（contracts 约束）");
  }
  if (target.message_ids.length > MAX_MESSAGE_IDS) {
    throw new ChatIngestError(
      "INVALID_TARGET_REF",
      `target.message_ids 超过 ${MAX_MESSAGE_IDS} 条（contracts 约束）：${target.message_ids.length}`,
    );
  }
}

/**
 * 创建聊天消息提交器。
 *
 * `commit()` 的行为：
 *   1. 校验 target（`chat_message` / 1..2000 条）；
 *   2. 读 staging 行，确认 `message_ids` 全部在暂存层存在（否则 `COMMIT_FAILED`）；
 *   3. 调 `store.commitStaged`（person-store 单事务：会话缓存 UPSERT → 发送者解析 → 成员 UPSERT →
 *      `INSERT OR IGNORE` 落档 → staging 置位 → 统计重算 → 游标推进）；
 *   4. 返回 `{ committed, skipped }`；重复调用时 `committed=0`、`skipped=已落档行数`。
 *
 * 注意（粒度差异，已知并接受）：`commitStaged` 的粒度是 `(batch_id, conversation_id)`，
 * 因此一次 accept 会把该会话所有 `staged` 行落档；proposal 的分片只影响**审计与队列粒度**。
 */
export function createChatMessageCommitter(
  store: ChatCommitStoreLike,
): ChatMessageCommitterLike {
  return {
    commit(input: ChatMessageCommitInputLike): { committed: number; skipped: number } {
      const { target } = input;
      assertTarget(target);

      const rows = store.staging.listStaged({
        batch_id: target.batch_id,
        conversation_id: target.conversation_id,
      });
      const byId = new Map(rows.map((row) => [row.message_id, row]));
      const missing: string[] = [];
      for (const messageId of target.message_ids) {
        if (!byId.has(messageId)) missing.push(messageId);
      }
      if (missing.length > 0) {
        throw new ChatIngestError(
          "COMMIT_FAILED",
          `staging 缺少 ${missing.length} 条消息（示例：${missing[0] ?? ""}），拒绝落档`,
        );
      }

      try {
        return store.commitStaged({
          batch_id: target.batch_id,
          conversation_id: target.conversation_id,
          proposal_id: input.proposal_id,
          now: input.now,
        });
      } catch (cause) {
        if (cause instanceof ChatIngestError) throw cause;
        throw new ChatIngestError("COMMIT_FAILED", "聊天消息落档事务失败", { cause });
      }
    },
  };
}
