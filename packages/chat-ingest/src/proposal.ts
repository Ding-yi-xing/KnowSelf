/**
 * proposal 构建（DESIGN-11 §6.3 / §6.4 / §6.5）。
 *
 * 粒度：**一个 proposal = (batch_id, conversation_id, 分片)**，不是一条消息一个 proposal。
 * 分片：同一会话消息按 `(ts_ms, message_id)` 升序切成 ≤ 2000 条/片（§6.4，contracts 硬约束）。
 * 审计字段（§6.3 表）：`proposed_body` = 人类可读摘要（≤8000，**不是**原文全文）、
 * `reasoning` = `tier=auto; rule_version=chat-tier-v2; reason_codes=[...]`、
 * `produced_by_provider` = `chat-ingest:rule-v1`、`source_excerpts` = `[]`（原文在 staging）。
 *
 * 与 `contracts` / `person-store` 均无 import：产出对象与 `IngestionProposal` 结构等价，
 * 由调用方（apps/server / 测试）直接写入 `store.proposals.insertMany`。
 */
import { randomUUID } from "node:crypto";
import { TIER_RULE_VERSION, type TierLabel, type TierReasonCode } from "./tier";

/** 单片消息上限（§6.4；与 contracts 的 `message_ids.max(2000)` 一致）。 */
export const PROPOSAL_SHARD_SIZE = 2000;

/** `proposed_body` 上限（contracts 硬约束）。 */
export const PROPOSED_BODY_LIMIT = 8000;

/** `reasoning` 上限（contracts 硬约束）。 */
export const REASONING_LIMIT = 2000;

/** 规则产 proposal 的 provider id（§6.3：**不是** LLM provider id）。 */
export const PROPOSAL_PROVIDER_ID = "chat-ingest:rule-v1";

/** 摘要里预览的消息条数（§6.3「前 5 条预览」）。 */
const PREVIEW_COUNT = 5;

/** 单条预览截断长度。 */
const PREVIEW_CHARS = 120;

/** `target` 形态（与 contracts `ProposalTargetChatMessage` 结构等价）。 */
export interface ChatMessageProposalTarget {
  kind: "chat_message";
  batch_id: string;
  conversation_id: string;
  message_ids: string[];
  tier: TierLabel;
  reason_codes: string[];
}

/** 与 `IngestionProposal` 结构等价的草稿（可直接 `insertMany`）。 */
export interface ChatIngestProposalDraft {
  id: string;
  source_id: string;
  target: ChatMessageProposalTarget;
  proposed_body: string;
  reasoning: string;
  source_excerpts: { start: number; end: number }[];
  produced_by_provider: string;
  status: "pending";
  user_edited_body: string | null;
  created_at: string;
  decided_at: string | null;
}

/** 摘要所需的消息字段子集（`StagingRow` / `NormalizedMessage` 均满足）。 */
export interface ProposalMessageLike {
  message_id: string;
  ts_ms: number;
  sender_name: string;
  content: string;
  content_type: string;
  role: string;
}

/** 同 `(batch_id, conversation_id)` 既有的 pending proposal（§6.5 复用判定用）。 */
export interface PendingProposalRef {
  proposal_id: string;
  message_ids: readonly string[];
}

export interface ProposalBuilderInput {
  source_id: string;
  batch_id: string;
  /** ISO8601（写入 `created_at`）。 */
  now: string;
  conversation: {
    conversation_id: string;
    title: string;
    kind: string;
  };
  tier: TierLabel;
  reason_codes: readonly string[];
  /**
   * 该会话在本批 staging 中的待落档总行数（摘要末行的 M）。
   * 缺省 = 调用方拿不到，摘要省略该行（不编造）。
   */
  conversation_pending_commit_count?: number;
  /** 测试注入确定性 UUID；缺省 `crypto.randomUUID()`。 */
  id_factory?: () => string;
}

/** 分片后的构建结果。 */
export interface ProposalPlan {
  /** 需要新建的 proposal（已按分片切好；`fresh` 为空时为空数组）。 */
  proposals: ChatIngestProposalDraft[];
  /** 与本次输入有交集的既有 pending proposal（§6.5「已入队」）。 */
  reused: PendingProposalRef[];
  /** 因已绑定 proposal / 已被既有 pending 覆盖而跳过的消息数。 */
  skipped: number;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quoteBody(text: string, limit: number): string {
  const body = oneLine(text);
  return body.length <= limit ? body : `${body.slice(0, Math.max(0, limit - 1))}…`;
}

function compareMessages(a: ProposalMessageLike, b: ProposalMessageLike): number {
  if (a.ts_ms !== b.ts_ms) return a.ts_ms - b.ts_ms;
  if (a.message_id === b.message_id) return 0;
  return a.message_id < b.message_id ? -1 : 1;
}

/**
 * `proposed_body`：人类可读摘要 —— 会话标题 / 时间范围 / 条数 / 前 5 条预览 / 命中规则
 * / 粒度提示行。
 *
 * 末行粒度提示（2A 修订新增）：`commitStaged` 是**会话级**粒度
 * （见 `committer.ts` 的「注意（粒度差异，已知并接受）」），所以「只含 1 条增量的 proposal，
 * 接受后会把这批该会话**所有** staged 行落档」。2A 去重后这种增量 proposal 会第一次变成
 * 用户可感知的错配，故摘要必须显式告知：本 proposal 新增 N 条 / 该会话本批待落档 M 条。
 * 拿不到 M（调用方未提供）时**不写**这一行，绝不编造数值。
 *
 * 严格 ≤8000 字符（超出截断，不抛错）。
 */
export function buildProposedBody(input: {
  conversation: ProposalBuilderInput["conversation"];
  messages: readonly ProposalMessageLike[];
  reason_codes: readonly string[];
  shard: { index: number; total: number };
  /** 该会话在本批 staging 中的待落档总行数（M）；缺省表示拿不到，省略该行。 */
  conversation_pending_commit_count?: number;
}): string {
  const { conversation, messages, reason_codes, shard } = input;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const title = conversation.title === "" ? "（未命名会话）" : conversation.title;
  const span =
    first === undefined || last === undefined
      ? "（无消息）"
      : `${isoOf(first.ts_ms)} ~ ${isoOf(last.ts_ms)}`;
  const shardNote =
    shard.total > 1 ? `（第 ${shard.index + 1}/${shard.total} 片）` : "";
  const lines: string[] = [
    `会话：${title}${shardNote}`,
    `会话 ID：${conversation.conversation_id}`,
    `类型：${conversation.kind}`,
    `时间范围：${span}`,
    `消息条数：${messages.length}`,
    `命中规则：${reason_codes.length === 0 ? "无（Tier A）" : reason_codes.join("、")}`,
    "前 5 条预览：",
  ];
  for (const message of messages.slice(0, PREVIEW_COUNT)) {
    const who = message.role === "me" ? "我" : message.sender_name || "（未知发送者）";
    const body =
      message.content_type === "text"
        ? quoteBody(message.content, PREVIEW_CHARS)
        : `[${message.content_type}]`;
    lines.push(`- ${isoOf(message.ts_ms)} ${who}：${body}`);
  }
  const pendingCommit = input.conversation_pending_commit_count;
  if (pendingCommit !== undefined) {
    lines.push(
      `本次新增 ${messages.length} 条 / 该会话本批待落档 ${pendingCommit} 条（接受后整批落档）`,
    );
  }
  return truncate(lines.join("\n"), PROPOSED_BODY_LIMIT);
}

/** `reasoning`：规则版本 + 分层 + 命中码（§6.3 表，逐字格式）。 */
export function buildReasoning(tier: TierLabel, reasonCodes: readonly string[]): string {
  const text = `tier=${tier}; rule_version=${TIER_RULE_VERSION}; reason_codes=[${reasonCodes.join(",")}]`;
  return truncate(text, REASONING_LIMIT);
}

/**
 * §6.5 重跑去重（2A 修订：`message_id` 集合差集）。
 *
 * 三条排除口，从强到弱：
 *   1. `chat_message_staging.proposal_id` 非空 → 已绑定过 proposal，跳过；
 *   2. 既有 pending proposal 的 `message_ids` 并集覆盖的消息 → 已在队列里，跳过；
 *   3. 其余 → `fresh`，本次真正要新建的部分。
 *
 * 为什么是差集而**不是**「同 `(batch_id, conversation_id)` 已有 pending → 整批复用」：
 *   每次 CLI 运行都会生成新的 `batch_id`，叠加「Tier B 不落档 → 游标不推进」，
 *   整批复用/整批新建都会导致重跑时重复产出覆盖相同消息的 proposal。
 *
 * 为什么**不是**「集合指纹等值比较」：等值比较遇到
 *   run1 = {m1..m5}、run2 = {m1..m6} 会判成「两个不同集合」→ 照样新建一条覆盖 6 条的
 *   proposal，重复并没有解决。`message_id` 本身已是稳定身份（staging 主键、游标键、
 *   contracts 的引用单位），差值即「本批新增了哪些消息」，与批次号无关。
 *
 * `reused` 的口径：与本次输入**有交集**即视为「已入队」（不再要求整批命中）。
 */
export function selectUnproposedMessages(input: {
  messages: readonly ProposalMessageLike[];
  /** 已绑定 proposal 的 `message_id`（来自 staging.proposal_id 非空的行）。 */
  already_proposed_message_ids?: readonly string[];
  /** 该会话的既有 pending proposal（按会话作用域查，不再带 batch_id）。 */
  existing_pending?: readonly PendingProposalRef[];
}): { fresh: ProposalMessageLike[]; reused: PendingProposalRef[]; skipped: number } {
  const bound = new Set(input.already_proposed_message_ids ?? []);
  const filtered = input.messages.filter((message) => !bound.has(message.message_id));
  const skippedByBound = input.messages.length - filtered.length;

  const pending = input.existing_pending ?? [];
  const covered = new Set<string>();
  for (const ref of pending) {
    for (const messageId of ref.message_ids) covered.add(messageId);
  }
  const thisRun = new Set(input.messages.map((message) => message.message_id));

  const fresh = filtered.filter((message) => !covered.has(message.message_id));
  const reused = pending.filter((ref) => ref.message_ids.some((messageId) => thisRun.has(messageId)));
  const skippedByCovered = filtered.length - fresh.length;

  return { fresh, reused, skipped: skippedByBound + skippedByCovered };
}

/** proposal 构建器（无状态，可复用）。 */
export class ProposalBuilder {
  private readonly input: ProposalBuilderInput;

  constructor(input: ProposalBuilderInput) {
    this.input = input;
  }

  /** 单会话消息分片（升序 ≤2000/片），不含去重逻辑。 */
  shard(messages: readonly ProposalMessageLike[]): ProposalMessageLike[][] {
    const sorted = [...messages].sort(compareMessages);
    const shards: ProposalMessageLike[][] = [];
    for (let index = 0; index < sorted.length; index += PROPOSAL_SHARD_SIZE) {
      shards.push(sorted.slice(index, index + PROPOSAL_SHARD_SIZE));
    }
    return shards;
  }

  /** 把一片消息构造为一个 proposal（`status='pending'`，等 accept / 入队）。 */
  buildOne(messages: readonly ProposalMessageLike[], shard: { index: number; total: number }): ChatIngestProposalDraft {
    const { input } = this;
    const makeId = input.id_factory ?? randomUUID;
    return {
      id: makeId(),
      source_id: input.source_id,
      target: {
        kind: "chat_message",
        batch_id: input.batch_id,
        conversation_id: input.conversation.conversation_id,
        message_ids: messages.map((message) => message.message_id),
        tier: input.tier,
        reason_codes: [...input.reason_codes],
      },
      proposed_body: buildProposedBody({
        conversation: input.conversation,
        messages,
        reason_codes: input.reason_codes,
        shard,
        ...(input.conversation_pending_commit_count === undefined
          ? {}
          : { conversation_pending_commit_count: input.conversation_pending_commit_count }),
      }),
      reasoning: buildReasoning(input.tier, input.reason_codes),
      source_excerpts: [],
      produced_by_provider: PROPOSAL_PROVIDER_ID,
      status: "pending",
      user_edited_body: null,
      created_at: input.now,
      decided_at: null,
    };
  }

  /**
   * 完整计划：去重（§6.5 差集）+ 分片（§6.4）+ 审计字段（§6.3）。
   * 返回 `proposals` 为空表示本次无需新建（全部被 bound/covered 挡掉）。
   */
  plan(input: {
    messages: readonly ProposalMessageLike[];
    already_proposed_message_ids?: readonly string[];
    existing_pending?: readonly PendingProposalRef[];
  }): ProposalPlan {
    const selected = selectUnproposedMessages(input);
    // 短路：`fresh` 为空时**不得**产出空 message_ids 的 proposal（contracts 要求 1..2000 条）。
    if (selected.fresh.length === 0) {
      return { proposals: [], reused: selected.reused, skipped: selected.skipped };
    }
    const shards = this.shard(selected.fresh);
    const proposals = shards.map((messages, index) =>
      this.buildOne(messages, { index, total: shards.length }),
    );
    return { proposals, reused: selected.reused, skipped: selected.skipped };
  }
}
