/**
 * Tier 判定（DESIGN-11 §6.2）：11 个确定性 `reason_code` + 4 条 Tier A 硬门槛。
 *
 * 纪律：
 *   1. **纯规则**：无 I/O、无 LLM、不读文件——`auto_ok.txt` / `review.txt` 由调用方读入后以数组传入；
 *   2. 判定的是**解析保真度**（这行有没有被正确解析），不是内容质量（§6.1）；
 *   3. 每个 `reason_code` 都是一条可执行判据（见 `TIER_RULES`，顺序与 §6.2 表格逐字一致）；
 *   4. 规则版本 `TIER_RULE_VERSION` 写入 proposal 的 `reasoning`，便于规则升级后回溯与重判。
 *
 * 与 `person-store` 无依赖：入参用结构化子集，`ChatPlatform` 等类型不从该包 import。
 */

/** 规则版本（§6.2 末段）；升级判定逻辑时必须同步 +1 版本号。 */
export const TIER_RULE_VERSION = "chat-tier-v2";

/** `ts_ms` 下界：2011-01-01（§6.2 规则 2）。 */
const MIN_TS_MS = 1_293_840_000_000;

/** 允许的未来偏移：一天，容忍机器时钟漂移（§6.2 规则 2）。 */
const MAX_FUTURE_MS = 86_400_000;

/** 解码后 U+FFFD 占比上限 0.5%（§6.2 规则 1）。 */
const MAX_ENCODING_LOSS = 0.005;

/** 解析失败行占比上限 1%（§6.2 规则 10）。 */
const MAX_PARSE_FAILURE_RATIO = 0.01;

/** Tier A 允许的 `content_type`（§6.2 硬门槛 2）：`other` 一律进队列。 */
export const AUTO_CONTENT_TYPES: readonly string[] = [
  "text",
  "image",
  "file",
  "link",
  "voice",
  "video",
  "system",
];

/** 11 个 `reason_code`（§6.2 表格逐字；顺序即表格顺序）。 */
export type TierReasonCode =
  | "ENCODING_LOSS"
  | "TS_INVALID"
  | "TS_REGRESSION"
  | "SENDER_UNRESOLVED"
  | "CONTENT_TYPE_UNKNOWN"
  | "ID_FALLBACK"
  | "ID_CONFLICT"
  | "NEW_CONVERSATION"
  | "GROUP_MEMBER_UNKNOWN"
  | "BATCH_QUALITY"
  | "MANUAL_FLAG";

/** 稳定顺序表（产出 `reason_codes` 时按此排序，保证可复现）。 */
export const TIER_REASON_CODES: readonly TierReasonCode[] = [
  "ENCODING_LOSS",
  "TS_INVALID",
  "TS_REGRESSION",
  "SENDER_UNRESOLVED",
  "CONTENT_TYPE_UNKNOWN",
  "ID_FALLBACK",
  "ID_CONFLICT",
  "NEW_CONVERSATION",
  "GROUP_MEMBER_UNKNOWN",
  "BATCH_QUALITY",
  "MANUAL_FLAG",
];

/** 分层标签：`auto` = 规则可自动落档；`review` = 进人工队列。 */
export type TierLabel = "auto" | "review";

export interface TierVerdict {
  tier: TierLabel;
  reason_codes: readonly TierReasonCode[];
}

/** 判定所需的消息字段子集（`NormalizedMessage` / `StagingRow` 均满足）。 */
export interface TierMessageLike {
  message_id: string;
  sender_id: string;
  role: "me" | "other" | "system";
  ts_ms: number;
  content: string;
  content_type: string;
}

export interface TierConversationLike {
  conversation_id: string;
  kind: "direct" | "group";
  /** `chat_conversations` 中是否已存在该会话（规则 8）。 */
  exists: boolean;
  /** 已知成员数；`<= 0` 表示工具未导出成员表（规则 9）。 */
  member_count: number;
  /**
   * 批 2 / 1B′：会话是否可信到「允许 sha1 派生 ID 走自动分层」。
   *
   * 由**装配层算一次**（`会话已存在 ∨ auto_ok 命中`，且不在强制复核集合中），
   * 同时喂给 `judge` / `judgeNow` 与 `enforceHardGates`，保证 staging 与 proposal
   * 看到的是同一个判定（否则审计分裂）。
   *
   * 缺省 `undefined` = 不可信（保守）：旧调用方不传时规则 6 行为不变。
   */
  trusted_ingest?: boolean;
}

export interface TierCursorLike {
  last_ts_ms: number;
  last_message_id: string | null;
}

/** 会话解析质量诊断（规则 1 / 规则 10 的输入）。 */
export interface TierDiagnostics {
  /** 解析单位总数（txt = 原始行数；json = 记录数）。 */
  total_lines: number;
  /** 解析失败单位数。 */
  parsed_failures: number;
  /** 解码后 U+FFFD 占比（0..1）。 */
  encoding_loss_ratio: number;
  /** 解码文本是否含 `\x00`。 */
  has_nul: boolean;
}

export interface TierExistingMessageLike {
  content: string;
  ts_ms: number;
}

/** `content_type` 标记表（来自 descriptor；用于规则 5 判断「未命中任何标记」）。 */
export interface TierContentTypeMarkers {
  exact: readonly string[];
  prefixes: readonly string[];
}

export interface TierJudgeInput {
  messages: readonly TierMessageLike[];
  conversation: TierConversationLike;
  cursor: TierCursorLike | null;
  /**
   * 已登记的 `platform_uid`（aliases ∪ 本会话成员表）。
   * `null` = 调用方无法判定（跳过规则 4，不误报）。
   */
  known_sender_ids: readonly string[] | null;
  encoding: { replacement_ratio: number; has_nul: boolean };
  batch: { parsed_failures: number; total_lines: number };
  /** 缺省 = 无 descriptor 信息，按「首字符 `[` / `<` 即未知」从严判定。 */
  content_type_markers?: TierContentTypeMarkers;
  /** `review.txt` 内容（`conversation_id` 或 `sender_id`，每行一条），由调用方读入。 */
  manual_flags: readonly string[];
  /**
   * 既有消息查询（规则 7 `ID_CONFLICT`）；返回 `null` = 该 `message_id` 尚未落档。
   * 用回调而非数组，避免 10 万条量级下把全表载入内存。
   */
  lookup_existing?: (messageId: string) => TierExistingMessageLike | null;
}

export interface TierGateInput {
  conversation_id: string;
  conversation_exists: boolean;
  /**
   * 批 2：与 `TierConversationLike.trusted_ingest` **同一个值**，由装配层算一次传入，
   * 避免 judge 与 gates 各自判定导致 audit 分裂。缺省时回退到旧逻辑（向后兼容）。
   */
  trusted_ingest?: boolean;
  /** `data/chat-ingest/auto_ok.txt` 内容（每行一个 `conversation_id`）。 */
  auto_ok_conversation_ids: readonly string[];
  /** 批次级：本批次**任一**会话触发了 `BATCH_QUALITY`。 */
  batch_quality_failed: boolean;
}

/** 规则判定入参（`now_ms` 由 `TierJudge` 构造时注入，规则 2 的上界）。 */
export interface TierRuleInput extends TierJudgeInput {
  now_ms: number;
}

/** 一条规则的声明（code + 可执行判据）。 */
export interface TierRule {
  readonly code: TierReasonCode;
  readonly description: string;
  hit(input: TierRuleInput): boolean;
}

function maxTsOf(messages: readonly TierMessageLike[]): number | null {
  const first = messages[0];
  if (first === undefined) return null;
  let max = first.ts_ms;
  for (const message of messages) {
    if (message.ts_ms > max) max = message.ts_ms;
  }
  return max;
}

/** 规则 1：解码后 U+FFFD 占比 > 0.5%，或出现 `\x00`。 */
function hitEncodingLoss(input: TierRuleInput): boolean {
  return input.encoding.replacement_ratio > MAX_ENCODING_LOSS || input.encoding.has_nul;
}

/** 规则 2：`ts_ms` 非整数 / 早于 2011-01-01 / 晚于 now + 1 天。 */
function hitTsInvalid(input: TierRuleInput): boolean {
  const upper = input.now_ms + MAX_FUTURE_MS;
  return input.messages.some(
    (message) =>
      !Number.isInteger(message.ts_ms) || message.ts_ms < MIN_TS_MS || message.ts_ms > upper,
  );
}

/** 规则 3：该会话本批 `max(ts_ms) < cursor.last_ts_ms`（时间回归）。 */
function hitTsRegression(input: TierRuleInput): boolean {
  const cursor = input.cursor;
  if (cursor === null) return false;
  const max = maxTsOf(input.messages);
  return max !== null && max < cursor.last_ts_ms;
}

/** 规则 4：`sender_id` 为空，或既不在 aliases 也不在本次会话成员表。 */
function hitSenderUnresolved(input: TierRuleInput): boolean {
  const known = input.known_sender_ids;
  if (known === null) return false;
  const knownSet = new Set(known);
  return input.messages.some((message) => {
    // `me` / `system` 不参与人际归因（DESIGN-11 §4.5），不据此判未解析。
    if (message.role === "me" || message.role === "system") return false;
    return message.sender_id.trim() === "" || !knownSet.has(message.sender_id);
  });
}

/** 规则 5：非空行未命中任何 `content_type_markers`，且首字符为 `[` 或 `<`。 */
function hitContentTypeUnknown(input: TierRuleInput): boolean {
  const markers = input.content_type_markers;
  return input.messages.some((message) => {
    if (message.content_type !== "text") return false;
    const content = message.content.trim();
    if (content === "") return false;
    const first = content.charAt(0);
    if (first !== "[" && first !== "<") return false;
    if (markers === undefined) return true;
    if (markers.exact.includes(content)) return false;
    return !markers.prefixes.some((prefix) => content.startsWith(prefix));
  });
}

/**
 * 规则 6：使用了 `sha1(...)` 兜底 ID（`<conversation_id>:sha1:<40hex>`）。
 *
 * 批 2 / 1B′ 有条件豁免：会话可信（已有历史、可被规则 7 `ID_CONFLICT` 与游标交叉校验，
 * 或运维显式预授权）**且** ID 结构合法时，派生 ID 不再触发 review。
 *
 * 三个条件各防一件事：
 *   - `startsWith(conversation_id + ":sha1:")` → ID 属于本会话、且走的是兜底方案；
 *   - `/^[0-9a-f]{40}$/` → 排除截断/拼接坏 ID；
 *   - `trusted_ingest` → 会话有历史可交叉校验（或显式预授权）。
 *
 * 「派生输入不可伪造」（`ts_ms + sender_name + content + ordinal`）不在本层验证：
 * `TierMessageLike` 拿不到 `sender_name` / `ordinal`，改由 reader 侧的**金色向量测试**
 * 钉死公式，防止 `lines.ts` 与 `json.ts` 两份拷贝漂移。
 */
function hitIdFallback(input: TierRuleInput): boolean {
  if (input.conversation.trusted_ingest !== true) {
    return input.messages.some((message) => message.message_id.includes(":sha1:"));
  }
  const prefix = `${input.conversation.conversation_id}:sha1:`;
  return input.messages.some((message) => {
    if (!message.message_id.includes(":sha1:")) return false;
    if (!message.message_id.startsWith(prefix)) return true;
    return !/^[0-9a-f]{40}$/.test(message.message_id.slice(prefix.length));
  });
}

/** 规则 7：同 `message_id` 已存在，但 `content` 或 `ts_ms` 不同。 */
function hitIdConflict(input: TierRuleInput): boolean {
  const lookup = input.lookup_existing;
  if (lookup === undefined) return false;
  return input.messages.some((message) => {
    const existing = lookup(message.message_id);
    if (existing === null) return false;
    return existing.content !== message.content || existing.ts_ms !== message.ts_ms;
  });
}

/** 规则 8：`chat_conversations` 中无该 `conversation_id`。 */
function hitNewConversation(input: TierRuleInput): boolean {
  return !input.conversation.exists;
}

/** 规则 9：群聊且成员表为空（工具未导出成员）。 */
function hitGroupMemberUnknown(input: TierRuleInput): boolean {
  return input.conversation.kind === "group" && input.conversation.member_count <= 0;
}

/** 规则 10：本批次该会话解析失败行数 / 总行数 > 1%。 */
function hitBatchQuality(input: TierRuleInput): boolean {
  const total = input.batch.total_lines;
  if (total <= 0) return false;
  return input.batch.parsed_failures / total > MAX_PARSE_FAILURE_RATIO;
}

/** 规则 11：`review.txt` 列出该 `conversation_id` 或该批消息的 `sender_id`。 */
function hitManualFlag(input: TierRuleInput): boolean {
  const flags = new Set(input.manual_flags.map((flag) => flag.trim()).filter((flag) => flag !== ""));
  if (flags.size === 0) return false;
  if (flags.has(input.conversation.conversation_id)) return true;
  return input.messages.some((message) => flags.has(message.sender_id));
}

/**
 * 11 条规则的声明式表（§6.2 表格逐行对应）。
 * 顺序即 `reason_codes` 的稳定输出顺序。
 */
export const TIER_RULES: readonly TierRule[] = [
  { code: "ENCODING_LOSS", description: "解码 U+FFFD 占比 > 0.5% 或含 \\x00", hit: hitEncodingLoss },
  { code: "TS_INVALID", description: "ts_ms 非整数 / 早于 2011-01-01 / 晚于 now+1d", hit: hitTsInvalid },
  { code: "TS_REGRESSION", description: "本批 max(ts_ms) < cursor.last_ts_ms", hit: hitTsRegression },
  { code: "SENDER_UNRESOLVED", description: "sender_id 为空或不在 aliases / 成员表", hit: hitSenderUnresolved },
  { code: "CONTENT_TYPE_UNKNOWN", description: "未命中标记且首字符为 [ 或 <", hit: hitContentTypeUnknown },
  { code: "ID_FALLBACK", description: "使用 sha1 兜底 message_id", hit: hitIdFallback },
  { code: "ID_CONFLICT", description: "同 message_id 的 content / ts_ms 与既有不同", hit: hitIdConflict },
  { code: "NEW_CONVERSATION", description: "chat_conversations 无该会话", hit: hitNewConversation },
  { code: "GROUP_MEMBER_UNKNOWN", description: "群聊且成员表为空", hit: hitGroupMemberUnknown },
  { code: "BATCH_QUALITY", description: "解析失败行数 / 总行数 > 1%", hit: hitBatchQuality },
  { code: "MANUAL_FLAG", description: "review.txt 列出该会话或发送者", hit: hitManualFlag },
];

/** 判定器：持有 `now_ms`（规则 2 的上界），其余全部由入参提供。 */
export class TierJudge {
  readonly now_ms: number;

  constructor(options: { now_ms?: number } = {}) {
    this.now_ms = options.now_ms ?? Date.now();
  }

  /** 逐条跑 11 个规则（不含 4 条硬门槛，硬门槛见 `enforceHardGates`）。 */
  judge(input: TierRuleInput): TierVerdict {
    const hits = new Set<TierReasonCode>();
    for (const rule of TIER_RULES) {
      if (rule.hit(input)) hits.add(rule.code);
    }
    return TierJudge.verdictOf(hits);
  }

  /** 便捷入口：用构造时的 `now_ms` 判定。 */
  judgeNow(input: TierJudgeInput): TierVerdict {
    return this.judge({ ...input, now_ms: this.now_ms });
  }

  /**
   * Tier A 四条硬门槛（§6.2 末段）。命中即降级为 `review` 并补齐对应 `reason_code`，
   * 保证不变量「`tier === 'auto'` ⇔ `reason_codes` 为空集」。
   *
   * 门槛 1（reason_codes 为空）由 `tier` 的计算方式本身保证。
   */
  static enforceHardGates(input: {
    verdict: TierVerdict;
    /** 本批消息的 `content_type` 集合（只需去重后的取值，不必传全部消息）。 */
    content_types: readonly string[];
    gates: TierGateInput;
  }): TierVerdict {
    const hits = new Set<TierReasonCode>(input.verdict.reason_codes);
    // 门槛 2：content_type 白名单（`other` 一律进队列）
    if (input.content_types.some((type) => !AUTO_CONTENT_TYPES.includes(type))) {
      hits.add("CONTENT_TYPE_UNKNOWN");
    }
    // 门槛 3：会话已存在或登记在 auto_ok 白名单
    //
    // 注意这里是「准入判定」而非「追加判定」：规则 8 已在 `judge()` 阶段无条件产出
    // `NEW_CONVERSATION`（只要 `!exists`），白名单必须能**撤销**该码，否则
    // auto_ok 对首次出现的会话永远失效（§6.2 硬门槛 3 的「或」语义）。
    // 只允许撤销 `NEW_CONVERSATION` 一个码：白名单是对「会话身份」的预授权，
    // 不得豁免其余 10 个码。
    const { gates } = input;
    const conversationTrusted =
      gates.trusted_ingest ??
      (gates.conversation_exists || gates.auto_ok_conversation_ids.includes(gates.conversation_id));
    if (conversationTrusted) {
      hits.delete("NEW_CONVERSATION");
    } else {
      hits.add("NEW_CONVERSATION");
    }
    // 门槛 4：批次级 —— 本批次所有会话的 BATCH_QUALITY 均未触发
    if (gates.batch_quality_failed) hits.add("BATCH_QUALITY");
    return TierJudge.verdictOf(hits);
  }

  private static verdictOf(hits: ReadonlySet<TierReasonCode>): TierVerdict {
    const reason_codes = TIER_REASON_CODES.filter((code) => hits.has(code));
    return { tier: reason_codes.length === 0 ? "auto" : "review", reason_codes };
  }
}

/** 纯函数形态的判定入口（等价于 `new TierJudge({ now_ms }).judgeNow(input)`，便于单测）。 */
export function judgeTier(input: TierJudgeInput & { now_ms: number }): TierVerdict {
  return new TierJudge({ now_ms: input.now_ms }).judge(input);
}
