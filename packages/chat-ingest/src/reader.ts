/**
 * A 层：导出产物读取器（DESIGN-11 §3.3 的 `IChatExportReader`）。
 * 只读：无写方法、不调外部工具、不写微信（DESIGN-11 附录 B-1）。
 * 惰性：`listConversations` 只枚举文件（不读正文），正文按会话逐个 `readConversation`。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChatPlatform } from "@knowself/person-store";
import type { CompiledDescriptor } from "./descriptor";
import { ChatIngestError } from "./errors";

/** 替换字符（U+FFFD）占比上限；超过即认为该编码有损（DESIGN-11 F4）。 */
const MAX_LOSS_RATIO = 0.05;
const SAMPLE_LINES = 50;
const REPLACEMENT = String.fromCharCode(0xfffd);
const TXT_SUFFIX = ".txt";

export interface RawConversationRef {
  /** reader 内部的稳定键（P0 = txt 文件名 stem；真实 key 在 `RawConversation.header` 里）。 */
  readonly conversation_key: string;
  readonly file_path: string;
  readonly byte_size: number;
}

/** 无损原始行缓冲：不做任何语义解释，便于格式变化后重解析。 */
export interface RawConversation {
  readonly ref: RawConversationRef;
  readonly lines: readonly string[];
  readonly detected_encoding: string;
  /** 头部键值（语义名 → 值），来自 descriptor 的 `header.keys` 映射。 */
  readonly header: Record<string, string>;
  /** 解码后 U+FFFD 占比（0..1）；Tier 规则 1 `ENCODING_LOSS` 的输入（DESIGN-11 §6.2）。 */
  readonly encoding_loss_ratio?: number;
  /** 解码文本是否含 `\x00`（Tier 规则 1 的第二判据）。 */
  readonly has_nul?: boolean;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly reader_id: string;
  readonly confidence: number;
  readonly sample_lines: readonly string[];
  readonly detected_encoding: string;
  readonly warnings: readonly string[];
}

export interface IChatExportReader {
  readonly id: string;
  readonly platform: ChatPlatform;
  readonly tool_version: string;
  /** 目录不存在 → 抛 `EXPORT_DIR_NOT_FOUND`（DESIGN-11 §8.1）。 */
  probe(dir: string): Promise<ProbeResult>;
  listConversations(dir: string): Promise<readonly RawConversationRef[]>;
  readConversation(ref: RawConversationRef): Promise<RawConversation>;
}

export interface DecodedText {
  text: string;
  encoding: string;
  lossRatio: number;
}

function replacementRatio(text: string): number {
  let hits = 0;
  for (const ch of text) {
    if (ch === REPLACEMENT) hits += 1;
  }
  return hits / Math.max(1, text.length);
}

/** 先按 UTF-8 解；有损时与 GBK 比损失率，取小者（不猜：两者都保留不了就选损失更小的）。 */
export function decodeText(buffer: Buffer): DecodedText {
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = buffer.subarray(hasBom ? 3 : 0);
  const utf8 = body.toString("utf8");
  const utf8Loss = replacementRatio(utf8);
  if (utf8Loss <= MAX_LOSS_RATIO) return { text: utf8, encoding: "utf-8", lossRatio: utf8Loss };
  const gbk = new TextDecoder("gbk").decode(body);
  const gbkLoss = replacementRatio(gbk);
  if (gbkLoss >= utf8Loss) return { text: utf8, encoding: "utf-8", lossRatio: utf8Loss };
  return { text: gbk, encoding: "gbk", lossRatio: gbkLoss };
}

function parseHeader(
  lines: readonly string[],
  spec: CompiledDescriptor["spec"],
): Record<string, string> {
  const header: Record<string, string> = {};
  for (const line of lines) {
    if (!line.startsWith(spec.header.prefix)) continue;
    const rest = line.slice(spec.header.prefix.length);
    const at = rest.indexOf(spec.header.separator);
    if (at < 0) continue;
    const semantic = spec.header.keys[rest.slice(0, at).trim()];
    if (semantic === undefined) continue;
    header[semantic] = rest.slice(at + spec.header.separator.length).trim();
  }
  return header;
}

async function listTxtFiles(dir: string): Promise<readonly RawConversationRef[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    throw new ChatIngestError("EXPORT_DIR_NOT_FOUND", `导出目录不可读：${dir}`, { cause });
  }
  const refs: RawConversationRef[] = [];
  for (const name of names.filter((item) => item.endsWith(TXT_SUFFIX)).sort()) {
    const file_path = join(dir, name);
    const info = await stat(file_path);
    if (!info.isFile()) continue;
    refs.push({ conversation_key: name.slice(0, -TXT_SUFFIX.length), file_path, byte_size: info.size });
  }
  return refs;
}

async function readOne(
  ref: RawConversationRef,
  compiled: CompiledDescriptor,
): Promise<RawConversation> {
  let buffer: Buffer;
  try {
    buffer = await readFile(ref.file_path);
  } catch (cause) {
    throw new ChatIngestError("READER_FAILED", `读取会话失败：${ref.file_path}`, { cause });
  }
  const decoded = decodeText(buffer);
  const lines = decoded.text.split(/\r?\n/);
  return {
    ref,
    lines,
    detected_encoding: decoded.encoding,
    header: parseHeader(lines, compiled.spec),
    encoding_loss_ratio: decoded.lossRatio,
    has_nul: decoded.text.includes("\u0000"),
  };
}

async function probeDir(dir: string, compiled: CompiledDescriptor): Promise<ProbeResult> {
  const reader_id = compiled.spec.reader_id;
  const refs = await listTxtFiles(dir);
  const first = refs[0];
  if (first === undefined) {
    return {
      ok: false,
      reader_id,
      confidence: 0,
      sample_lines: [],
      detected_encoding: "utf-8",
      warnings: ["目录内没有 .txt 产物"],
    };
  }
  const raw = await readOne(first, compiled);
  const headerOk = Object.keys(raw.header).length > 0;
  const messageOk = raw.lines.some((line) => compiled.messageHeader.test(line));
  const dateOk = raw.lines.some((line) => compiled.dateSeparator.test(line));
  const warnings: string[] = [];
  if (!headerOk) warnings.push("未找到描述符声明的头部键值行");
  if (!messageOk) warnings.push("未找到任何消息行");
  if (!dateOk) warnings.push("未找到日期分隔行");
  return {
    ok: headerOk && messageOk,
    reader_id,
    confidence: headerOk && messageOk ? (dateOk ? 1 : 0.6) : 0,
    sample_lines: raw.lines.slice(0, SAMPLE_LINES),
    detected_encoding: raw.detected_encoding,
    warnings,
  };
}

/** P0 reader：tarry9110 的 `export_msgs.py` 产物（每会话一个 UTF-8 CRLF txt）。 */
export class Tarry9110TxtReader implements IChatExportReader {
  readonly id: string;
  readonly platform: ChatPlatform;
  readonly tool_version: string;
  private readonly compiled: CompiledDescriptor;

  constructor(compiled: CompiledDescriptor, toolVersion = "unknown") {
    this.compiled = compiled;
    this.id = compiled.spec.reader_id;
    this.platform = compiled.spec.platform;
    this.tool_version = toolVersion;
  }

  probe(dir: string): Promise<ProbeResult> {
    return probeDir(dir, this.compiled);
  }

  listConversations(dir: string): Promise<readonly RawConversationRef[]> {
    return listTxtFiles(dir);
  }

  readConversation(ref: RawConversationRef): Promise<RawConversation> {
    return readOne(ref, this.compiled);
  }
}
