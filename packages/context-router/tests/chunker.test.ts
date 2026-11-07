/**
 * chunker.test.ts — 文档切片单元测试
 */

import { describe, it, expect } from "vitest";
import { chunkDocument } from "../src/chunker";
import type { DocSourceType } from "@knowself/contracts";

function makeDoc(body: string) {
  return {
    doc: {
      id: "card_test",
      source: "card" as DocSourceType,
      path: "card_test",
      updatedAt: "2026-05-27T00:00:00.000Z",
    },
    body,
    parentMaxTokens: 2000,
    childTargetTokens: 256,
    childOverlapTokens: 32,
    countTokens: (s: string) => Math.ceil(s.length / 3.5),
  };
}

describe("chunkDocument", () => {
  it("应返回空数组当输入 body 为空", () => {
    const chunks = chunkDocument(makeDoc(""));
    expect(chunks).toHaveLength(0);
  });

  it("应将无 H2 的文本切为一个 parent 下的多个 child", () => {
    const body = "第一段内容。\n\n第二段内容。\n\n第三段内容。";
    const chunks = chunkDocument(makeDoc(body));

    expect(chunks.length).toBeGreaterThan(0);
    // 所有 chunk 应属于同一 parent（parent_index = 0）
    for (const c of chunks) {
      expect(c.parent_index).toBe(0);
      expect(c.doc_id).toBe("card_test");
      expect(c.doc_source).toBe("card");
    }
    // child_index 应从 0 递增
    const indices = chunks.map((c) => c.child_index);
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBe(i);
    }
  });

  it("应正确生成 chunk ID", () => {
    const body = "段落A。\n\n段落B。";
    const chunks = chunkDocument(makeDoc(body));

    expect(chunks.length).toBeGreaterThan(0);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.id).toBe(String(i));
    }
  });

  it("所有 chunk 应有相同的 indexed_at 时间戳", () => {
    const body = "段落A。\n\n段落B。";
    const chunks = chunkDocument(makeDoc(body));

    expect(chunks.length).toBeGreaterThan(0);
    const timestamps = new Set(chunks.map((c) => c.indexed_at));
    expect(timestamps.size).toBe(1);
  });

  it("doc_source 应正确传递", () => {
    const doc = makeDoc("测试内容。");
    const chunks = chunkDocument(doc);

    for (const c of chunks) {
      expect(c.doc_source).toBe("card");
      expect(c.doc_path).toBe("card_test");
    }
  });

  it("长文本应被切分为多个 child chunk", () => {
    // 构造一个超过 target 的文本
    const longText = Array.from({ length: 100 }, (_, i) => `这是第${i + 1}段测试内容。`).join(
      "\n\n",
    );
    const chunks = chunkDocument(makeDoc(longText));

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("每个 child 的 parent_text 应与其 parent 相同", () => {
    const body = "段落A。\n\n段落B。";
    const chunks = chunkDocument(makeDoc(body));

    const parentTexts = new Map<number, string>();
    for (const c of chunks) {
      if (parentTexts.has(c.parent_index)) {
        expect(c.parent_text).toBe(parentTexts.get(c.parent_index));
      } else {
        parentTexts.set(c.parent_index, c.parent_text);
      }
    }
  });
});
