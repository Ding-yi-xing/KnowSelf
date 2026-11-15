import { describe, expect, it } from "vitest";
import { compileDescriptor, TARRY9110_TXT_DESCRIPTOR } from "../src/descriptor";
import { normalizeConversation } from "../src/normalize";
import type { RawConversation } from "../src/reader";
import { GROUP_TXT, SINGLE_TXT } from "./fixtures";

const compiled = compileDescriptor(TARRY9110_TXT_DESCRIPTOR);

/** 合成 RawConversation（与 reader 输出同形，绕过文件系统）。 */
function rawOf(text: string, key = "file-stem"): RawConversation {
  const lines = text.split("\n");
  const header: Record<string, string> = {};
  for (const line of lines) {
    const match = /^# (.+?) : (.*)$/.exec(line);
    if (match === null) continue;
    const semantic = TARRY9110_TXT_DESCRIPTOR.header.keys[(match[1] ?? "").trim()];
    if (semantic !== undefined) header[semantic] = (match[2] ?? "").trim();
  }
  return {
    ref: { conversation_key: key, file_path: `${key}.txt`, byte_size: text.length },
    lines,
    detected_encoding: "utf-8",
    header,
  };
}

describe("normalizeConversation（纯函数，DESIGN-11 §3.4 / §4.1）", () => {
  it("单聊：会话键取头部「会话对象」、标题/类型/首尾时间正确", () => {
    const result = normalizeConversation(rawOf(SINGLE_TXT), compiled);
    expect(result.conversation_key).toBe("wxid_aaaaaaaaaaaa22");
    expect(result.title).toBe("张三");
    expect(result.kind).toBe("direct");
    expect(result.platform).toBe("wechat");
    expect(result.messages).toHaveLength(5);
    expect(result.issues).toEqual([]);
    expect(result.first_ts_ms).toBe(new Date("2024-01-02T13:45:00+08:00").getTime());
    expect(result.last_ts_ms).toBe(new Date("2024-01-02T13:48:00+08:00").getTime());
  });

  it("role / sender_id / content_type 逐列符合 §4.1", () => {
    const result = normalizeConversation(rawOf(SINGLE_TXT), compiled);
    const [first, second, third] = result.messages;
    expect(first?.role).toBe("other");
    expect(first?.sender_id).toBe("name:张三");
    expect(first?.content_type).toBe("text");
    expect(first?.content).toBe("你好");
    expect(first?.meta).toBe(JSON.stringify({ extra: { sender_id_is_pseudo: true } }));
    expect(second?.role).toBe("me");
    expect(second?.sender_id).toBe("me");
    expect(second?.meta).toBe("{}");
    expect(third?.content_type).toBe("image");
    expect(third?.content).toBe("[图片]");
  });

  it("群聊：系统消息 / 未解析发送者 / 占位类型 / 续行 / 同秒重复消息", () => {
    const result = normalizeConversation(rawOf(GROUP_TXT), compiled);
    expect(result.kind).toBe("group");
    expect(result.title).toBe("测试群");
    expect(result.messages).toHaveLength(8);

    const byContent = (needle: string) => result.messages.find((m) => m.content.includes(needle));
    expect(byContent("[系统消息]")?.role).toBe("system");
    expect(byContent("[语音]")?.content_type).toBe("voice");
    expect(byContent("[表情]")?.content_type).toBe("other");
    expect(byContent("[类型244813135921]")?.content_type).toBe("other");
    // 正文里的表情短代码**不得**被当成占位（精确匹配，非前缀）
    expect(byContent("[捂脸]")?.content_type).toBe("text");

    const multiline = byContent("第一行");
    expect(multiline?.content).toBe("第一行\n第二行");
    expect(multiline?.content_type).toBe("text");

    const duplicates = result.messages.filter((m) => m.content === "重复");
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]?.message_id).not.toBe(duplicates[1]?.message_id);
    expect(duplicates[0]?.sender_id).toBe("name:王五");

    expect(result.issues.filter((issue) => issue.code === "SENDER_UNKNOWN")).toHaveLength(1);
  });

  it("未解析行 / 二进制内容 / 未知时间分别登记 issue，且不丢行", () => {
    const text = [
      "# 会话对象 : wxid_bbbbbbbbbbbb22",
      "# 显示名   : 李四",
      "# 类型     : 单聊",
      "#",
      "---------- 2024-03-04 ----------",
      "[2024-03-04 08:00] 李四: 正常",
      "这一行既不是续行也不是消息行",
      `[08:01] 李四: 带${String.fromCharCode(0)}空字节`,
      "[时间未知] 李四: 时间缺失",
    ].join("\n");
    const result = normalizeConversation(rawOf(text), compiled);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("LINE_UNPARSED");
    expect(codes).toContain("CONTENT_UNDECODABLE");
    expect(codes).toContain("TIMESTAMP_UNKNOWN");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.content).toContain(String.fromCharCode(0));
  });

  it("message_id 稳定：同一输入两次归一化逐字节相同（§4.2 不变量 1）", () => {
    const first = normalizeConversation(rawOf(GROUP_TXT), compiled);
    const second = normalizeConversation(rawOf(GROUP_TXT), compiled);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

/**
 * C2 上游修复（W-9 整洁项）：两处「空串」不再放行。
 *
 * 背景：这两个空串是**下游**兜底的起因（`labelOf` / `nonEmptyLabel`），
 * 修在这里才是"能处理"，而不是"看不见但没炸"。
 */
describe("normalizeConversation · 空发送者名 / 空会话标题（C2）", () => {
  /** 有 `# 会话对象`、但**没有** `# 显示名`，且消息行 `[hh:mm] : 正文` 没有名字。 */
  const NO_NAME_NO_TITLE = [
    "# 会话对象 : 12345678901@chatroom",
    "# 类型     : 群聊",
    "#",
    "---------- 2024-05-06 ----------",
    "[2024-05-06 09:00] : 没有发送者名字的一行",
    "[09:01] 王五: 正常一行",
  ].join("\n");

  it("空发送者名 → 改写成描述符既有的 unknown_sender 形态（不再是空串）", () => {
    const result = normalizeConversation(rawOf(NO_NAME_NO_TITLE), compiled);
    const blank = result.messages.find((m) => m.content.includes("没有发送者名字"));
    expect(blank).toBeDefined();
    // 关键：不是 ""，而是 `未知(sender=)`；下游 persons.display_name 因此非空
    expect(blank?.sender_name).toBe("未知(sender=)");
    expect(blank?.sender_name.trim()).not.toBe("");
    expect(blank?.sender_id).toBe("name:未知(sender=)");
    // role 仍是 other（不是 self，也不是 system）
    expect(blank?.role).toBe("other");
  });

  it("空发送者名 → 同时登记 SENDER_UNKNOWN issue（能处理，也看得见）", () => {
    const result = normalizeConversation(rawOf(NO_NAME_NO_TITLE), compiled);
    const unknown = result.issues.filter((issue) => issue.code === "SENDER_UNKNOWN");
    expect(unknown).toHaveLength(1);
    // 指到那一行（第 5 行：头部 3 行 + # + 日期分隔）
    expect(unknown[0]?.line_no).toBe(5);
    expect(unknown[0]?.excerpt).toContain("未知(sender=)");
  });

  it("缺 `# 显示名` → title 兜底成 conversation_key（不再是空串）", () => {
    const result = normalizeConversation(rawOf(NO_NAME_NO_TITLE), compiled);
    expect(result.conversation_key).toBe("12345678901@chatroom");
    expect(result.title).toBe("12345678901@chatroom");
    expect(result.title.trim()).not.toBe("");
  });

  it("有 `# 显示名` 时照常使用（兜底不得覆盖真实标题），且 title 去首尾空白", () => {
    const text = [
      "# 会话对象 : wxid_aaaaaaaaaaaa22",
      "# 显示名   :   老同学群   ",
      "# 类型     : 群聊",
      "#",
      "---------- 2024-05-06 ----------",
      "[2024-05-06 09:00] 王五: 正常一行",
    ].join("\n");
    const result = normalizeConversation(rawOf(text), compiled);
    expect(result.title).toBe("老同学群");
  });
});
