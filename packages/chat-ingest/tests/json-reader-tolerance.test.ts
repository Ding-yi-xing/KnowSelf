/**
 * JSON reader 容错路径（DESIGN-11 §8.1 / §4.2「不猜」；§9.2 `Normalizer` 行的 JSON 形态）。
 *
 * 目标：字段缺失 / 类型不符必须降级为 issue，**不得抛裸错、不得中断整批**。
 * 全部为合成数据（§9.1 铁律 2），人名只用 张三 / 我。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isChatIngestError } from "../src/errors";
import {
  GENERIC_JSON_DESCRIPTOR,
  JsonExportReader,
  loadJsonDescriptor,
  type JsonFormatDescriptor,
} from "../src/readers/json";

const TS = new Date("2024-01-02T13:45:00+08:00").getTime();
const scratch: string[] = [];

function makeDir(files: Record<string, unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-chat-json-tol-"));
  scratch.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof content === "string" ? content : JSON.stringify(content),
      "utf8",
    );
  }
  return dir;
}

/** 基于通用描述符派生一个变体（只改一个字段，验证「换格式 = 改描述符」）。 */
function descriptorWith(over: { utc_offset_minutes?: number; ts_unit?: "ms" | "s" }): JsonFormatDescriptor {
  const raw = JSON.parse(JSON.stringify(GENERIC_JSON_DESCRIPTOR)) as Record<string, unknown>;
  if (over.utc_offset_minutes !== undefined) raw["utc_offset_minutes"] = over.utc_offset_minutes;
  if (over.ts_unit !== undefined) {
    (raw["message"] as Record<string, unknown>)["ts_unit"] = over.ts_unit;
  }
  return loadJsonDescriptor(raw);
}

function conversation(messages: unknown[], over: Record<string, unknown> = {}) {
  return {
    conversation_key: "wxid_aaaaaaaaaaaa22",
    title: "张三",
    kind: "单聊",
    messages,
    ...over,
  };
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("结构容错：文件不是预期的会话对象", () => {
  it("根是数组 → 直接当作消息数组（容忍工具只导出消息）", async () => {
    const dir = makeDir({
      "list.json": [{ ts_ms: TS, sender_name: "张三", content: "你好", content_type: "text" }],
    });
    const read = await new JsonExportReader().readAll(dir);
    expect(read[0]!.conversation.messages).toHaveLength(1);
    // 无 conversation_key → 退回文件名 stem（§5.4）
    expect(read[0]!.conversation.conversation_key).toBe("list");
  });

  it("messages 字段缺失 / 非数组 → 0 条消息，probe 判不命中（不抛错）", async () => {
    const missing = makeDir({ "a.json": { conversation_key: "wxid_aaaaaaaaaaaa22", title: "张三" } });
    const notArray = makeDir({
      "b.json": { conversation_key: "wxid_aaaaaaaaaaaa22", messages: "oops" },
    });
    const reader = new JsonExportReader();

    for (const dir of [missing, notArray]) {
      const read = await reader.readAll(dir);
      expect(read[0]!.conversation.messages).toHaveLength(0);
      expect(read[0]!.diagnostics.total_lines).toBe(0);
      const probe = await reader.probe(dir);
      expect(probe.ok).toBe(false);
      expect(probe.warnings.length).toBeGreaterThan(0);
    }
  });

  it("单条记录不是对象 → LINE_UNPARSED 并跳过，其余消息仍正常解析", async () => {
    const dir = makeDir({
      "mixed.json": conversation([
        null,
        [1, 2],
        "裸字符串",
        { message_id: "ok", ts_ms: TS, sender_name: "张三", content: "正常", content_type: "text" },
      ]),
    });
    const read = await new JsonExportReader().readAll(dir);
    const { conversation: one, diagnostics } = read[0]!;

    expect(one.messages).toHaveLength(1);
    expect(one.messages[0]!.content).toBe("正常");
    expect(one.issues.filter((issue) => issue.code === "LINE_UNPARSED")).toHaveLength(3);
    expect(diagnostics.parsed_failures).toBe(3);
    expect(diagnostics.total_lines).toBe(4);
  });
});

describe("字段级容错（§4.2「不猜」→ 落 issue）", () => {
  it("时间：数字字符串可解析；非数字 → TIMESTAMP_UNKNOWN 且 ts_ms=0（不中断）", async () => {
    const dir = makeDir({
      "ts.json": conversation([
        { message_id: "1", ts_ms: String(TS), sender_name: "张三", content: "字符串时间", content_type: "text" },
        { message_id: "2", ts_ms: "not-a-number", sender_name: "张三", content: "坏时间", content_type: "text" },
        { message_id: "3", ts_ms: null, sender_name: "张三", content: "空时间", content_type: "text" },
      ]),
    });
    const read = await new JsonExportReader().readAll(dir);
    const messages = read[0]!.conversation.messages;

    expect(messages[0]!.ts_ms).toBe(TS);
    expect(messages[1]!.ts_ms).toBe(0);
    expect(messages[2]!.ts_ms).toBe(0);
    expect(read[0]!.conversation.issues.filter((i) => i.code === "TIMESTAMP_UNKNOWN")).toHaveLength(2);
  });

  it("描述符 ts_unit='s' → 秒级时间戳换算为毫秒", async () => {
    const dir = makeDir({
      "sec.json": conversation([
        { message_id: "1", ts_ms: TS / 1000, sender_name: "张三", content: "秒级", content_type: "text" },
      ]),
    });
    const read = await new JsonExportReader(descriptorWith({ ts_unit: "s" })).readAll(dir);
    expect(read[0]!.conversation.messages[0]!.ts_ms).toBe(TS);
  });

  it("content 类型不符 → LINE_UNPARSED 且内容置空（不 JSON.stringify 猜内容）", async () => {
    const dir = makeDir({
      "content.json": conversation([
        { message_id: "1", ts_ms: TS, sender_name: "张三", content: { nested: true }, content_type: "text" },
      ]),
    });
    const read = await new JsonExportReader().readAll(dir);
    expect(read[0]!.conversation.messages[0]!.content).toBe("");
    expect(read[0]!.conversation.issues.some((i) => i.code === "LINE_UNPARSED")).toBe(true);
  });

  it("sender_id 缺失 → 由 sender_name 派生伪 ID + SENDER_UNKNOWN + meta 标记", async () => {
    const dir = makeDir({
      "sender.json": conversation([
        { message_id: "1", ts_ms: TS, sender_name: " 张三 ", content: "无 sender_id", content_type: "text" },
        { message_id: "2", ts_ms: TS, sender_name: "", content: "连名字都没有", content_type: "text" },
      ]),
    });
    const read = await new JsonExportReader().readAll(dir);
    const [first, second] = read[0]!.conversation.messages;

    expect(first!.sender_id).toBe("name:张三");
    expect(JSON.parse(first!.meta)).toEqual({ extra: { sender_id_is_pseudo: true } });
    // 名字也缺失时不得产生 `name:undefined`，兜底为 name:unknown
    expect(second!.sender_id).toBe("name:unknown");
    expect(read[0]!.conversation.issues.filter((i) => i.code === "SENDER_UNKNOWN")).toHaveLength(2);
  });

  it("role 缺失/非法：self_marker 命中 '我' → me；system 内容类型 → system；其余 other", async () => {
    const dir = makeDir({
      "role.json": conversation([
        { message_id: "1", ts_ms: TS, sender_name: "我", content: "自己", content_type: "text" },
        { message_id: "2", ts_ms: TS, sender_name: "李四", content: "[系统消息]", content_type: "system" },
        { message_id: "3", ts_ms: TS, sender_name: "李四", content: "他人", content_type: "text", role: "奇怪角色" },
      ]),
    });
    const messages = (await new JsonExportReader().readAll(dir))[0]!.conversation.messages;
    expect(messages[0]!.role).toBe("me");
    expect(messages[1]!.role).toBe("system");
    expect(messages[2]!.role).toBe("other");
  });

  it("message_id 缺失 → sha1 兜底；同内容多条以 ordinal 区分（不产生重复 ID）", async () => {
    const dir = makeDir({
      "id.json": conversation([
        { ts_ms: TS, sender_name: "张三", content: "重复", content_type: "text" },
        { ts_ms: TS, sender_name: "张三", content: "重复", content_type: "text" },
      ]),
    });
    const messages = (await new JsonExportReader().readAll(dir))[0]!.conversation.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.message_id).toContain(":sha1:");
    expect(messages[1]!.message_id).toContain(":sha1:");
    expect(messages[0]!.message_id).not.toBe(messages[1]!.message_id);
  });

  it("reply_to 空串 → null；有值则原样保留", async () => {
    const dir = makeDir({
      "reply.json": conversation([
        { message_id: "1", ts_ms: TS, sender_name: "张三", content: "a", content_type: "text", reply_to: "" },
        { message_id: "2", ts_ms: TS, sender_name: "张三", content: "b", content_type: "text", reply_to: "1" },
      ]),
    });
    const messages = (await new JsonExportReader().readAll(dir))[0]!.conversation.messages;
    expect(messages[0]!.reply_to).toBeNull();
    expect(messages[1]!.reply_to).toBe("1");
  });

  it("msg_date 按描述符偏移派生（改偏移即改日期边界）", async () => {
    // 16:30Z 用 +480 → 次日；用 0 → 当日
    const ts = Date.UTC(2024, 0, 2, 16, 30);
    const dir = makeDir({
      "date.json": conversation([
        { message_id: "1", ts_ms: ts, sender_name: "张三", content: "边界", content_type: "text" },
      ]),
    });
    const shanghai = (await new JsonExportReader().readAll(dir))[0]!.conversation.messages[0]!;
    const utc = (await new JsonExportReader(descriptorWith({ utc_offset_minutes: 0 })).readAll(dir))[0]!
      .conversation.messages[0]!;
    expect(shanghai.msg_date).toBe("2024-01-03");
    expect(utc.msg_date).toBe("2024-01-02");
  });
});

describe("文件级容错（§8.1 错误码可定位）", () => {
  it("内容含转义 NUL（\\u0000）可正常解析；has_nul 只反映裸 NUL 字节（已知局限，见注释）", async () => {
    // 合法 JSON 无法承载裸 NUL（V8 会对未转义控制字符抛 "Bad control character"），
    // 而 `read()` 的 has_nul 判据是 `rawText.includes("\u0000")`，
    // 因此 JSON 路径的裸 NUL 必然先落到 NORMALIZE_FAILED；这里固化该行为，避免误以为有保护。
    const text = JSON.stringify(
      conversation([
        {
          message_id: "1",
          ts_ms: TS,
          sender_name: "张三",
          content: "含\u0000转义空字节",
          content_type: "text",
        },
      ]),
    );
    expect(text.includes("\u0000")).toBe(false);

    const dir = makeDir({ "nul.json": text });
    const read = await new JsonExportReader().readAll(dir);
    expect(read[0]!.conversation.messages[0]!.content).toBe("含\u0000转义空字节");
    expect(read[0]!.diagnostics.has_nul).toBe(false);
  });

  it("文件含裸 NUL 字节（非法 JSON）→ NORMALIZE_FAILED（可定位，不静默）", async () => {
    const dir = makeDir({ "broken.json": '{"messages":[{"content":"a\u0000b"}]}' });
    const reader = new JsonExportReader();
    const refs = await reader.listConversations(dir);
    let thrown: unknown = null;
    try {
      await reader.read(refs[0]!);
    } catch (cause) {
      thrown = cause;
    }
    expect(isChatIngestError(thrown)).toBe(true);
    if (isChatIngestError(thrown)) expect(thrown.code).toBe("NORMALIZE_FAILED");
  });

  it("合法 JSON 但为空对象 → 0 消息 + probe 不命中", async () => {
    const dir = makeDir({ "empty.json": {} });
    const reader = new JsonExportReader();
    const read = await reader.readAll(dir);
    expect(read[0]!.conversation.messages).toHaveLength(0);
    expect((await reader.probe(dir)).ok).toBe(false);
  });

  it("目录不存在 → EXPORT_DIR_NOT_FOUND（不吞错）", async () => {
    const missing = join(tmpdir(), `knowself-not-exist-${Date.now()}`);
    let thrown: unknown = null;
    try {
      await new JsonExportReader().listConversations(missing);
    } catch (cause) {
      thrown = cause;
    }
    expect(isChatIngestError(thrown)).toBe(true);
    if (isChatIngestError(thrown)) expect(thrown.code).toBe("EXPORT_DIR_NOT_FOUND");
  });

  it("目录里的非 .json 文件被忽略", async () => {
    const dir = mkdtempSync(join(tmpdir(), "knowself-chat-json-tol-"));
    scratch.push(dir);
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "note.txt"), "not json", "utf8");
    const refs = await new JsonExportReader().listConversations(dir);
    expect(refs).toHaveLength(0);
  });
});
