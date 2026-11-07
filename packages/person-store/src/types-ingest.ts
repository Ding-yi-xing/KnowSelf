/**
 * 采集层行类型（DESIGN-13 §2.2 `types.ts` 的采集部分，按「表族」拆分；见 `types-chat.ts` 头注）。
 * 来源：DESIGN-10 §2.5 的 DDL + DESIGN-11 §4.3 的 `chat_message_staging` + DESIGN-11 Q8 加法式加列。
 */
import type { ChatPlatform, ContentType, MessageRole } from "./types-chat";

export type StagingStatus = "staged" | "committed" | "rejected";
export type StagingTier = "auto" | "review";
export type BatchStatus = "running" | "succeeded" | "failed" | "reverted";

// ── chat_message_staging（DESIGN-11 §4.3）──────────────────────────────────

export interface StagingRow {
  batch_id: string;
  conversation_id: string;
  message_id: string;
  platform: ChatPlatform;
  sender_id: string;
  sender_name: string;
  role: MessageRole;
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: ContentType;
  reply_to: string | null;
  meta: string;
  tier: StagingTier;
  reason_codes: string;
  status: StagingStatus;
  proposal_id: string | null;
  created_at: string;
  committed_at: string | null;
}

/** `stageMessages` 入参（`batch_id` / `conversation_id` / `created_at` 由签名参数提供）。 */
export type StagingInsert = Omit<
  StagingRow,
  | "batch_id"
  | "conversation_id"
  | "created_at"
  | "status"
  | "proposal_id"
  | "committed_at"
  | "tier"
  | "reason_codes"
> & { tier?: StagingTier; reason_codes?: string };

// ── ingest_batches / ingest_cursors（DESIGN-10 §2.5 + DESIGN-11 Q8）────────

export interface BatchRow {
  batch_id: string;
  platform: string;
  extractor: string;
  tool_version: string;
  started_at: string;
  finished_at: string | null;
  status: BatchStatus;
  conversation_count: number;
  message_count: number;
  skipped_count: number;
  cursor_snapshot_json: string | null;
  error_message: string | null;
  reverted_at: string | null;
}

export interface CursorRow {
  platform: string;
  conversation_id: string;
  last_ts_ms: number;
  last_message_id: string | null;
}

/**
 * 对账行（DESIGN-13 §3.7 `reconcile`；**行形状文档未定义**——见本工单「待确认」）：
 * `staging_committed_without_message` = staging 已 committed 但 `chat_messages` 缺行；
 * `message_without_staging` = `chat_messages` 有行但对应 staging 未 committed
 * （崩溃恢复不变量，DESIGN-11 §8.2）。
 */
export interface ReconcileRow {
  batch_id: string;
  conversation_id: string;
  message_id: string;
  issue: "staging_committed_without_message" | "message_without_staging";
}
