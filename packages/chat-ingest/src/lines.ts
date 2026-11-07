/**
 * 行状态机（DESIGN-11 §3.4 算法）：原始行 → 归一化消息。
 * 只被 `normalize.ts` 调用；本文件不导出公开 API（包内实现细节）。
 * 实测要点：消息行 `[<ts>] <who>: <body>`；续行缩进 4 空格；「我」= 字面量 `我`。
 */
import { createHash } from "node:crypto";
import { normalizeAlias, type ContentType, type MessageRole } from "@knowself/person-store";
import type { ChatFormatDescriptor, CompiledDescriptor } from "./descriptor";
import type { IngestIssue, NormalizedMessage } from "./normalize";
import { resolveTimestamp, timestampPattern, type TimestampPattern } from "./time";

const EXCERPT_CHARS = 200;

interface Pending {
  line_no: number;
  ts_ms: number;
  msg_date: string;
  sender_name: string;
  is_self: boolean;
  body: string[];
}

export interface State {
  conversationKey: string;
  date: string | null;
  pending: Pending | null;
  messages: NormalizedMessage[];
  issues: IngestIssue[];
  seen: Map<string, number>;
}

interface Patterns {
  long: TimestampPattern;
  short: TimestampPattern;
  self: RegExp | null;
}

function excerpt(line: string): string {
  return line.length <= EXCERPT_CHARS ? line : `${line.slice(0, EXCERPT_CHARS)}…`;
}

function buildPatterns(spec: ChatFormatDescriptor): Patterns {
  return {
    long: timestampPattern(spec.timestamp.long),
    short: timestampPattern(spec.timestamp.short),
    self: spec.self_marker.kind === "literal" ? null : new RegExp(spec.self_marker.value),
  };
}

function isSelf(name: string, spec: ChatFormatDescriptor, patterns: Patterns): boolean {
  return patterns.self === null ? name === spec.self_marker.value : patterns.self.test(name);
}

/** 正文**整体**等于标记 → 类型；否则按前缀；再否则 `text`（不猜）。 */
function classify(
  body: string,
  spec: ChatFormatDescriptor,
): { content: string; content_type: ContentType } {
  const exact = spec.content_type_exact[body];
  if (exact !== undefined) return { content: body, content_type: exact };
  for (const [prefix, type] of Object.entries(spec.content_type_prefix)) {
    if (body.startsWith(prefix)) return { content: body, content_type: type };
  }
  return { content: body, content_type: "text" };
}

function senderIdOf(role: MessageRole, name: string): string {
  if (role === "me") return "me";
  const normalized = normalizeAlias(name);
  return `name:${normalized === "" ? name : normalized}`;
}

function metaOf(role: MessageRole): string {
  return role === "me" ? "{}" : JSON.stringify({ extra: { sender_id_is_pseudo: true } });
}

function containsBinary(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xfffd || code === 0 || code < 9 || (code > 13 && code < 32)) return true;
  }
  return false;
}

/** 结算上一条：定 role / content_type / message_id，并登记保真度 issue。 */
export function finalize(state: State, compiled: CompiledDescriptor): void {
  const pending = state.pending;
  if (pending === null) return;
  state.pending = null;
  const spec = compiled.spec;
  const content = pending.body.join("\n");
  const classified = classify(content, spec);
  const role: MessageRole = pending.is_self
    ? "me"
    : classified.content_type === "system"
      ? "system"
      : "other";
  const ordinalKey = `${pending.ts_ms}|${pending.sender_name}|${content}`;
  const ordinal = state.seen.get(ordinalKey) ?? 0;
  state.seen.set(ordinalKey, ordinal + 1);
  const digest = createHash("sha1")
    .update(`${pending.ts_ms} ${pending.sender_name} ${content} ${ordinal}`)
    .digest("hex");
  state.messages.push({
    message_id: `${spec.platform}:${state.conversationKey}:sha1:${digest}`,
    sender_id: senderIdOf(role, pending.sender_name),
    sender_name: pending.sender_name,
    role,
    ts_ms: pending.ts_ms,
    msg_date: pending.msg_date,
    content,
    content_type: classified.content_type,
    reply_to: null,
    meta: metaOf(role),
  });
  if (pending.sender_name.startsWith(spec.unknown_sender.prefix)) {
    state.issues.push({
      line_no: pending.line_no,
      code: "SENDER_UNKNOWN",
      excerpt: excerpt(pending.sender_name),
    });
  }
  if (containsBinary(content)) {
    state.issues.push({
      line_no: pending.line_no,
      code: "CONTENT_UNDECODABLE",
      excerpt: excerpt(content),
    });
  }
}

function openMessage(
  state: State,
  token: string,
  rest: string,
  lineNo: number,
  compiled: CompiledDescriptor,
  patterns: Patterns,
): void {
  const spec = compiled.spec;
  const at = rest.indexOf(spec.sender_separator);
  if (at < 0) {
    state.issues.push({ line_no: lineNo, code: "LINE_UNPARSED", excerpt: excerpt(rest) });
    return;
  }
  const resolved = resolveTimestamp(token, state.date, {
    long: patterns.long,
    short: patterns.short,
    offsetMinutes: spec.timestamp.utc_offset_minutes,
  });
  if (resolved === null) {
    state.issues.push({ line_no: lineNo, code: "TIMESTAMP_UNKNOWN", excerpt: excerpt(token) });
    return;
  }
  if (state.date === null) state.date = resolved.msg_date;
  const sender_name = rest.slice(0, at);
  state.pending = {
    line_no: lineNo,
    ts_ms: resolved.ts_ms,
    msg_date: resolved.msg_date,
    sender_name,
    is_self: isSelf(sender_name, spec, patterns),
    body: [rest.slice(at + spec.sender_separator.length)],
  };
}

function isContinuation(line: string, spec: ChatFormatDescriptor): boolean {
  if (spec.continuation.kind === "none") return true;
  return line.startsWith(" ".repeat(spec.continuation.indent_chars));
}

/** 单行归位：头部 / 日期分隔 / 消息头 / 续行 / 未解析（进 issues，不静默丢）。 */
export function consumeLine(
  line: string,
  lineNo: number,
  state: State,
  compiled: CompiledDescriptor,
  patterns: Patterns,
): void {
  const spec = compiled.spec;
  if (line.trim() === "" || line.startsWith(spec.header.prefix)) return;
  const separator = compiled.dateSeparator.exec(line);
  if (separator !== null) {
    state.date = separator[1] ?? state.date;
    return;
  }
  const header = compiled.messageHeader.exec(line);
  if (header !== null) {
    finalize(state, compiled);
    openMessage(state, header[1] ?? "", header[2] ?? "", lineNo, compiled, patterns);
    return;
  }
  if (state.pending !== null && isContinuation(line, spec)) {
    state.pending.body.push(line.slice(spec.continuation.indent_chars));
    return;
  }
  state.issues.push({ line_no: lineNo, code: "LINE_UNPARSED", excerpt: excerpt(line) });
}

export { buildPatterns, type Patterns };
