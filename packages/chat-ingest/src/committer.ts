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
    /** W-31：会话显示名；缺省时由 person-store 回落到 `conversation_id`（群号）。 */
    conversation_title?: string;
  }): { committed: number; skipped: number };
}

/** 与 `packages/contracts/src/chat-ingest.ts` **结构等价**（不新增包依赖）。 */
export interface ChatMessageCommitTargetLike {
  kind: "chat_message";
  batch_id: string;
  conversation_id: string;
  /** W-31：会话显示名（可选，加法式；缺省 = 回落 `conversation_id`）。 */
  conversation_title?: string;
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
          // W-31：把解析阶段已知的会话显示名交给 person-store 落档，
          // 否则 `resolveConversation` 只能回落成 `conversation_id`（群号）。
          ...(target.conversation_title === undefined || target.conversation_title.trim() === ""
            ? {}
            : { conversation_title: target.conversation_title.trim() }),
        });
      } catch (cause) {
        if (cause instanceof ChatIngestError) throw cause;
        throw new ChatIngestError("COMMIT_FAILED", "聊天消息落档事务失败", { cause });
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  批 1.5：与 committer 对称的 rejecter
//
//  为什么必须对称：原先 `rejectProposal` 只改 `ingestion_proposals` 状态、零触碰
//  staging，而 `commitStaged` 取该会话全部 `staged` 行 ⇒ 被拒内容照样落档。
//  跨批次按 `message_ids` 精确拒绝，杜绝「拒绝的有效期只有一个导入周期」。
// ──────────────────────────────────────────────────────────────────────────

/** 拒绝器所需的最小 store 能力面（`PersonStore.staging` 满足）。 */
export interface ChatRejectStoreLike {
  staging: {
    rejectStagedCrossBatch(q: {
      conversation_id: string;
      proposal_id: string;
      message_ids: readonly string[];
      now: string;
    }): { rejected: number; remaining_staged: number };
  };
}

/** 与 contracts `ChatMessageRejectInput` 结构等价。 */
export interface ChatMessageRejectInputLike {
  proposal_id: string;
  target: ChatMessageCommitTargetLike;
  now: string;
}

/** 与 contracts `ChatMessageRejecter` 结构等价。 */
export interface ChatMessageRejecterLike {
  reject(input: ChatMessageRejectInputLike): { rejected: number };
}

/**
 * 创建聊天消息拒绝器。
 *
 * `reject()` 的行为：
 *   1. 校验 target（`chat_message` / 1..2000 条，复用 `assertTarget`）；
 *   2. 调 `staging.rejectStagedCrossBatch` —— 跨批次按 `message_ids` 置 rejected，
 *      SQL 自带三道安全阀（`status='staged'` / 仅 succeeded 批次 / `proposal_id` 落审计）；
 *   3. **内容级不变量核销**：`remaining_staged > 0` 即抛错，绝不静默返回成功。
 *
 * 幂等：重复调用时 `rejected=0`、`remaining_staged=0`，正常返回（与 `commit` 对称）。
 */
export function createChatMessageRejecter(
  store: ChatRejectStoreLike,
): ChatMessageRejecterLike {
  return {
    reject(input: ChatMessageRejectInputLike): { rejected: number } {
      const { target } = input;
      assertTarget(target);

      let result: { rejected: number; remaining_staged: number };
      try {
        result = store.staging.rejectStagedCrossBatch({
          conversation_id: target.conversation_id,
          proposal_id: input.proposal_id,
          message_ids: target.message_ids,
          now: input.now,
        });
      } catch (cause) {
        if (cause instanceof ChatIngestError) throw cause;
        throw new ChatIngestError("INVALID_TARGET_REF", "聊天消息跨批拒绝失败", { cause });
      }

      // 核销判据不是「有几行被改了」，而是「这些内容还能不能被落档」。
      if (result.remaining_staged > 0) {
        throw new ChatIngestError(
          "INVALID_TARGET_REF",
          `拒绝后仍有 ${result.remaining_staged} 条相同消息处于 staged（可能属于 running 批次），` +
            "无法保证不会再次落档；请把本次拒绝视为未生效",
        );
      }

      return { rejected: result.rejected };
    },
  };
}
