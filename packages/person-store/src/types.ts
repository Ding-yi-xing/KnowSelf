/**
 * 行类型与字面量联合（DESIGN-13 §2.2 / §3；`PersonLite` 见 §14-C9）。
 * 来源：`persons.sqlite` DDL 投影——列名与 CHECK 取值逐字对应（DESIGN-10 §2.1~§2.3），不得自创。
 * 约定（contracts/src/person.ts 注 1）：DB 的 `0/1` 在 repository 层转 `boolean`
 * （`manual_locked` / `is_primary`）；JSON TEXT 列保持字符串原样，由调用方解析。
 */

// ── 字面量联合（DDL CHECK 取值）─────────────────────────────────────────────

export type SubjectKind = "self" | "contact";
export type PersonStatus = "active" | "archived" | "merged";
export type AliasPlatform = "wechat" | "qq" | "telegram" | "discord" | "other";
export type AliasKind =
  | "platform_uid"
  | "nickname"
  | "remark"
  | "group_card"
  | "phone"
  | "email"
  | "other";
export type AliasSource = "extractor" | "auto_merge" | "manual";
export type MergePerformedBy = "auto" | "manual";

// ── persons（DESIGN-10 §2.1）───────────────────────────────────────────────

export interface PersonRow {
  person_id: string;
  subject_kind: SubjectKind;
  display_name: string;
  remark: string;
  sort_key: string;
  avatar_ref: string | null;
  status: PersonStatus;
  merged_into: string | null;
  first_msg_at: string | null;
  last_msg_at: string | null;
  msg_count: number;
  conv_count: number;
  /**
   * 仅「我与该联系人的直聊」的统计（群消息不计入）。
   * `persons.list({ direct_only: true })` 与 `persons.get` 会填充；其它写路径可缺省。
   */
  direct_msg_count?: number;
  direct_conv_count?: number;
  direct_first_msg_at?: string | null;
  direct_last_msg_at?: string | null;
  /** JSON TEXT（话题分布 / 活跃时段 / 情感趋势），解析见 `json.ts`。 */
  profile_json: string;
  manual_locked: boolean;
  created_at: string;
  updated_at: string;
}

/** 列表投影（DESIGN-13 §14-C9；`persons.list` 返回 `PersonRow`，本类型供轻量消费方）。 */
export type PersonLite = Pick<
  PersonRow,
  | "person_id"
  | "subject_kind"
  | "display_name"
  | "status"
  | "msg_count"
  | "conv_count"
  | "first_msg_at"
  | "last_msg_at"
>;

export interface PersonInsert {
  person_id: string;
  subject_kind: SubjectKind;
  display_name: string;
  remark?: string;
  sort_key?: string;
  avatar_ref?: string | null;
  status?: PersonStatus;
  merged_into?: string | null;
  first_msg_at?: string | null;
  last_msg_at?: string | null;
  msg_count?: number;
  conv_count?: number;
  profile_json?: string;
  manual_locked?: boolean;
}

/** 人工编辑载荷（DESIGN-13 §3.1 `updateManual`；写后 `manual_locked=1`）。 */
export interface PersonPatch {
  display_name?: string;
  remark?: string;
  sort_key?: string;
  avatar_ref?: string | null;
  status?: PersonStatus;
  merged_into?: string | null;
  profile_json?: string;
}

/** 自动写只允许碰派生统计列（DESIGN-13 §6.3 避让矩阵）。 */
export interface PersonStatsPatch {
  msg_count?: number;
  conv_count?: number;
  first_msg_at?: string | null;
  last_msg_at?: string | null;
}

export interface PersonListQuery {
  subject_kind?: SubjectKind;
  status?: PersonStatus;
  keyword?: string;
  /** 只看有直聊消息的人（群消息不计入），并按直聊最近时间倒序。 */
  direct_only?: boolean;
  limit?: number;
  offset?: number;
}

/** 自动写结果：遇 `manual_locked=1` **跳过并回报**，不抛错（DESIGN-13 §6.2 规则 2）。 */
export interface AutoWriteResult {
  updated: boolean;
  skipped_locked: boolean;
}

// ── person_merges（DESIGN-10 §2.1）────────────────────────────────────────

export interface PersonMergeRow {
  merge_id: string;
  from_person_id: string;
  into_person_id: string;
  reason: string;
  /** JSON TEXT：`{ alias_ids, moved, overwritten, message_ids }`（DESIGN-13 §5.4 步 8）。 */
  evidence: string;
  performed_by: MergePerformedBy;
  confidence: number;
  merged_at: string;
  undone_at: string | null;
}

export interface PersonMergeInsert {
  merge_id: string;
  from_person_id: string;
  into_person_id: string;
  performed_by: MergePerformedBy;
  /** 归并发生时间（ISO8601）；签名无 `now` 参数，故随行传入。 */
  merged_at: string;
  reason?: string;
  evidence?: string;
  confidence?: number;
  undone_at?: string | null;
}

export interface MergeListQuery {
  from_person_id?: string;
  into_person_id?: string;
  undone?: boolean;
  limit?: number;
}

// ── aliases（DESIGN-10 §2.1；**无** `manual_locked` 列）───────────────────

export interface AliasRow {
  alias_id: string;
  person_id: string;
  platform: AliasPlatform;
  alias_kind: AliasKind;
  alias: string;
  normalized: string;
  is_primary: boolean;
  confidence: number;
  source: AliasSource;
  created_at: string;
  updated_at: string;
}

export interface AliasInsert {
  alias_id: string;
  person_id: string;
  platform: AliasPlatform;
  alias_kind: AliasKind;
  alias: string;
  normalized: string;
  source: AliasSource;
  is_primary?: boolean;
  confidence?: number;
}

export interface AliasListQuery {
  platform?: string;
  limit?: number;
  offset?: number;
}

/** 归并候选查询（DESIGN-13 §3.2 / §5.2）。 */
export interface AliasCandidateQuery {
  normalized: string;
  platform: string;
  kinds?: readonly AliasKind[];
  excludePersonId?: string;
  limit?: number;
}

/** `upsertExtractor` 入参（DESIGN-13 §3.2）。 */
export interface AliasExtractorInput {
  person_id: string;
  platform: AliasPlatform;
  alias: string;
  normalized: string;
  alias_kind: AliasKind;
  confidence: number;
  now: string;
}

// `ensurePersonForUid` 的入参 / 返回类型定义在 `identity.ts`（该能力的归属文件，DESIGN-13 §4.1）
