import { describe, expect, it } from "vitest";
import {
  compileDescriptor,
  loadDescriptor,
  TARRY9110_TXT_DESCRIPTOR,
} from "../src/descriptor";
import { ChatIngestError, isChatIngestError } from "../src/errors";
import { timestampPattern } from "../src/time";

function broken(over: Record<string, unknown>): unknown {
  return { ...(TARRY9110_TXT_DESCRIPTOR as unknown as Record<string, unknown>), ...over };
}

describe("descriptor（格式描述符 = 数据）", () => {
  it("实测描述符可加载且关键字段取自产物", () => {
    expect(TARRY9110_TXT_DESCRIPTOR.reader_id).toBe("tarry9110-txt-v1");
    expect(TARRY9110_TXT_DESCRIPTOR.platform).toBe("wechat");
    expect(TARRY9110_TXT_DESCRIPTOR.self_marker).toEqual({ kind: "literal", value: "我" });
    expect(TARRY9110_TXT_DESCRIPTOR.header.keys["会话对象"]).toBe("conversation_key");
    expect(TARRY9110_TXT_DESCRIPTOR.conversation_kind["群聊"]).toBe("group");
    expect(TARRY9110_TXT_DESCRIPTOR.content_type_exact["[图片]"]).toBe("image");
    expect(TARRY9110_TXT_DESCRIPTOR.timestamp.utc_offset_minutes).toBe(480);
  });

  it("编译后产出可复用正则", () => {
    const compiled = compileDescriptor(TARRY9110_TXT_DESCRIPTOR);
    expect(compiled.messageHeader.exec("[2024-01-02 13:45] 张三: 你好")?.[1]).toBe(
      "2024-01-02 13:45",
    );
    expect(compiled.dateSeparator.exec("---------- 2024-01-02 ----------")?.[1]).toBe("2024-01-02");
    expect(compiled.dateSeparator.test("2024-01-02")).toBe(false);
  });

  it("拒绝非法描述符（版本 / 正则 / 平台 / 枚举 / 缺字段）", () => {
    const cases: readonly unknown[] = [
      broken({ descriptor_version: 2 }),
      broken({ date_separator: "([unclosed" }),
      broken({ platform: "signal" }),
      broken({ content_type_exact: { "[图片]": "photo" } }),
      broken({ reader_id: "" }),
      broken({ conversation_kind: { 单聊: "solo" } }),
      broken({ continuation: { kind: "indent", indent_chars: -1 } }),
      null,
    ];
    for (const value of cases) {
      let thrown: unknown = null;
      try {
        loadDescriptor(value);
      } catch (cause) {
        thrown = cause;
      }
      expect(isChatIngestError(thrown)).toBe(true);
      expect((thrown as ChatIngestError).code).toBe("DESCRIPTOR_INVALID");
    }
  });

  it("timestampPattern 支持 long / short 两种格式串", () => {
    expect(timestampPattern("YYYY-MM-DD HH:mm").fields).toEqual(["YYYY", "MM", "DD", "HH", "mm"]);
    expect(timestampPattern("HH:mm").regex.test("13:45")).toBe(true);
    expect(timestampPattern("YYYY-MM-DD HH:mm").regex.test("13:45")).toBe(false);
  });
});
