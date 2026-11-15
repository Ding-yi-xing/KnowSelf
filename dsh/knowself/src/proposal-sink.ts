/**
 * proposal-sink —— 把 chat-ingest 的 pipeline 提案接到「真实 ingestion 提案系统」。
 *
 * `IngestProposalSink` 由调用方（本项目即 dsh 插件）实现，保持 chat-ingest 的包边界
 * 干净（不直接依赖 ingestion）。本适配器：
 *   - listPending → `ingestion.listProposalsByStatus('pending')`（同表查询）
 *   - accept      → `ingestion.acceptProposal`（走 profile 落档 + 关联）
 *   - create      → `profileStore.proposals.insertMany`（与 ingestion 共享 proposals 表）
 *
 * 注：contracts 注释称「必须走 ingestion.createProposal」，但 `Ingestion` 公开接口未暴露
 * create（提案仅在 runDistill 内部生成）。`ChatIngestProposalDraft` 注释明确「与
 * IngestionProposal 结构等价，可直接 insertMany」，故 create 走 profileStore.proposals
 * 落同一张表——这仍是 ingestion 提案系统的真实存储路径。已登记为 README 偏差项。
 */
import type { Ingestion } from "@knowself/ingestion";
import type { ProfileStore } from "@knowself/profile-store";
import type {
  IngestProposalSink,
  PendingProposalRef,
} from "@knowself/chat-ingest";
import type { IngestionProposal } from "@knowself/contracts";

/** 构造接入真实 ingestion 提案系统的 proposalSink。 */
export function makeIngestionProposalSink(
  ingestion: Ingestion,
  profileStore: ProfileStore,
): IngestProposalSink {
  return {
    listPending(input: { conversation_id: string }): readonly PendingProposalRef[] {
      const pending = ingestion.listProposalsByStatus("pending");
      return pending
        .filter(
          (p) =>
            (p.target as { kind?: string; conversation_id?: string }).kind ===
              "chat_message" &&
            (p.target as { conversation_id?: string }).conversation_id ===
              input.conversation_id,
        )
        .map((p) => ({
          proposal_id: p.id,
          message_ids:
            (p.target as { message_ids?: string[] }).message_ids ?? [],
        }));
    },

    create(proposal: Parameters<IngestProposalSink["create"]>[0]): void {
      // ChatIngestProposalDraft 与 IngestionProposal 结构等价，可直接落同一张表。
      profileStore.proposals.insertMany([proposal as unknown as IngestionProposal]);
    },

    accept(proposalId: string): void {
      ingestion.acceptProposal(proposalId);
    },

    drainWarnings(): readonly string[] {
      return [];
    },
  };
}
