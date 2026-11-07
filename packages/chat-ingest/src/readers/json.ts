/**
 * JSON reader（DESIGN-11 §3.5 变更矩阵「工具换成输出 JSON」的可执行形态）。
 *
 * 隔离原则：**字段映射全部在 descriptor（数据文件）里**，代码只按描述符取值。
 * 新增一种 JSON 导出格式 = 新增一个 `descriptors/*.json`，本文件不改；也不触碰
 * 「归一化之后」的任何阶段（增量 / Tier / proposal / 落档 / 索引）。
 *
 * 与 txt reader 的差异：JSON 自带结构化字段，无需行状态机，故本 reader 直接产出
 * `NormalizedConversation`（字段映射即 JSON 形态的 normalizer）。
 * 容错按 §8.1 归类：单条记录字段缺失 / 类型不符 → 落 issue（`LINE_UNPARSED` /
 * `TIMESTAMP_UNKNOWN` / `CONTENT_TYPE_UNKNOWN`），**不抛裸错**，不中断整批。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ChatIngestError, describeError } from "../errors";
import type { IngestIssue, NormalizedConversation, NormalizedMessage } from "../normalize";
import type { ProbeResult, RawConversationRef } from "../reader";
import type { TierContentTypeMarkers, TierDiagnostics } from "../tier";
import rawDescriptor from "../descriptors/generic-json.json";

/** 平台枚举（与 person-store 的 `ChatPlatform` 同构；本文件不 import person-store）。 */
export type JsonChatPlatform = "wechat" | "qq" | "telegram" | "discord" | "other";

/** 内容类型枚举（与 DESIGN-10 §5.1 的 8 值枚举同构）。 */
export type JsonContentType =
  | "text"
  | "image"
  | "file"
  | "link"
  | "voice"
  | "video"
  | "system"
  | "other";

export type JsonConversationKind = "direct" | "group";
export type JsonMessageRole = "me" | "other" | "system";

/** JSON 格式描述符（数据文件 = 格式知识的唯一载体）。 */
export interface JsonFormatDescriptor {
  descriptor_version: 1;
  reader_id: string;
  platform: JsonChatPlatform;
  timezone: string;
  /** 由 `ts_ms` 派生 `msg_date` 用的固定偏移（分钟）。 */
  utc_offset_minutes: number;
  file_suffix: string;
  conversation: {
    key_field: string;
    title_field: string;
    kind_field: string;
    messages_field: string;
  };
  conversation_kind: Record<string, JsonConversationKind>;
  message: {
    id_field: string;
    ts_field: string;
    ts_unit: "ms" | "s";
    sender_id_field: string;
    sender_name_field: string;
    role_field: string;
    content_field: string;
    content_type_field: string;
    reply_to_field: string;
  };
  self_marker: { kind: "literal" | "regex"; value: string };
  content_types: readonly JsonContentType[];
}

const PLATFORMS: readonly string[] = ["wechat", "qq", "telegram", "discord", "other"];
const CONTENT_TYPES: readonly string[] = [
  "text",
  "image",
  "file",
  "link",
  "voice",
  "video",
  "system",
  "other",
];
const ROLES: readonly string[] = ["me", "other", "system"];
const SAMPLE_LINES = 50;

type Json = Record<string, unknown>;

function fail(path: string, reason: string): never {
  throw new ChatIngestError("DESCRIPTOR_INVALID", `json descriptor 非法：${path} ${reason}`);
}

function asRecord(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "必须是对象");
  return value as Json;
}

function readString(source: Json, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") fail(`${path}.${key}`, "必须是非空字符串");
  return value;
}

function readInteger(source: Json, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path}.${key}`, "必须是整数");
  }
  return value;
}

function readStringArray(source: Json, key: string, path: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) fail(`${path}.${key}`, "必须是数组");
  return value.map((item, index) => {
    if (typeof item !== "string" || item === "") fail(`${path}.${key}[${index}]`, "必须是非空字符串");
    return item;
  });
}

/** 校验并读入 JSON 描述符；缺字段 / 非法值抛 `DESCRIPTOR_INVALID`。 */
export function loadJsonDescriptor(raw: unknown): JsonFormatDescriptor {
  const root = asRecord(raw, "$");
  if (root["descriptor_version"] !== 1) fail("$.descriptor_version", "只支持 1");
  const platform = readString(root, "platform", "$");
  if (!PLATFORMS.includes(platform)) fail("$.platform", `未知平台：${platform}`);
  const conversation = asRecord(root["conversation"], "$.conversation");
  const message = asRecord(root["message"], "$.message");
  const selfMarker = asRecord(root["self_marker"], "$.self_marker");
  const kindRaw = asRecord(root["conversation_kind"], "$.conversation_kind");
  const conversation_kind: Record<string, JsonConversationKind> = {};
  for (const [key, value] of Object.entries(kindRaw)) {
    if (value !== "direct" && value !== "group") {
      fail(`$.conversation_kind.${key}`, "只支持 direct / group");
    }
    conversation_kind[key] = value;
  }
  const content_types = readStringArray(root, "content_types", "$");
  for (const value of content_types) {
    if (!CONTENT_TYPES.includes(value)) fail("$.content_types", `未知内容类型：${value}`);
  }
  const unit = readString(message, "ts_unit", "$.message");
  if (unit !== "ms" && unit !== "s") fail("$.message.ts_unit", "只支持 ms / s");
  const markerKind = readString(selfMarker, "kind", "$.self_marker");
  if (markerKind !== "literal" && markerKind !== "regex") {
    fail("$.self_marker.kind", "只支持 literal / regex");
  }
  return {
    descriptor_version: 1,
    reader_id: readString(root, "reader_id", "$"),
    platform: platform as JsonChatPlatform,
    timezone: readString(root, "timezone", "$"),
    utc_offset_minutes: readInteger(root, "utc_offset_minutes", "$"),
    file_suffix: readString(root, "file_suffix", "$"),
    conversation: {
      key_field: readString(conversation, "key_field", "$.conversation"),
      title_field: readString(conversation, "title_field", "$.conversation"),
      kind_field: readString(conversation, "kind_field", "$.conversation"),
      messages_field: readString(conversation, "messages_field", "$.conversation"),
    },
    conversation_kind,
    message: {
      id_field: readString(message, "id_field", "$.message"),
      ts_field: readString(message, "ts_field", "$.message"),
      ts_unit: unit,
      sender_id_field: readString(message, "sender_id_field", "$.message"),
      sender_name_field: readString(message, "sender_name_field", "$.message"),
      role_field: readString(message, "role_field", "$.message"),
      content_field: readString(message, "content_field", "$.message"),
      content_type_field: readString(message, "content_type_field", "$.message"),
      reply_to_field: readString(message, "reply_to_field", "$.message"),
    },
    self_marker: {
      kind: markerKind,
      value: readString(selfMarker, "value", "$.self_marker"),
    },
    content_types: content_types as JsonContentType[],
  };
}

/** 通用 JSON 描述符（P0 的 JSON 形态；换工具 = 换这个文件）。 */
export const GENERIC_JSON_DESCRIPTOR: JsonFormatDescriptor = loadJsonDescriptor(rawDescriptor);

/** 单会话读取结果：会话 + Tier 判定所需的解析质量诊断。 */
export interface JsonConversationRead {
  conversation: NormalizedConversation;
  diagnostics: TierDiagnostics;
}

/** 从描述符取 `content_type` 标记表，供 Tier 规则 5 使用。 */
export function jsonContentTypeMarkers(
  descriptor: JsonFormatDescriptor,
): TierContentTypeMarkers {
  return { exact: [...descriptor.content_types], prefixes: [] };
}

function readField(record: Json, key: string): unknown {
  return record[key];
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function localNormalizeAlias(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** `msg_date` = `ts_ms` + 固定偏移 → `YYYY-MM-DD`（DESIGN-11 §4.1）。 */
export function msgDateOf(tsMs: number, offsetMinutes: number): string {
  return new Date(tsMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function isSelfName(name: string, descriptor: JsonFormatDescriptor): boolean {
  if (descriptor.self_marker.kind === "literal") return name === descriptor.self_marker.value;
  try {
    return new RegExp(descriptor.self_marker.value).test(name);
  } catch {
    return false;
  }
}

interface ParseContext {
  descriptor: JsonFormatDescriptor;
  conversationKey: string;
  issues: IngestIssue[];
  seen: Map<string, number>;
  ordinal: number;
}

function parseTimestamp(value: unknown, descriptor: JsonFormatDescriptor): number | null {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const ms = descriptor.message.ts_unit === "s" ? Math.round(numeric * 1000) : Math.round(numeric);
  return Number.isInteger(ms) ? ms : null;
}

function parseContentType(
  value: unknown,
  ctx: ParseContext,
  index: number,
): JsonContentType {
  if (typeof value !== "string" || value === "") return "text";
  if ((ctx.descriptor.content_types as readonly string[]).includes(value)) {
    return value as JsonContentType;
  }
  ctx.issues.push({
    line_no: index + 1,
    code: "CONTENT_TYPE_UNKNOWN",
    excerpt: `content_type=${value}`.slice(0, 200),
  });
  return "other";
}

/** 单条记录 → 归一化消息；字段缺失按 §4.2「不猜」填默认值 + issue。 */
function parseMessage(record: unknown, index: number, ctx: ParseContext): NormalizedMessage | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    ctx.issues.push({
      line_no: index + 1,
      code: "LINE_UNPARSED",
      excerpt: String(record).slice(0, 200),
    });
    return null;
  }
  const item = record as Json;
  const spec = ctx.descriptor.message;

  const contentValue = readField(item, spec.content_field);
  const content = asString(contentValue) ?? "";
  if (content === "" && contentValue !== undefined && contentValue !== null) {
    ctx.issues.push({
      line_no: index + 1,
      code: "LINE_UNPARSED",
      excerpt: `content 类型不符（${typeof contentValue}）`,
    });
  }

  const tsValue = readField(item, spec.ts_field);
  const ts = parseTimestamp(tsValue, ctx.descriptor);
  if (ts === null) {
    ctx.issues.push({
      line_no: index + 1,
      code: "TIMESTAMP_UNKNOWN",
      excerpt: String(tsValue ?? "").slice(0, 200),
    });
  }
  const ts_ms = ts ?? 0;

  const rawName = asString(readField(item, spec.sender_name_field)) ?? "";
  const rawSenderId = asString(readField(item, spec.sender_id_field)) ?? "";
  const is_pseudo = rawSenderId === "" || rawSenderId.startsWith("name:");
  const sender_name = rawName;
  const sender_id =
    rawSenderId !== ""
      ? rawSenderId
      : `name:${localNormalizeAlias(rawName) === "" ? "unknown" : localNormalizeAlias(rawName)}`;
  if (rawSenderId === "") {
    ctx.issues.push({
      line_no: index + 1,
      code: "SENDER_UNKNOWN",
      excerpt: sender_name.slice(0, 200),
    });
  }

  const content_type = parseContentType(readField(item, spec.content_type_field), ctx, index);
  const roleValue = asString(readField(item, spec.role_field)) ?? "";
  const role: JsonMessageRole = ROLES.includes(roleValue)
    ? (roleValue as JsonMessageRole)
    : isSelfName(sender_name, ctx.descriptor)
      ? "me"
      : content_type === "system"
        ? "system"
        : "other";

  const explicitId = asString(readField(item, spec.id_field)) ?? "";
  let message_id: string;
  if (explicitId !== "") {
    message_id = `${ctx.descriptor.platform}:${ctx.conversationKey}:${explicitId}`;
  } else {
    // 兜底 ID（DESIGN-11 §4.1）：Tier 规则 6 `ID_FALLBACK` 会命中，进人工队列。
    const ordinalKey = `${ts_ms}|${sender_name}|${content}`;
    const ordinal = ctx.seen.get(ordinalKey) ?? 0;
    ctx.seen.set(ordinalKey, ordinal + 1);
    const digest = createHash("sha1")
      .update(`${ts_ms} ${sender_name} ${content} ${ordinal}`)
      .digest("hex");
    message_id = `${ctx.descriptor.platform}:${ctx.conversationKey}:sha1:${digest}`;
  }

  const replyTo = asString(readField(item, spec.reply_to_field));
  const meta = is_pseudo ? JSON.stringify({ extra: { sender_id_is_pseudo: true } }) : "{}";
  return {
    message_id,
    sender_id,
    sender_name,
    role,
    ts_ms,
    msg_date: msgDateOf(ts_ms, ctx.descriptor.utc_offset_minutes),
    content,
    content_type,
    reply_to: replyTo === null || replyTo === "" ? null : replyTo,
    meta,
  };
}

function messagesOf(root: unknown, descriptor: JsonFormatDescriptor): unknown[] {
  if (Array.isArray(root)) return root;
  if (typeof root === "object" && root !== null) {
    const value = (root as Json)[descriptor.conversation.messages_field];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function headerOf(root: unknown, descriptor: JsonFormatDescriptor): Json {
  if (typeof root !== "object" || root === null || Array.isArray(root)) return {};
  return root as Json;
}

function normalizeOne(
  root: unknown,
  ref: RawConversationRef,
  descriptor: JsonFormatDescriptor,
): JsonConversationRead {
  const header = headerOf(root, descriptor);
  const keyValue = asString(header[descriptor.conversation.key_field]);
  const conversationKey =
    keyValue !== null && keyValue.trim() !== "" ? keyValue.trim() : ref.conversation_key;
  const titleValue = asString(header[descriptor.conversation.title_field]) ?? "";
  const kindValue = asString(header[descriptor.conversation.kind_field]) ?? "";
  const kind = descriptor.conversation_kind[kindValue] ?? "direct";

  const ctx: ParseContext = {
    descriptor,
    conversationKey,
    issues: [],
    seen: new Map(),
    ordinal: 0,
  };
  const records = messagesOf(root, descriptor);
  const messages: NormalizedMessage[] = [];
  records.forEach((record, index) => {
    ctx.ordinal = index;
    const message = parseMessage(record, index, ctx);
    if (message !== null) messages.push(message);
  });

  const timestamps = messages.map((message) => message.ts_ms).filter((ts) => ts > 0);
  const first = timestamps.length === 0 ? null : Math.min(...timestamps);
  const last = timestamps.length === 0 ? null : Math.max(...timestamps);
  const parsedFailures = ctx.issues.filter(
    (issue) => issue.code === "LINE_UNPARSED" || issue.code === "TIMESTAMP_UNKNOWN",
  ).length;
  return {
    conversation: {
      conversation_key: conversationKey,
      platform: descriptor.platform,
      kind,
      title: titleValue,
      first_ts_ms: first,
      last_ts_ms: last,
      messages,
      issues: ctx.issues,
    },
    diagnostics: {
      total_lines: records.length,
      parsed_failures: parsedFailures,
      encoding_loss_ratio: 0,
      has_nul: false,
    },
  };
}

async function listJsonFiles(
  dir: string,
  suffix: string,
): Promise<readonly RawConversationRef[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    throw new ChatIngestError("EXPORT_DIR_NOT_FOUND", `导出目录不可读：${dir}`, { cause });
  }
  const refs: RawConversationRef[] = [];
  for (const name of names.filter((item) => item.endsWith(suffix)).sort()) {
    const file_path = join(dir, name);
    const info = await stat(file_path);
    if (!info.isFile()) continue;
    refs.push({
      conversation_key: name.slice(0, -suffix.length),
      file_path,
      byte_size: info.size,
    });
  }
  return refs;
}

/** B 层（JSON 形态）：读一个 `.json` 文件 → `NormalizedConversation`。 */
export class JsonExportReader {
  readonly id: string;
  readonly platform: JsonChatPlatform;
  readonly tool_version: string;
  readonly descriptor: JsonFormatDescriptor;

  constructor(descriptor: JsonFormatDescriptor = GENERIC_JSON_DESCRIPTOR, toolVersion = "unknown") {
    this.descriptor = descriptor;
    this.id = descriptor.reader_id;
    this.platform = descriptor.platform;
    this.tool_version = toolVersion;
  }

  /** Tier 规则 5 用的标记表（`content_type` 全量白名单）。 */
  get content_type_markers(): TierContentTypeMarkers {
    return jsonContentTypeMarkers(this.descriptor);
  }

  async probe(dir: string): Promise<ProbeResult> {
    const refs = await listJsonFiles(dir, this.descriptor.file_suffix);
    const first = refs[0];
    if (first === undefined) {
      return {
        ok: false,
        reader_id: this.id,
        confidence: 0,
        sample_lines: [],
        detected_encoding: "utf-8",
        warnings: [`目录内没有 ${this.descriptor.file_suffix} 产物`],
      };
    }
    try {
      const read = await this.read(first);
      const sample = read.conversation.messages
        .slice(0, SAMPLE_LINES)
        .map((message) => `${message.message_id}\t${message.sender_name}\t${message.content}`);
      const ok = read.conversation.messages.length > 0;
      return {
        ok,
        reader_id: this.id,
        confidence: ok ? 1 : 0,
        sample_lines: sample,
        detected_encoding: "utf-8",
        warnings: ok ? [] : ["JSON 文件中没有可用消息记录"],
      };
    } catch (cause) {
      return {
        ok: false,
        reader_id: this.id,
        confidence: 0,
        sample_lines: [],
        detected_encoding: "utf-8",
        warnings: [describeError(cause)],
      };
    }
  }

  async listConversations(dir: string): Promise<readonly RawConversationRef[]> {
    return listJsonFiles(dir, this.descriptor.file_suffix);
  }

  /** 读一个会话（含 Tier 所需的诊断信息）；单文件损坏抛 `NORMALIZE_FAILED`。 */
  async read(ref: RawConversationRef): Promise<JsonConversationRead> {
    let text: string;
    try {
      text = await readFile(ref.file_path, "utf8");
    } catch (cause) {
      throw new ChatIngestError("READER_FAILED", `读取会话失败：${ref.file_path}`, { cause });
    }
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch (cause) {
      throw new ChatIngestError("NORMALIZE_FAILED", `JSON 解析失败：${ref.file_path}`, { cause });
    }
    const read = normalizeOne(root, ref, this.descriptor);
    return {
      conversation: read.conversation,
      diagnostics: {
        ...read.diagnostics,
        has_nul: text.includes("\u0000"),
        total_lines: Math.max(read.diagnostics.total_lines, 0),
      },
    };
  }

  /** 只取会话（等价 `read(ref).conversation`）。 */
  async readConversation(ref: RawConversationRef): Promise<NormalizedConversation> {
    return (await this.read(ref)).conversation;
  }

  /** 枚举并读取目录内全部会话（单文件失败不中断，由调用方决定是否跳过）。 */
  async readAll(dir: string): Promise<readonly JsonConversationRead[]> {
    const refs = await this.listConversations(dir);
    const results: JsonConversationRead[] = [];
    for (const ref of refs) {
      results.push(await this.read(ref));
    }
    return results;
  }
}
