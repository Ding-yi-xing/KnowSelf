/**
 * 传输层类型 —— 只描述 knowSelf 后端契约的最小子集。
 * 不引用旧前端 transport，也不引入 dsh 的 session/host 类型。
 */

export interface ProposalTarget {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface Proposal {
  readonly id: string;
  readonly source_id: string;
  readonly status: "pending" | "accepted" | "rejected" | "edited";
  readonly proposed_body: string;
  readonly reasoning: string | null;
  readonly source_excerpts: readonly string[];
  readonly produced_by_provider: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly user_edited_body: string | null;
  readonly target: ProposalTarget | null;
}

export type DecideBody =
  | { readonly decision: "accept" }
  | { readonly decision: "reject" }
  | { readonly decision: "edit"; readonly body: string };

export interface DecideResult {
  readonly id: string;
  readonly status: Proposal["status"];
}

/** 系统状态轮询（迁移前 App 每 5s 调一次 /api/system/status）。 */
export interface SystemStatus {
  readonly ok?: boolean;
  readonly ready: Readonly<Record<string, boolean>>;
  readonly uptime_seconds: number;
  readonly app_version: string;
  readonly collected_at: string;
  readonly providers?: readonly unknown[];
  readonly mcp?: Readonly<Record<string, unknown>>;
  readonly retriever?: Readonly<Record<string, unknown>>;
  readonly ingestion?: Readonly<Record<string, unknown>>;
  readonly environment?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

// ── 画像 / 卡片 / 日志 / 模板（与 @knowself/contracts 的 zod schema 对齐的最小子集）──

export interface CardSummary {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly section_tags: readonly string[];
  readonly updated_at: string;
}

export interface CardSection {
  readonly id?: number;
  readonly section?: string;
  readonly title?: string;
  readonly body: string;
  readonly [key: string]: unknown;
}

export interface CardWithSections {
  readonly card: CardSummary;
  readonly sections: readonly CardSection[];
}

export interface JournalDateSummary {
  readonly date: string;
  readonly record_count: number;
  readonly updated_at: string;
}

export interface JournalRecord {
  readonly id: number;
  readonly ordinal: number;
  readonly body: string;
  readonly tags: readonly string[];
  readonly recorded_at: string;
  readonly [key: string]: unknown;
}

export interface JournalEntryStored {
  readonly date: string;
  readonly records: readonly JournalRecord[];
}

export interface TemplateVariable {
  readonly key: string;
  readonly label: string;
  readonly type: "text" | "textarea" | "select";
  readonly required: boolean;
  readonly options?: readonly string[];
}

export interface TemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly system_prompt_inject: string;
  readonly variables: readonly TemplateVariable[];
  readonly created_at: string;
}
