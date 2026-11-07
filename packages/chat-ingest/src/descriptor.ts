/**
 * 格式描述符（DESIGN-11 §3.3）：**格式知识全部是数据**。本文件只校验/读入 JSON 并编译正则；
 * 换工具 / 换行格式 = 换一个 JSON，`normalize.ts` 不改。格式取自实测产物（非 DESIGN-11 推测）。
 */
import type { ChatPlatform, ContentType, ConversationKind } from "@knowself/person-store";
import rawTarry9110 from "./descriptors/tarry9110-txt.json";
import { ChatIngestError, describeError } from "./errors";

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

type Json = Record<string, unknown>;

export interface ChatFormatDescriptor {
  descriptor_version: 1;
  reader_id: string;
  platform: ChatPlatform;
  /** IANA 名（记录用）；换算只依赖 `timestamp.utc_offset_minutes`。 */
  timezone: string;
  header: {
    /** 头部行前缀（实测 `#`；单独的 `#` 行也按头部跳过）。 */
    prefix: string;
    separator: string;
    /** 中文键 → 语义名（`conversation_key` / `title` / `kind` / …）。 */
    keys: Record<string, string>;
  };
  /** 头部「类型」取值 → `ConversationKind`（实测：`单聊` / `群聊`）。 */
  conversation_kind: Record<string, ConversationKind>;
  /** 日期分隔行；**捕获组 1 = 日期**（`^---------- (\d{4}-\d{2}-\d{2}) ----------$`）。 */
  date_separator: string;
  /** 消息行；**捕获组 1 = 时间串、组 2 = 其余**（`^\[<ts>\] <who>: <body>$`）。 */
  message_header: string;
  /** 发送者与正文的分隔串（在**首次**出现处切分）。 */
  sender_separator: string;
  /** 每日首条带完整日期、同日其余只有 `short`；偏移固定（Asia/Shanghai = 480，无夏令时）。 */
  timestamp: { long: string; short: string; utc_offset_minutes: number };
  /** 「我」的识别（实测：txt 工具把本人渲染为字面量 `我`）。 */
  self_marker: { kind: "literal" | "regex"; value: string };
  /** `未知(sender=22)` 形态——发送者未解析，**不得**当成真人名（实测存在）。 */
  unknown_sender: { prefix: string; suffix: string };
  /** 正文**整体**等于标记 → 类型（避免把正文里的 `[捂脸]` 误判为占位）。 */
  content_type_exact: Record<string, ContentType>;
  /** 正文以标记**开头** → 类型（`[表情:xxx]` / `[系统] …` / `[类型N]`）。 */
  content_type_prefix: Record<string, ContentType>;
  /** 多行消息的续行判定（实测：续行缩进 4 空格）。 */
  continuation: { kind: "indent" | "none"; indent_chars: number };
}

export interface CompiledDescriptor {
  readonly spec: ChatFormatDescriptor;
  readonly messageHeader: RegExp;
  readonly dateSeparator: RegExp;
}

function fail(path: string, reason: string): never {
  throw new ChatIngestError("DESCRIPTOR_INVALID", `descriptor 非法：${path} ${reason}`);
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

function readRegex(source: Json, key: string, path: string): string {
  const pattern = readString(source, key, path);
  try {
    new RegExp(pattern);
    return pattern;
  } catch (cause) {
    fail(`${path}.${key}`, `正则无法编译（${describeError(cause)}）`);
  }
}

function readInteger(source: Json, key: string, path: string, min: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${path}.${key}`, `必须是不小于 ${min} 的整数`);
  }
  return value;
}

function readStringMap(source: Json, path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string" || value === "") fail(`${path}.${key}`, "必须是非空字符串");
    result[key] = value;
  }
  return result;
}

function readContentTypes(source: Json, path: string): Record<string, ContentType> {
  const result: Record<string, ContentType> = {};
  for (const [marker, value] of Object.entries(source)) {
    if (typeof value !== "string" || !CONTENT_TYPES.includes(value)) {
      fail(`${path}.${marker}`, `content_type 不在枚举内：${String(value)}`);
    }
    result[marker] = value as ContentType;
  }
  return result;
}

function readConversationKinds(source: Json, path: string): Record<string, ConversationKind> {
  const result: Record<string, ConversationKind> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== "direct" && value !== "group") fail(`${path}.${key}`, "只支持 direct / group");
    result[key] = value;
  }
  return result;
}

function readSelfMarker(source: Json): ChatFormatDescriptor["self_marker"] {
  const kind = readString(source, "kind", "$.self_marker");
  if (kind !== "literal" && kind !== "regex") fail("$.self_marker.kind", "只支持 literal / regex");
  if (kind === "regex") readRegex(source, "value", "$.self_marker");
  return { kind, value: readString(source, "value", "$.self_marker") };
}

function readContinuation(source: Json): ChatFormatDescriptor["continuation"] {
  const kind = readString(source, "kind", "$.continuation");
  if (kind !== "indent" && kind !== "none") fail("$.continuation.kind", "只支持 indent / none");
  return { kind, indent_chars: readInteger(source, "indent_chars", "$.continuation", 0) };
}

/** 校验并读入描述符；任何缺字段 / 非法值抛 `DESCRIPTOR_INVALID`。 */
export function loadDescriptor(raw: unknown): ChatFormatDescriptor {
  const root = asRecord(raw, "$");
  if (root["descriptor_version"] !== 1) fail("$.descriptor_version", "只支持 1");
  const platform = readString(root, "platform", "$");
  if (!PLATFORMS.includes(platform)) fail("$.platform", `未知平台：${platform}`);
  const unknownSender = asRecord(root["unknown_sender"], "$.unknown_sender");
  const header = asRecord(root["header"], "$.header");
  const stamp = asRecord(root["timestamp"], "$.timestamp");
  return {
    descriptor_version: 1,
    reader_id: readString(root, "reader_id", "$"),
    platform: platform as ChatPlatform,
    timezone: readString(root, "timezone", "$"),
    header: {
      prefix: readString(header, "prefix", "$.header"),
      separator: readString(header, "separator", "$.header"),
      keys: readStringMap(asRecord(header["keys"], "$.header.keys"), "$.header.keys"),
    },
    conversation_kind: readConversationKinds(
      asRecord(root["conversation_kind"], "$.conversation_kind"),
      "$.conversation_kind",
    ),
    date_separator: readRegex(root, "date_separator", "$"),
    message_header: readRegex(root, "message_header", "$"),
    sender_separator: readString(root, "sender_separator", "$"),
    timestamp: {
      long: readString(stamp, "long", "$.timestamp"),
      short: readString(stamp, "short", "$.timestamp"),
      utc_offset_minutes: readInteger(stamp, "utc_offset_minutes", "$.timestamp", -1440),
    },
    self_marker: readSelfMarker(asRecord(root["self_marker"], "$.self_marker")),
    unknown_sender: {
      prefix: readString(unknownSender, "prefix", "$.unknown_sender"),
      suffix: readString(unknownSender, "suffix", "$.unknown_sender"),
    },
    content_type_exact: readContentTypes(
      asRecord(root["content_type_exact"], "$.content_type_exact"),
      "$.content_type_exact",
    ),
    content_type_prefix: readContentTypes(
      asRecord(root["content_type_prefix"], "$.content_type_prefix"),
      "$.content_type_prefix",
    ),
    continuation: readContinuation(asRecord(root["continuation"], "$.continuation")),
  };
}

export function compileDescriptor(spec: ChatFormatDescriptor): CompiledDescriptor {
  return {
    spec,
    messageHeader: new RegExp(spec.message_header),
    dateSeparator: new RegExp(spec.date_separator),
  };
}

/** P0 唯一描述符：tarry9110 的 `export_msgs.py` 产物（实测格式）。 */
export const TARRY9110_TXT_DESCRIPTOR: ChatFormatDescriptor = loadDescriptor(rawTarry9110);
