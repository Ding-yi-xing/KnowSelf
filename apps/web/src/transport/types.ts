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
  readonly ok: boolean;
  readonly [key: string]: unknown;
}
