import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERIC_JSON_DESCRIPTOR,
  JsonExportReader,
  loadJsonDescriptor,
  msgDateOf,
} from "../src/readers/json";
import { isChatIngestError } from "../src/errors";

const TS = new Date("2024-01-02T13:45:00+08:00").getTime();
const scratch: string[] = [];

function makeDir(files: Record<string, unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-chat-json-"));
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

const SINGLE = {
  conversation_key: "wxid_aaaaaaaaaaaa22",
  title: "张三",
  kind: "单聊",
  messages: [
    {
      message_id: "1",
      ts_ms: TS,
      sender_id: "name:张三",
      sender_name: "张三",
      role: "other",
      content: "你好",
      content_type: "text",
    },
    {
      ts_ms: TS + 60000,
      sender_name: "我",
      content: "在的",
      content_type: "text",
    },
    {
      ts_ms: "bad",
      sender_name: "张三",
      content: "坏时间",
      content_type: "text",
    },
    {
      message_id: "4",
      ts_ms: TS + 120000,
      sender_id: "name:张三",
      sender_name: "张三",
      content: "[未知标记]",
      content_type: "weird",
    },
  ],
};

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("JsonExportReader（DESIGN-11 §3.5「换工具零改动」的 JSON 形态）", () => {
  it("probe 命中并给出样本", async () => {
    const dir = makeDir({ "single.json": SINGLE });
    const reader = new JsonExportReader(GENERIC_JSON_DESCRIPTOR, "1");
    const probe = await reader.probe(dir);
    expect(probe.ok).toBe(true);
    expect(probe.reader_id).toBe("generic-json-v1");
    expect(probe.confidence).toBe(1);
    expect(probe.sample_lines.length).toBeGreaterThan(0);
  });

  it("空目录 probe 失败（不抛错）", async () => {
    const dir = makeDir({ "note.txt": "not json" });
    const reader = new JsonExportReader();
    const probe = await reader.probe(dir);
    expect(probe.ok).toBe(false);
    expect(probe.warnings.length).toBeGreaterThan(0);
  });

  it("字段映射到 NormalizedMessage（§4.1）", async () => {
    const dir = makeDir({ "single.json": SINGLE });
    const reader = new JsonExportReader(GENERIC_JSON_DESCRIPTOR, "1");
    const read = await reader.readAll(dir);
    expect(read).toHaveLength(1);
    const conversation = read[0]!.conversation;
    expect(conversation.conversation_key).toBe("wxid_aaaaaaaaaaaa22");
    expect(conversation.title).toBe("张三");
    expect(conversation.kind).toBe("direct");
    expect(conversation.messages).toHaveLength(4);

    const [first, second] = conversation.messages;
    expect(first?.message_id).toBe("wechat:wxid_aaaaaaaaaaaa22:1");
    expect(first?.sender_id).toBe("name:张三");
    expect(first?.role).toBe("other");
    expect(first?.msg_date).toBe("2024-01-02");
    expect(second?.role).toBe("me");
    expect(second?.sender_id.startsWith("name:")).toBe(true);
    expect(second?.message_id).toContain(":sha1:");
  });

  it("字段缺失 / 类型不符按 §8.1 归类为 issue，不抛裸错", async () => {
    const dir = makeDir({ "single.json": SINGLE });
    const reader = new JsonExportReader();
    const read = await reader.readAll(dir);
    const issues = read[0]!.conversation.issues;
    expect(issues.some((issue) => issue.code === "TIMESTAMP_UNKNOWN")).toBe(true);
    expect(issues.some((issue) => issue.code === "CONTENT_TYPE_UNKNOWN")).toBe(true);
    expect(issues.some((issue) => issue.code === "SENDER_UNKNOWN")).toBe(true);
    const invalid = read[0]!.conversation.messages[2];
    expect(invalid?.ts_ms).toBe(0);
    expect(read[0]!.diagnostics.parsed_failures).toBeGreaterThanOrEqual(1);
    // 非法 content_type → 'other'（§4.1）
    expect(read[0]!.conversation.messages[3]?.content_type).toBe("other");
  });

  it("会话键缺失时退回文件名 stem（§5.4 稳定性退路）", async () => {
    const dir = makeDir({
      "fallback_ab12cd.json": { title: "无键会话", kind: "群聊", messages: SINGLE.messages },
    });
    const reader = new JsonExportReader();
    const read = await reader.readAll(dir);
    expect(read[0]!.conversation.conversation_key).toBe("fallback_ab12cd");
    expect(read[0]!.conversation.kind).toBe("group");
  });

  it("JSON 语法错误 → NORMALIZE_FAILED（单文件失败可定位）", async () => {
    const dir = makeDir({ "broken.json": "{ not json" });
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

  it("descriptor 校验：非法 platform / ts_unit 直接报错（数据文件是唯一格式真相源）", () => {
    expect(() => loadJsonDescriptor({ descriptor_version: 2 })).toThrow();
    expect(() =>
      loadJsonDescriptor({
        ...JSON.parse(JSON.stringify(GENERIC_JSON_DESCRIPTOR)),
        platform: "unknown-platform",
      }),
    ).toThrow();
  });

  it("msgDateOf 按固定偏移派生 YYYY-MM-DD（§4.1）", () => {
    // 2024-01-02T13:45+08:00 = 05:45Z，+480min 回到 13:45Z → 同日
    expect(msgDateOf(TS, 480)).toBe("2024-01-02");
    // 不跨日：15:45Z + 480min = 23:45Z，仍是 1 月 2 日（原断言误算为次日）
    expect(msgDateOf(Date.UTC(2024, 0, 2, 15, 45), 480)).toBe("2024-01-02");
    // 真正的跨日边界：16:30Z + 480min = 次日 00:30Z
    expect(msgDateOf(Date.UTC(2024, 0, 2, 16, 30), 480)).toBe("2024-01-03");
    // 负偏移：00:30Z - 60min = 前一日 23:30Z
    expect(msgDateOf(Date.UTC(2024, 0, 2, 0, 30), -60)).toBe("2024-01-01");
  });
});
