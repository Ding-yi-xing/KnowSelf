/**
 * `commitStaged` 的步骤实现（DESIGN-13 §4.3 步骤 ①~⑦；按 §2.2 行预算拆分，`commit.ts` 只做编排）。
 * 顺序说明：§4.3 的 ②（成员）与 ③（发送者解析）**互换**——成员行需要 `person_id`，必须先解析。
 */
import { SELF_PERSON_ID } from "./ddl/migrations";
import type { EnsurePersonForUidInput, EnsurePersonForUidResult } from "./identity";
import type { ConversationsRepo } from "./repository/conversations";
import type { StagingRepo } from "./repository/staging";
import type { ChatMessageInsert, ConversationUpsert } from "./types-chat";
import type { StagingRow } from "./types-ingest";

export interface CommitStagedInput {
  batch_id: string;
  conversation_id: string;
  proposal_id: string;
  now: string;
  /**
   * 加法式可选参数：会话元数据（kind / title / member_count）。
   * 为什么可选：DESIGN-11 §7.5 的 `commitStaged` 签名未给会话元数据来源，而 staging 层无 `kind` / `title`；
   * 缺省时由 staging 行推导（`title` / `kind` 沿用既有值，不覆盖）。
   */
  conversation?: ConversationUpsert;
}

export interface CommitStagedResult {
  committed: number;
  skipped: number;
}

export interface StepDeps {
  staging: StagingRepo;
  conversations: ConversationsRepo;
  ensurePersonForUid(input: EnsurePersonForUidInput): EnsurePersonForUidResult;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** 缺省推导（见 `CommitStagedInput.conversation` 注）：`title` / `kind` 优先沿用既有行。 */
export function resolveConversation(
  deps: StepDeps,
  input: CommitStagedInput,
  rows: readonly StagingRow[],
): ConversationUpsert {
  if (input.conversation !== undefined) return input.conversation;
  const existing = deps.conversations.get(input.conversation_id);
  const senders = new Set(rows.map((row) => row.sender_id));
  let firstMs = rows[0]?.ts_ms ?? 0;
  let lastMs = firstMs;
  for (const row of rows) {
    if (row.ts_ms < firstMs) firstMs = row.ts_ms;
    if (row.ts_ms > lastMs) lastMs = row.ts_ms;
  }
  return {
    conversation_id: input.conversation_id,
    platform: rows[0]?.platform ?? existing?.platform ?? "wechat",
    kind: existing?.kind ?? (senders.size > 2 ? "group" : "direct"),
    title: existing?.title ?? "",
    member_count: Math.max(existing?.member_count ?? 0, senders.size),
    first_msg_at: isoOf(firstMs),
    last_msg_at: isoOf(lastMs),
  };
}

/**
 * 发送者解析（DESIGN-11 §4.5）：`role='me'` → `'me'`（**不**建 contact）；
 * `role='system'` → 跳过（系统消息不参与人际归因）。
 */
export function resolveSenders(
  deps: StepDeps,
  rows: readonly StagingRow[],
  now: string,
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const row of rows) {
    if (resolved.has(row.sender_id) || row.role === "system") continue;
    if (row.role === "me") {
      resolved.set(row.sender_id, SELF_PERSON_ID);
      continue;
    }
    resolved.set(
      row.sender_id,
      deps.ensurePersonForUid({
        platform: row.platform,
        platform_uid: row.sender_id,
        display_name: row.sender_name,
        now,
      }).person_id,
    );
  }
  return resolved;
}

/** 成员行 = 「有发言的人」（DESIGN-11 §4.5）；时间跨度取本批 MIN/MAX。 */
export function upsertMembers(
  deps: StepDeps,
  input: CommitStagedInput,
  rows: readonly StagingRow[],
  personIds: Map<string, string>,
): void {
  const span = new Map<string, { first: string; last: string }>();
  for (const row of rows) {
    const personId = personIds.get(row.sender_id);
    if (personId === undefined) continue;
    const iso = isoOf(row.ts_ms);
    const prev = span.get(personId);
    if (prev === undefined) {
      span.set(personId, { first: iso, last: iso });
      continue;
    }
    if (iso < prev.first) prev.first = iso;
    if (iso > prev.last) prev.last = iso;
  }
  for (const [personId, value] of span) {
    deps.conversations.upsertMember(
      {
        conversation_id: input.conversation_id,
        person_id: personId,
        first_msg_at: value.first,
        last_msg_at: value.last,
      },
      input.now,
    );
  }
}

export function toMessageInsert(row: StagingRow, now: string): ChatMessageInsert {
  return {
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    platform: row.platform,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    role: row.role,
    ts_ms: row.ts_ms,
    msg_date: row.msg_date,
    content: row.content,
    content_type: row.content_type,
    reply_to: row.reply_to,
    meta: row.meta,
    batch_id: row.batch_id,
    ingested_at: now,
  };
}

/** 游标推进（§4.4 ⑥ / §5.3 L3）：取本批 `(ts_ms, message_id)` 最大者，MAX 语义不回退。 */
export function advanceCursor(
  deps: StepDeps,
  input: CommitStagedInput,
  rows: readonly StagingRow[],
): void {
  const first = rows[0];
  if (first === undefined) return;
  let maxTs = first.ts_ms;
  let maxId = first.message_id;
  for (const row of rows) {
    if (row.ts_ms > maxTs || (row.ts_ms === maxTs && row.message_id > maxId)) {
      maxTs = row.ts_ms;
      maxId = row.message_id;
    }
  }
  deps.staging.advanceCursor({
    platform: first.platform,
    conversation_id: input.conversation_id,
    last_ts_ms: maxTs,
    last_message_id: maxId,
    now: input.now,
  });
}
