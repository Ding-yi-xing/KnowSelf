/**
 * chat-proposal-sink.ts — `IngestProposalSink` 的生产实现（DESIGN-11 §7.3 / §6.5）
 *
 * 职责：把 `chat-ingest` 产出的 proposal draft 落进 `profile.sqlite` 的 `ingestion_proposals`，
 * 并暴露「自动 accept」能力（Tier A 走 `ingestion.acceptProposal` → 注入的 chatCommitter）。
 *
 * 为什么放在 `apps/server`：只有装配层同时握有 `profileStore` 与 `ingestion`；
 * `chat-ingest` 自身不 import `profile-store`，`ingestion` 也不 import `chat-ingest`（依赖矩阵约束）。
 *
 * 设计约束：
 *   - `listPending` **只按 `conversation_id` 匹配** pending 的 chat_message proposal（2A 修订）：
 *     每次 CLI 运行都会生成新的 `batch_id`，若继续按 `(batch_id, conversation_id)` 匹配，
 *     重跑时永远查不到上一轮留下的 pending，于是每轮都新建覆盖相同消息的 proposal。
 *     是否「已覆盖」由 `chat-ingest` 侧按 `message_ids` 集合差集判定；
 *   - **扫描窗口 = 队列实际规模**（`countByStatus`），不再固定截断在 500 行：
 *     按会话作用域查 pending 时，固定窗口会让积压一多就静默漏判，去重随之失效——
 *     而那正好是去重最需要生效的场景。只有在超过**内存保护上限**（`HARD_CEILING`，
 *     默认 5000）时才截断，且此时必须同时 `console.warn`（服务端可观测）与
 *     `drainWarnings()`（用户可见的导入摘要），因为「静默降级」等于没降级；
 *   - `create` 直接复用 draft 字段，`target` 由 profile-store 序列化为 `target_ref`；
 *   - `accept` 必须经 `ingestion.acceptProposal`（不自行改状态），保证落档与状态变更的顺序语义。
 */

import type { IngestionProposal } from "@knowself/contracts";
import type { ChatIngestProposalDraft, IngestProposalSink, PendingProposalRef } from "@knowself/chat-ingest";

/** 单次 pending 扫描的行数硬上限（内存保护）；**不是**「积压过多」的软阈值。 */
const DEFAULT_SCAN_CEILING = 5000;

/** 装配层依赖：`ProfileStore.proposals` 的结构子集（便于测试注入）。 */
export interface ProposalStoreLike {
  proposals: {
    insertMany(items: IngestionProposal[]): void;
    listByStatus(status: "pending", limit?: number): IngestionProposal[];
    /**
     * 「待整理」队列规模，用作扫描窗口的唯一定量来源。
     * 用结构子集（`{ pending?: number }`）而不 import `ProposalStatus`，保持装配层类型面最小。
     */
    countByStatus(): { pending?: number };
  };
}

export interface ProfileProposalSinkDeps {
  profileStore: ProposalStoreLike;
  /** 通常传 `(id) => ingestion.acceptProposal(id)`。 */
  acceptProposal: (proposalId: string) => unknown;
  /**
   * 单次 pending 扫描的**硬上限**（内存保护），默认 5000。
   * 仅作上限使用，不参与"是否告警"以外的任何判断——不要把它当软阈值。
   */
  scanLimit?: number;
}

/** 把 draft 映射为 profile-store 需要的 `IngestionProposal`。 */
export function draftToProposal(draft: ChatIngestProposalDraft): IngestionProposal {
  return {
    id: draft.id,
    source_id: draft.source_id,
    target: draft.target as IngestionProposal["target"],
    proposed_body: draft.proposed_body,
    reasoning: draft.reasoning,
    source_excerpts: draft.source_excerpts.map((e) => ({
      start: e.start,
      end: e.end,
    })) as IngestionProposal["source_excerpts"],
    produced_by_provider: draft.produced_by_provider,
    status: draft.status,
    user_edited_body: draft.user_edited_body,
    created_at: draft.created_at,
    decided_at: draft.decided_at,
  };
}

function isChatTarget(
  proposal: IngestionProposal,
): proposal is IngestionProposal & {
  target: { kind: "chat_message"; batch_id: string; conversation_id: string; message_ids: readonly string[] };
} {
  const target = proposal.target as { kind?: string; batch_id?: unknown; conversation_id?: unknown };
  return (
    target.kind === "chat_message" &&
    typeof target.batch_id === "string" &&
    typeof target.conversation_id === "string"
  );
}

export function createProfileProposalSink(deps: ProfileProposalSinkDeps): IngestProposalSink {
  const scanCeiling = deps.scanLimit ?? DEFAULT_SCAN_CEILING;
  /**
   * 待上报给用户的告警（`drainWarnings()` 取走即清空）。
   * 与 `console.warn` 是**并列出口**：服务端可观测性与用户可见性都要，不是二选一。
   */
  const warnings: string[] = [];
  /** 上一次截断时首个触发的会话（只用于 `console.warn` 的定位，不进用户文案）。 */
  let firstTruncatedConversation: string | null = null;

  return {
    listPending({ conversation_id }): readonly PendingProposalRef[] {
      const pendingTotal = deps.profileStore.proposals.countByStatus().pending ?? 0;
      const pendings = deps.profileStore.proposals.listByStatus(
        "pending",
        Math.min(pendingTotal, scanCeiling),
      );

      // 告警的唯一触发条件是「真的漏判了」（严格大于上限），不是「数量有点多」。
      if (pendingTotal > scanCeiling) {
        const message =
          `待整理积压 ${pendingTotal} 条，超过单次扫描上限 ${scanCeiling} 条，` +
          "本次去重可能不完整，建议先清理「待整理」队列";
        // 去重：listPending 每个会话调一次，不去重会把同一句话刷 N 遍（日志与摘要都变噪音）。
        if (!warnings.includes(message)) {
          firstTruncatedConversation = conversation_id;
          warnings.push(message);
          console.warn(
            `[chat-proposal-sink] ${message}（首次触发会话：${firstTruncatedConversation}）`,
          );
        }
      }

      const refs: PendingProposalRef[] = [];
      for (const p of pendings) {
        if (!isChatTarget(p)) continue;
        if (p.target.conversation_id !== conversation_id) continue;
        refs.push({ proposal_id: p.id, message_ids: p.target.message_ids ?? [] });
      }
      return refs;
    },

    drainWarnings(): readonly string[] {
      const drained = [...warnings];
      warnings.length = 0; // 取走即清空：否则同进程多次导入会把上次告警带进下次摘要
      firstTruncatedConversation = null;
      return drained;
    },

    create(proposal: ChatIngestProposalDraft): void {
      deps.profileStore.proposals.insertMany([draftToProposal(proposal)]);
    },

    accept(proposalId: string): void {
      deps.acceptProposal(proposalId);
    },
  };
}
