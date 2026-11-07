import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { compileDescriptor, TARRY9110_TXT_DESCRIPTOR } from "../src/descriptor";
import { isChatIngestError } from "../src/errors";
import { decodeText, Tarry9110TxtReader } from "../src/reader";
import { defaultExportDir, makeExportDir, SINGLE_TXT } from "./fixtures";

const reader = new Tarry9110TxtReader(compileDescriptor(TARRY9110_TXT_DESCRIPTOR), "test");
const dirs: string[] = [];

function tempDir(files: Record<string, string>): string {
  const dir = makeExportDir(files);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("decodeText（编码探测，DESIGN-11 F4）", () => {
  it("UTF-8 直通并剥 BOM", () => {
    const plain = decodeText(Buffer.from("张三", "utf8"));
    expect(plain.encoding).toBe("utf-8");
    expect(plain.text).toBe("张三");
    const bom = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("张三", "utf8")]));
    expect(bom.text).toBe("张三");
  });

  it("UTF-8 有损时回退 GBK", () => {
    const decoded = decodeText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    expect(decoded.encoding).toBe("gbk");
    expect(decoded.text).toBe("你好");
  });
});

describe("Tarry9110TxtReader", () => {
  it("listConversations 只枚举 .txt 且按文件名排序", async () => {
    const dir = tempDir({ "b.txt": SINGLE_TXT, "a.txt": SINGLE_TXT, "note.md": "x" });
    const refs = await reader.listConversations(dir);
    expect(refs.map((ref) => ref.conversation_key)).toEqual(["a", "b"]);
    expect(refs[0]?.byte_size).toBeGreaterThan(0);
  });

  it("readConversation 无损保留原始行并解析头部键值", async () => {
    const dir = tempDir({ "张三_13d6d3.txt": SINGLE_TXT });
    const refs = await reader.listConversations(dir);
    const raw = await reader.readConversation(refs[0]!);
    expect(raw.detected_encoding).toBe("utf-8");
    expect(raw.header["conversation_key"]).toBe("wxid_aaaaaaaaaaaa22");
    expect(raw.header["title"]).toBe("张三");
    expect(raw.header["kind"]).toBe("单聊");
    expect(raw.lines.some((line) => line.includes("你好"))).toBe(true);
    expect(raw.lines.at(-1)).toBe("");
  });

  it("probe 命中实测格式；空目录 / 目录不存在分别给出可判定的结果", async () => {
    const good = await reader.probe(defaultExportDir());
    expect(good.ok).toBe(true);
    expect(good.confidence).toBe(1);
    expect(good.reader_id).toBe("tarry9110-txt-v1");

    const empty = await reader.probe(tempDir({ "note.md": "not a chat" }));
    expect(empty.ok).toBe(false);
    expect(empty.warnings.length).toBeGreaterThan(0);

    let missing: unknown = null;
    try {
      await reader.probe(join(tempDir({ "a.txt": SINGLE_TXT }), "nope"));
    } catch (cause) {
      missing = cause;
    }
    expect(isChatIngestError(missing)).toBe(true);
  });
});
