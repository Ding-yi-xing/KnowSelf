/**
 * 原文层 / 关系缓存层的行类型与字面量联合（DESIGN-13 §2.2 `types.ts` 的聊天部分）。
 * 为什么单拆：`types.ts` 已达 §2.2 行预算（≤200 行），按「表族」再拆；对外由 `index.ts` 统一导出。
 * 来源：DESIGN-10 §2.4 / §2.2 的 DDL 投影——列名与 CHECK 取值逐字对应，不得自创。
 * 约定：DB 的 `0/1` 在 repository 层转 `boolean`（`chat_members.is_active`）；
 *       JSON TEXT 列保持字符串原样（`meta` / `source_ref`）。
 * 采集层（staging / batches / cursors）见 `types-ingest.ts`。
 */
import type { AliasPlatform } from "./types";

// ── 字面量联合（DDL CHECK 取值）─────────────────────────────────────────────

export type ConversationKind = "direct" | "group";
/** `chat_*` 的 `platform` 与 `aliases.platform` 同枚举（DESIGN-10 §2.4）。 */
export type ChatPlatform = AliasPlatform;
export type MessageRole = "me" | "other" | "system";
export type ContentType =
  | "text"
  | "image"
  | "file"
  | "link"
  | "voice"
  | "video"
  | "system"
  | "other";
export type MentionKind = "at" | "reply" | "at_all";
export type RoleInGroup = "owner" | "admin" | "member" | "unknown";

// ── chat_conversations（DESIGN-10 §2.4）────────────────────────────────────

export interface ChatConversationRow {
  conversation_id: string;
  platform: ChatPlatform;
  kind: ConversationKind;
  title: string;
  owner_person_id: string;
  member_count: number;
  first_msg_at: string | null;
  last_msg_at: string | null;
  msg_count: number;
  source_ref: string;
  created_at: string;
  updated_at: string;
}

/** 落档 UPSERT 载荷（DESIGN-11 §4.4 ① 只更新 title / member_count / first / last）。 */
export interface ConversationUpsert {
  conversation_id: string;
  platform: ChatPlatform;
  kind: ConversationKind;
  title: string;
  /** 缺省 `'me'`（单用户恒为本人，DESIGN-10 §2.4）。 */
  owner_person_id?: string;
  member_count?: number;
  first_msg_at?: string | null;
  last_msg_at?: string | null;
  source_ref?: string;
}

// ── chat_messages（DESIGN-10 §2.4，append-only）─────────────────────────────

export interface ChatMessageRow {
  message_id: string;
  conversation_id: string;
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
  batch_id: string;
  ingested_at: string;
}

/** `insertOrIgnore` 入参（`ingested_at` 随行传入——该签名无 `now` 参数，DESIGN-13 §3.6）。 */
export interface ChatMessageInsert {
  message_id: string;
  conversation_id: string;
  platform: ChatPlatform;
  sender_id: string;
  sender_name?: string;
  role: MessageRole;
  ts_ms: number;
  msg_date: string;
  content?: string;
  content_type?: ContentType;
  reply_to?: string | null;
  meta?: string;
  batch_id: string;
  ingested_at: string;
}

/** `v_chat_messages` 投影（DESIGN-12 §3.1 的 SELECT 列表，mining 的唯一读取形态）。 */
export interface MiningMessageRow {
  message_id: string;
  conversation_id: string;
  platform: ChatPlatform;
  role: MessageRole;
  sender_id: string;
  sender_person_id: string | null;
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: ContentType;
  reply_to: string | null;
  meta: string;
}

/** 回溯行（DESIGN-13 §8.2 逐字；与 `contracts/src/person-detail.ts` 的 `TraceRowSchema` 同形）。 */
export interface TraceRow {
  message_id: string;
  conversation_id: string;
  ts_ms: number;
  msg_date: string;
  sender_name: string;
  content_type: ContentType;
  content_excerpt: string;
}

// ── chat_message_mentions（DESIGN-10 §2.4）────────────────────────────────

export interface MentionRow {
  message_id: string;
  person_id: string;
  mention_kind: MentionKind;
  created_at: string;
}

export interface MentionInsert {
  message_id: string;
  person_id: string;
  mention_kind?: MentionKind;
  created_at: string;
}

// ── chat_members（DESIGN-10 §2.2）──────────────────────────────────────────

export interface ChatMemberRow {
  conversation_id: string;
  person_id: string;
  group_alias: string;
  role_in_group: RoleInGroup;
  joined_at: string | null;
  left_at: string | null;
  is_active: boolean;
  first_msg_at: string | null;
  last_msg_at: string | null;
  msg_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatMemberUpsert {
  conversation_id: string;
  person_id: string;
  group_alias?: string;
  role_in_group?: RoleInGroup;
  joined_at?: string | null;
  left_at?: string | null;
  is_active?: boolean;
  first_msg_at?: string | null;
  last_msg_at?: string | null;
}
