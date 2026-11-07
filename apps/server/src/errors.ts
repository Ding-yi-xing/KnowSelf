/**
 * chat-engine errors — 把各 package 的 ErrorCode 映射为 HTTP 状态码。
 *
 * 每个映射返回 HTTP status code 作为主能力；toHttpStatus 做运行时 discriminator。
 * 错误码来源：
 *   - ProfileErrorCode / RetrievalErrorCode / ProviderErrorCode /
 *     McpErrorCode / SettingsErrorCode / SourceErrorCode
 * 映射表见 docs/units/chat-engine/api-routes.md。
 */

import type {
  ProfileErrorCode,
  RetrievalErrorCode,
  ProviderErrorCode,
  McpErrorCode,
  SettingsErrorCode,
  SourceErrorCode,
} from "@knowself/contracts";

/** 转成 SSE ChatEvent error code 的事件级映射（用于 ChatEvent） */
type ChatEventErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "LOCK_BUSY"
  | "VALIDATION"
  | "INTERNAL"
  | "NOT_READY"
  | "PROVIDER_FAIL"
  | "TOOL_FAIL"
  | "ABORTED";

const CHAT_EVENT_MAP: Record<string, ChatEventErrorCode> = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  LOCK_BUSY: "LOCK_BUSY",
  VALIDATION: "VALIDATION",
  INTERNAL: "INTERNAL",
  NOT_READY: "NOT_READY",
  PROVIDER_FAIL: "PROVIDER_FAIL",
  TOOL_FAIL: "TOOL_FAIL",
  ABORTED: "ABORTED",
};

export function toEventErrorCode(code: string): ChatEventErrorCode {
  return CHAT_EVENT_MAP[code] ?? "INTERNAL";
}

// ─── ProfileErrorCode ────────────────────────────────────────────────

const PROFILE_STATUS: Record<ProfileErrorCode, number> = {
  PROFILE_NOT_FOUND: 404,
  DB_BUSY: 503,
  DB_CORRUPT: 500,
  CONSTRAINT_VIOLATION: 422,
  INVALID_TARGET_REF: 400,
  AUTOWRITE_REJECTED: 403,
};

// ─── RetrievalErrorCode ──────────────────────────────────────────────

const RETRIEVAL_STATUS: Record<RetrievalErrorCode, number> = {
  EMBED_MODEL_LOAD_FAILED: 500,
  DB_CORRUPT: 500,
  INDEX_BUSY: 503,
  BUDGET_OVERFLOW: 422,
  ABORTED: 499,
};

// ─── ProviderErrorCode ───────────────────────────────────────────────

const PROVIDER_STATUS: Record<ProviderErrorCode, number> = {
  PROVIDER_NOT_FOUND: 400,
  PROVIDER_DEAD: 503,
  AUTH_FAILED: 401,
  RATE_LIMITED: 502,
  UPSTREAM_5XX: 502,
  STREAM_BROKEN: 502,
  TOOL_LOOP_OVERFLOW: 502,
  ABORTED: 499,
};

// ─── McpErrorCode ────────────────────────────────────────────────────

const MCP_STATUS: Record<McpErrorCode, number> = {
  SERVER_NOT_FOUND: 404,
  SERVER_DISABLED: 404,
  SPAWN_FAILED: 500,
  STARTUP_TIMEOUT: 503,
  RPC_TIMEOUT: 504,
  RPC_ERROR: 502,
  DEAD_COOLDOWN: 503,
  INVALID_TRANSPORT: 400,
};

// ─── SettingsErrorCode ───────────────────────────────────────────────

const SETTINGS_STATUS: Record<SettingsErrorCode, number> = {
  PARSE_FAILED: 422,
  VALIDATION: 422,
  WRITE_FAILED: 500,
  REFERENCE_INVALID: 400,
  VERSION_MISMATCH: 409,
};

// ─── SourceErrorCode ─────────────────────────────────────────────────

const SOURCE_STATUS: Record<SourceErrorCode, number> = {
  SOURCE_NOT_FOUND: 404,
  PROPOSAL_NOT_FOUND: 404,
  UNSUPPORTED_MIME: 415,
  EXTRACTOR_FAILED: 422,
  URL_FETCH_FAILED: 502,
  FILE_TOO_LARGE: 413,
  PROPOSAL_NOT_PENDING: 409,
  DISTILL_FAILED: 502,
  INVALID_TARGET_REF: 400,
};

// ─── Generic / Chat / Tool (not from typed package enums) ────────────

const GENERIC_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  LOCK_BUSY: 409,
  INTERNAL: 500,
  NOT_READY: 503,
  PROVIDER_FAIL: 502,
  TOOL_FAIL: 502,
  TOOL_NOT_FOUND: 404,
  INPUT_VALIDATION: 422,
  TIMEOUT: 504,
  SOURCE_DEAD: 503,
  UPSTREAM_ERROR: 502,
  DANGEROUS_REJECTED: 403,
};

// ─── Combined lookup ─────────────────────────────────────────────────

const STATUS_MAP = new Map<string, number>([
  ...Object.entries(GENERIC_STATUS),
  ...Object.entries(PROFILE_STATUS),
  ...Object.entries(RETRIEVAL_STATUS),
  ...Object.entries(PROVIDER_STATUS),
  ...Object.entries(MCP_STATUS),
  ...Object.entries(SETTINGS_STATUS),
  ...Object.entries(SOURCE_STATUS),
] as [string, number][]);

/** 各 ErrorCode → HTTP 状态码。未知 code 返回 500。 */
export function toHttpStatus(code: string): number {
  return STATUS_MAP.get(code) ?? 500;
}
