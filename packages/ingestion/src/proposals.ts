/**
 * proposals.ts — IngestionProposal 审阅操作
 *
 * 4 个公开函数：
 *   acceptProposal — 接受建议，写入 profile 并创建 profile_sources 关联
 *   editProposal   — 编辑后接受
 *   rejectProposal — 拒绝
 *   listProposals  — 按 source 列出
 *
 * DESIGN-11 §7.2 #4（加法式）：新增可选 `chatCommitter`，`acceptProposal` / `editProposal`
 * 增加 `chat_message` 分支——走注入的提交器落 persons.sqlite，**不**调
 * `buildLink` / `links.insert` / `proposalToWriteRequest`（§7.4）。
 */

import type {
  SourceId,
  ProposalId,
  IngestionProposal,
  WriteRequest,
  ProfileSourceLink,
  ChatMessageCommitter,
  ChatMessageRejecter,
} from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import { ProposalNotPendingError, InvalidTargetRefError, ProposalNotFoundError } from "./errors";
import { runDistill, type DistillDeps } from "./distill";

/** proposals 操作依赖。 */
export interface ProposalDeps {
  store: ProfileStore;
  now?: () => string;
  /**
   * chat_message 落档提交器（DESIGN-11 §7.3）。
   * 缺省时 `chat_message` 决策抛 `INVALID_TARGET_REF`（**不静默成功**）。
   */
  chatCommitter?: ChatMessageCommitter;
  /**
   * 批 1.5：`chat_message` 拒绝器，与 `chatCommitter` 对称。
   * 缺省时 `rejectProposal` 的 `chat_message` 分支抛 `INVALID_TARGET_REF`（**不静默成功**）——
   * 因为「只改 proposal 状态」会让被拒内容在下次 accept 时被 `commitStaged` 一并落档。
   */
  chatRejecter?: ChatMessageRejecter;
}

/** Dependencies needed to accept a source-distill review request. */
export interface SourceDistillProposalDeps extends ProposalDeps, DistillDeps {}

/**
 * 接受一条 proposal，将其内容写入 profile 并用 "assistant" 出处。
 * 同时写入 profile_sources 关联表。
 */
export function acceptProposal(deps: ProposalDeps, proposalId: ProposalId): IngestionProposal {
  const now = deps.now ?? (() => new Date().toISOString());
  const proposal = getProposalOrThrow(deps.store, proposalId);

  if (proposal.status !== "pending") {
    throw new ProposalNotPendingError(proposalId, proposal.status);
  }

  if (proposal.target.kind === "source_distill") {
    throw new InvalidTargetRefError(
      "source_distill must be accepted through acceptSourceDistillProposal",
    );
  }

  // ── 加法式分支：chat_message 走注入的提交器，不触碰 profile 写入链路（DESIGN-11 §7.2 #4）──
  if (proposal.target.kind === "chat_message") {
    const committer = requireChatCommitter(deps);
    // ① 先落 persons.sqlite（幂等，§8.4 场景 ②）
    committer.commit({
      proposal_id: proposal.id,
      source_id: proposal.source_id,
      target: proposal.target,
      now: now(),
    });
    // ② 再改 proposal 状态（profile.sqlite）；② 失败可重试，① 幂等
    return deps.store.transaction(() => {
      deps.store.proposals.decide(proposalId, { decision: "accept" }, now());
      refreshSourceStatusAfterDecision(deps.store, proposal.source_id, now());
      return getProposalOrThrow(deps.store, proposalId);
    });
  }

  return deps.store.transaction(() => {
    const writeReq = proposalToWriteRequest(proposal);
    deps.store.write(writeReq, { callerKind: "ingestion" });

    const link = buildLink(proposal, now());
    deps.store.links.insert(link);

    deps.store.proposals.decide(proposalId, { decision: "accept" }, now());
    refreshSourceStatusAfterDecision(deps.store, proposal.source_id, now());
    return getProposalOrThrow(deps.store, proposalId);
  });
}

/**
 * 编辑 proposal 内容后接受。用户修改后的内容落档。
 *
 * `chat_message` 分支下 `editedBody` 只更新 `proposed_body` 摘要，**不**改消息载荷（§7.2）。
 */
export function editProposal(
  deps: ProposalDeps,
  proposalId: ProposalId,
  editedBody: string,
): IngestionProposal {
  const now = deps.now ?? (() => new Date().toISOString());
  const proposal = getProposalOrThrow(deps.store, proposalId);

  if (proposal.status !== "pending") {
    throw new ProposalNotPendingError(proposalId, proposal.status);
  }

  if (proposal.target.kind === "source_distill") {
    throw new InvalidTargetRefError("source_distill requests cannot be edited");
  }

  if (proposal.target.kind === "chat_message") {
    const committer = requireChatCommitter(deps);
    committer.commit({
      proposal_id: proposal.id,
      source_id: proposal.source_id,
      target: proposal.target,
      now: now(),
    });
    return deps.store.transaction(() => {
      deps.store.proposals.decide(proposalId, { decision: "edit", body: editedBody }, now());
      refreshSourceStatusAfterDecision(deps.store, proposal.source_id, now());
      return getProposalOrThrow(deps.store, proposalId);
    });
  }

  return deps.store.transaction(() => {
    const writeReq = proposalToWriteRequest({ ...proposal, proposed_body: editedBody });
    deps.store.write(writeReq, { callerKind: "ingestion" });

    const link = buildLink(proposal, now());
    deps.store.links.insert(link);

    deps.store.proposals.decide(proposalId, { decision: "edit", body: editedBody }, now());
    refreshSourceStatusAfterDecision(deps.store, proposal.source_id, now());
    return getProposalOrThrow(deps.store, proposalId);
  });
}

/**
 * 拒绝一条 proposal。
 *
 * 普通 proposal：仅改状态，不写 profile。
 * `chat_message` proposal（批 1.5）：**先跨批拒绝 staging，再改状态**。
 * 顺序与 `acceptProposal` 对称——staging 是幂等的，profile 状态失败可重试。
 */
export function rejectProposal(deps: ProposalDeps, proposalId: ProposalId): IngestionProposal {
  const now = deps.now ?? (() => new Date().toISOString());
  const proposal = getProposalOrThrow(deps.store, proposalId);

  if (proposal.status !== "pending") {
    throw new ProposalNotPendingError(proposalId, proposal.status);
  }

  // ── 批 1.5 加法式分支：chat_message 必须把拒绝落到 staging ──
  // 否则 `commitStaged` 取该会话全部 staged 行时，被拒内容会被后续 accept 一并落档。
  if (proposal.target.kind === "chat_message") {
    const rejecter = requireChatRejecter(deps);
    rejecter.reject({
      proposal_id: proposal.id,
      target: proposal.target,
      now: now(),
    });
    return deps.store.transaction(() => {
      deps.store.proposals.decide(proposalId, { decision: "reject" }, now());
      refreshSourceStatusAfterDecision(deps.store, proposal.source_id, now());
      return deps.store.proposals.get(proposalId);
    });
  }

  return deps.store.transaction(() => {
    deps.store.proposals.decide(proposalId, { decision: "reject" }, now());
    refreshSourceStatusAfterDecision(deps.store, proposal.source_id, now());
    return deps.store.proposals.get(proposalId);
  });
}

/**
 * Accepts a source-distill review request. A durable claim happens before the
 * provider call so multiple UI windows cannot create duplicate model work.
 */
export async function acceptSourceDistillProposal(
  deps: SourceDistillProposalDeps,
  proposalId: ProposalId,
): Promise<IngestionProposal> {
  const now = deps.now ?? (() => new Date().toISOString());
  const claimed = deps.store.proposals.claimSourceDistill(proposalId);
  if (claimed === null) {
    const current = getProposalOrThrow(deps.store, proposalId);
    if (current.target.kind !== "source_distill") {
      throw new InvalidTargetRefError("proposal is not a source_distill request");
    }
    throw new ProposalNotPendingError(proposalId, current.status);
  }

  try {
    const source = deps.store.sources.get(claimed.source_id);
    await runDistill(deps, source, {
      provider_id: "",
      focus_hints: [],
      max_proposals: 8,
      force: false,
    });
    const completed = deps.store.proposals.completeSourceDistill(proposalId, now());
    if (completed === null) {
      throw new ProposalNotPendingError(proposalId, "processing");
    }
    return completed;
  } catch (cause) {
    deps.store.proposals.releaseSourceDistill(proposalId);
    throw cause;
  }
}

/**
 * 列出某个 source 下的所有 proposals。
 */
export function listProposals(deps: ProposalDeps, sourceId: SourceId): IngestionProposal[] {
  return deps.store.proposals.listBySource(sourceId);
}

/**
 * 跨 source 全局列出 proposals，按状态过滤。用于「待整理」收件箱。
 */
export function listProposalsByStatus(
  deps: ProposalDeps,
  status: IngestionProposal["status"] | "all" = "pending",
  limit = 100,
): IngestionProposal[] {
  return deps.store.proposals.listByStatus(status, limit);
}

// ──────────────────────────────────────────────────────────────
//  内部辅助
// ──────────────────────────────────────────────────────────────

function getProposalOrThrow(store: ProfileStore, proposalId: ProposalId): IngestionProposal {
  try {
    return store.proposals.get(proposalId);
  } catch (err) {
    if ((err as { code?: string }).code === "PROFILE_NOT_FOUND") {
      throw new ProposalNotFoundError(proposalId);
    }
    throw err;
  }
}

/**
 * chat_message 落档提交器（DESIGN-11 §7.3）。
 * 未注入时**明确报错**（`INVALID_TARGET_REF`），不静默成功、不回退到 profile 写入链路。
 */
function requireChatCommitter(deps: ProposalDeps): ChatMessageCommitter {
  if (deps.chatCommitter === undefined) {
    throw new InvalidTargetRefError("chat_message committer 未注入（DESIGN-11 §7.3）");
  }
  return deps.chatCommitter;
}

function requireChatRejecter(deps: ProposalDeps): ChatMessageRejecter {
  if (deps.chatRejecter === undefined) {
    throw new InvalidTargetRefError("chat_message rejecter 未注入（批 1.5：拒绝必须落到 staging）");
  }
  return deps.chatRejecter;
}

function refreshSourceStatusAfterDecision(store: ProfileStore, sourceId: SourceId, now: string): void {
  const pendingCount = store.proposals
    .listBySource(sourceId)
    .filter((item) => item.status === "pending").length;
  store.sources.updateStatus(sourceId, pendingCount > 0 ? "pending_review" : "completed", now);
}

function proposalToWriteRequest(p: IngestionProposal): WriteRequest {
  const t = p.target;

  if (t.kind === "core") {
    return {
      target: "core",
      body: p.proposed_body,
      provenance: "assistant",
    } satisfies WriteRequest;
  }

  if (t.kind === "card_section") {
    return {
      target: "card_section",
      key: t.card_key,
      section: t.section,
      body: p.proposed_body,
      provenance: "assistant",
    } satisfies WriteRequest;
  }

  if (t.kind === "journal") {
    return {
      target: "journal",
      date: t.date,
      body: p.proposed_body,
      tags: [],
      provenance: "assistant",
    } satisfies WriteRequest;
  }

  throw new InvalidTargetRefError(`Unknown target kind: ${(t as { kind: string }).kind}`);
}

function buildLink(proposal: IngestionProposal, now: string): ProfileSourceLink {
  const profileKind = proposalTargetToProfileRefKind(proposal.target.kind);
  const profileId = resolveProfileId(proposal.target);

  return {
    profile_kind: profileKind,
    profile_id: profileId,
    source_id: proposal.source_id,
    proposal_id: proposal.id,
    created_at: now,
  };
}

function proposalTargetToProfileRefKind(kind: string): ProfileSourceLink["profile_kind"] {
  if (kind === "core") return "core";
  if (kind === "card_section") return "card_section";
  return "journal_record";
}

function resolveProfileId(target: IngestionProposal["target"]): string {
  if (target.kind === "core") return "core_main";
  if (target.kind === "card_section") return `card_section:${target.card_key}:${target.section}`;
  // chat_message — 不走 profile 写入链路（accept 前会命中 chat_message 分支，此处仅占位）
  if (target.kind === "chat_message") return `chat_message:${target.batch_id}`;
  if (target.kind === "source_distill") return "source_distill";
  // journal — place date; actual record id is unknown until write completes
  return `journal_record:${target.date}`;
}
