/**
 * B 层入口：原始行 → 归一化会话（DESIGN-11 §3.4 算法 / §4.1 字段映射）。
 * 纯函数：同一 `RawConversation` + 同一 descriptor → 逐字节相同输出（§4.2 不变量 1）。
 * 不丢行：未解析的行进 `issues`（不变量 2）。不猜：不确定填默认值 + issue（不变量 3）。
 * 行状态机在 `lines.ts`、时间解析在 `time.ts`（均为「单文件 ≤200 行」的拆分）。
 */
import type { ChatPlatform, ContentType, ConversationKind, MessageRole } from "@knowself/person-store";
import type { CompiledDescriptor } from "./descriptor";
import { buildPatterns, consumeLine, finalize, type State } from "./lines";
import type { RawConversation } from "./reader";

export type IssueCode =
  | "LINE_UNPARSED"
  | "TIMESTAMP_UNKNOWN"
  | "SENDER_UNKNOWN"
  | "CONTENT_UNDECODABLE"
  /** JSON / descriptor 形态下 `content_type` 取值非法（DESIGN-11 §4.1）。 */
  | "CONTENT_TYPE_UNKNOWN";

/** 归一化消息（= `StagingInsert` 的载荷部分，DESIGN-11 §4.1 逐列对应）。 */
export interface NormalizedMessage {
  message_id: string;
  sender_id: string;
  sender_name: string;
  role: MessageRole;
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: ContentType;
  reply_to: string | null;
  meta: string;
}

export interface IngestIssue {
  line_no: number;
  code: IssueCode;
  /** 原文片段（≤200 字符，DESIGN-11 §4.2 不变量 2）。 */
  excerpt: string;
}

export interface NormalizedConversation {
  /** 优先取头部「会话对象」（wxid / 群 ID，跨导出稳定）；取不到才退回文件名 stem。 */
  conversation_key: string;
  platform: ChatPlatform;
  kind: ConversationKind;
  title: string;
  first_ts_ms: number | null;
  last_ts_ms: number | null;
  messages: readonly NormalizedMessage[];
  issues: readonly IngestIssue[];
}

function minMax(values: readonly number[]): { min: number | null; max: number | null } {
  const first = values[0];
  if (first === undefined) return { min: null, max: null };
  let min = first;
  let max = first;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** 会话稳定键：头部「会话对象」优先（DESIGN-11 §5.4 的稳定性要求）。 */
function resolveKey(raw: RawConversation): string {
  const fromHeader = (raw.header["conversation_key"] ?? "").trim();
  return fromHeader === "" ? raw.ref.conversation_key : fromHeader;
}

/** 归一化一个会话；无 I/O、无副作用。 */
export function normalizeConversation(
  raw: RawConversation,
  compiled: CompiledDescriptor,
): NormalizedConversation {
  const spec = compiled.spec;
  const patterns = buildPatterns(spec);
  const state: State = {
    conversationKey: resolveKey(raw),
    date: null,
    pending: null,
    messages: [],
    issues: [],
    seen: new Map(),
  };
  raw.lines.forEach((line, index) => consumeLine(line, index + 1, state, compiled, patterns));
  finalize(state, compiled);
  const span = minMax(state.messages.map((message) => message.ts_ms));
  /**
   * 会话标题兜底（与 `resolveKey` 同风格，保持两者对称）。
   *
   * 为什么必须有：`title` 原来写的是 `header["title"] ?? ""` —— 导出里缺
   * `# 显示名 : …` 那一行时直接给空串，于是群节点 label 变成 ""，
   * 撞上 `GraphSnapshotSchema` 的 `min(1)` 会让**整个挖掘**失败
   * （真机 `too_small path:["nodes",4,"label"]`）。`conversation_key` 一直有兜底、
   * `title` 没有，这个不对称本身就是缺陷。
   *
   * 兜底值取 `conversation_key`（而不是再造一个"未命名群"）：它至少**可辨识**、
   * 且跨导出稳定；至于"看起来不像名字"的观感问题，另立小项（见 ISS 待办）。
   */
  const headerTitle = (raw.header["title"] ?? "").trim();
  return {
    conversation_key: state.conversationKey,
    platform: spec.platform,
    kind: spec.conversation_kind[raw.header["kind"] ?? ""] ?? "direct",
    title: headerTitle === "" ? state.conversationKey : headerTitle,
    first_ts_ms: span.min,
    last_ts_ms: span.max,
    messages: state.messages,
    issues: state.issues,
  };
}
