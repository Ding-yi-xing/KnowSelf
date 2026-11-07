/**
 * 派生层行类型（DESIGN-13 §2.2 的类型部分，按「表族」拆分；采集层见 `types-chat.ts` / `types-ingest.ts`）。
 * 来源：`persons.sqlite` DDL 投影（`ddl/relation.ts` / `ddl/derived.ts` / `ddl/mining.ts`），
 * 列名与 CHECK 取值逐字对应，不得自创。
 * 约定同 `types.ts` 头注：DB 的 `0/1` 在 repository 层转 `boolean`；JSON TEXT 列保持字符串原样。
 * `ScopeKind` 复用 `@knowself/contracts`（单一真相源）；`RelationType` / `EventScopeKind`
 * 本地定义（contracts 只导出 schema 未导出推断类型），取值与 DDL CHECK 逐字一致。
 */
import type { ScopeKind } from "@knowself/contracts";

/** SQLite 读出的 0/1 → boolean（`types.ts` 头注约定：DB 层 0/1、repository 层 boolean）。 */
export function dbBool(value: number): boolean {
  return value === 1;
}

// ── 字面量联合（DDL CHECK 取值）─────────────────────────────────────────────

export type DirectionKind = "bidirectional" | "outgoing" | "incoming";
export type RelationshipSource = "auto" | "manual" | "import";
export type EventScopeKind = "me" | "direct" | "group";
export type EventSourceKind = "message" | "proposal" | "manual";
export type RelationType =
  | "family"
  | "friend"
  | "colleague"
  | "classmate"
  | "client"
  | "vendor"
  | "group_member"
  | "acquaintance"
  | "unknown";
export type FactKind =
  | "topic"
  | "preference"
  | "sentiment"
  | "relation_note"
  | "milestone"
  | "risk"
  | "other";
export type Period = "all" | "day" | "week" | "month" | "year";
export type IntentKind =
  | "consult"
  | "after_sales"
  | "business"
  | "work"
  | "social"
  | "family"
  | "finance"
  | "notice"
  | "other";
export type GraphKind = "cooccurrence" | "value_rank";

// ── relationships（DESIGN-10 §2.2 + DESIGN-12 §9.1 #6 加列）─────────────────

export interface RelationshipRow {
  relation_id: string;
  subject_id: string;
  counterpart_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  relation_type: RelationType;
  direction: DirectionKind;
  closeness: number;
  sentiment: number;
  tags: string;
  note: string;
  evidence_ref: string;
  source: RelationshipSource;
  manual_locked: boolean;
  produced_by: string;
  created_at: string;
  updated_at: string;
}

/** auto 写载荷（DESIGN-13 §3.3 `upsertAuto` / `replaceScope`）；`source='auto'` 由仓库固定。 */
export interface RelationshipAutoRow {
  subject_id?: string;
  counterpart_id: string;
  scope_kind: ScopeKind;
  scope_id?: string;
  relation_type?: RelationType;
  direction?: DirectionKind;
  closeness?: number;
  sentiment?: number;
  tags?: string;
  note?: string;
  evidence_ref?: string;
}

/** 人工编辑载荷（§3.3 `updateManual`；写后 `manual_locked=1`）。 */
export interface RelationshipPatch {
  relation_type?: RelationType;
  direction?: DirectionKind;
  closeness?: number;
  sentiment?: number;
  tags?: string;
  note?: string;
}

// ── events / person_facts（DESIGN-10 §2.3 + DESIGN-13 §14-C2 / DESIGN-14 §2.6 #1 加列）──

export interface EventRow {
  event_id: string;
  subject_id: string;
  person_id: string | null;
  conversation_id: string | null;
  scope_kind: EventScopeKind;
  event_kind: string;
  title: string;
  summary: string;
  event_date: string;
  occurred_at: string | null;
  importance: number;
  tags: string;
  source_kind: EventSourceKind;
  source_ref: string;
  confidence: number;
  manual_locked: boolean;
  produced_by: string;
  created_at: string;
  updated_at: string;
}

/** 人工录入载荷（§3.4 `insertManual`；`source_kind='manual'`、`manual_locked=1` 由仓库固定）。 */
export interface EventInsert {
  subject_id?: string;
  person_id?: string | null;
  conversation_id?: string | null;
  scope_kind?: EventScopeKind;
  event_kind?: string;
  title: string;
  summary?: string;
  event_date: string;
  occurred_at?: string | null;
  importance?: number;
  tags?: string;
  source_ref?: string;
  confidence?: number;
}

/** auto 写载荷（§3.4 `upsertAuto`）：可带 `event_id` 幂等；`source_kind='auto'` 由仓库固定。 */
export interface EventAutoRow {
  event_id?: string;
  subject_id?: string;
  person_id?: string | null;
  conversation_id?: string | null;
  scope_kind?: EventScopeKind;
  event_kind?: string;
  title: string;
  summary?: string;
  event_date: string;
  occurred_at?: string | null;
  importance?: number;
  tags?: string;
  source_ref?: string;
  confidence?: number;
}

/** 人工编辑载荷（§3.4 `updateManual`；写后 `manual_locked=1`）。 */
export interface EventPatch {
  event_kind?: string;
  title?: string;
  summary?: string;
  event_date?: string;
  occurred_at?: string | null;
  importance?: number;
  tags?: string;
}

export interface FactRow {
  fact_id: string;
  person_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  fact_kind: FactKind;
  fact_key: string;
  fact_value: string;
  confidence: number;
  source_ref: string;
  produced_by: string;
  manual_locked: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * 事实 upsert 载荷（§3.4 `upsertFacts`）：以 `fact_id` 为幂等键
 * （调用方用稳定哈希生成，如 `sha1(person_id + '|' + fact_kind + '|' + fact_key)`）。
 * `produced_by` 在行内（接口签名无独立参数）。
 */
export interface FactUpsert {
  fact_id: string;
  person_id: string;
  scope_kind?: ScopeKind;
  scope_id?: string;
  fact_kind: FactKind;
  fact_key?: string;
  fact_value: string;
  confidence?: number;
  source_ref?: string;
  produced_by?: string;
}

// ── person_metrics（DESIGN-10 §2.3 + DESIGN-12 §9.1 #3~#5 加列）──────────────

export interface MetricRow {
  metric_id: string;
  person_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  period: Period;
  period_key: string;
  metric_key: string;
  metric_value: number | null;
  metric_value_json: string | null;
  metric_unit: string;
  computed_at: string;
  produced_by: string;
  source_ref: string;
  evidence_count: number;
  manual_locked: boolean;
}

/** 指标 upsert 载荷（§3.8 `upsert`）：`metric_id` 缺省由仓库生成；`computed_at` / `produced_by` 在行内。 */
export interface MetricUpsert {
  metric_id?: string;
  person_id: string;
  scope_kind: ScopeKind;
  scope_id?: string;
  period?: Period;
  period_key?: string;
  metric_key: string;
  metric_value?: number | null;
  metric_value_json?: string | null;
  metric_unit?: string;
  computed_at?: string;
  produced_by?: string;
  source_ref?: string;
  evidence_count?: number;
}

// ── chat_message_intents / mining_graph_snapshots（DESIGN-12 §5.3 / §4.6）────

export interface IntentRow {
  message_id: string;
  intent: IntentKind;
  confidence: number;
  ambiguous: boolean;
  matched_rules: string;
  produced_by: string;
  computed_at: string;
}

/** 意图 upsert 载荷（§3.8 `upsertIntents`）：`message_id` 即幂等键（D4 1:1 回溯）。 */
export interface IntentUpsert {
  message_id: string;
  intent: IntentKind;
  confidence?: number;
  ambiguous?: boolean;
  matched_rules?: string;
  produced_by?: string;
  computed_at?: string;
}

export interface GraphSnapshotRow {
  snapshot_id: string;
  graph_kind: GraphKind;
  scope_kind: ScopeKind;
  scope_id: string;
  time_from: string | null;
  time_to: string | null;
  params_json: string;
  payload_json: string;
  node_count: number;
  edge_count: number;
  community_count: number;
  produced_by: string;
  computed_at: string;
}

/** 快照插入载荷（§3.8 `insertGraphSnapshot`）：`snapshot_id` 缺省由仓库生成。 */
export interface GraphSnapshotInsert {
  snapshot_id?: string;
  graph_kind: GraphKind;
  scope_kind?: ScopeKind;
  scope_id?: string;
  time_from?: string | null;
  time_to?: string | null;
  params_json?: string;
  payload_json: string;
  node_count?: number;
  edge_count?: number;
  community_count?: number;
  produced_by?: string;
  computed_at?: string;
}
