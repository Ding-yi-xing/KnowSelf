/**
 * build.test.ts — 主流水线集成测试（使用 mock）
 */

import { describe, it, expect } from "vitest";
import type { CoreProfileStored, CardSummary, CardWithSections } from "@knowself/contracts";
import { injectL1 } from "../src/l1-injector";
import { injectL2 } from "../src/l2-injector";

// ─── 辅助函数 ─────────────────────────────────────────────────────────

function makeCore(overrides?: Partial<CoreProfileStored>): CoreProfileStored {
  return {
    display_name: "测试用户",
    locale: "zh-CN",
    section_tags: ["技术", "产品"],
    body: "我是一个全栈开发者，喜欢 TypeScript 和 React。",
    updated_at: "2026-05-27T00:00:00.000Z",
    schema_version: 1,
    ...overrides,
  };
}

function _makeCardSummary(key: string): CardSummary {
  return {
    key,
    title: `卡片 ${key}`,
    summary: `这是 ${key} 的摘要`,
    section_tags: [],
    updated_at: "2026-05-27T00:00:00.000Z",
  };
}

function makeCardWithSections(key: string): CardWithSections {
  return {
    card: {
      key,
      title: `卡片 ${key}`,
      summary: `这是 ${key} 的摘要`,
      section_tags: [],
      updated_at: "2026-05-27T00:00:00.000Z",
      schema_version: 1,
    },
    sections: [
      {
        id: 1,
        card_key: key,
        title: "第1节",
        body: "这是第一节的内容。",
        ord: 0,
        updated_at: "2026-05-27T00:00:00.000Z",
      },
    ],
  };
}

// ─── 测试 ─────────────────────────────────────────────────────────────

describe("injectL1", () => {
  it("应生成 system 角色的 ProviderMessage", () => {
    const core = makeCore();
    const msg = injectL1(core, "openai");

    expect(msg.role).toBe("system");
    expect(msg.content.length).toBeGreaterThan(0);
    expect(msg.content[0]!.kind).toBe("text");
    const text = (msg.content[0] as { kind: "text"; text: string }).text;
    expect(text).toContain("测试用户");
    expect(text).toContain("全栈开发者");
  });

  it("anthropic 协议应带 cache_control", () => {
    const core = makeCore();
    const msg = injectL1(core, "anthropic");

    expect(msg.cache_control).toBeDefined();
    expect(msg.cache_control!.type).toBe("ephemeral");
  });

  it("openai 协议不应带 cache_control", () => {
    const core = makeCore();
    const msg = injectL1(core, "openai");

    expect(msg.cache_control).toBeUndefined();
  });

  it("custom 协议不应带 cache_control", () => {
    const core = makeCore();
    const msg = injectL1(core, "custom");

    expect(msg.cache_control).toBeUndefined();
  });
});

describe("injectL2", () => {
  it("空卡片应返回空数组", () => {
    const msgs = injectL2([], "openai");
    expect(msgs).toHaveLength(0);
  });

  it("应返回与卡片数相等的 messages", () => {
    const cards = [makeCardWithSections("work"), makeCardWithSections("life")];
    const msgs = injectL2(cards, "openai");

    expect(msgs).toHaveLength(2);
    for (const msg of msgs) {
      expect(msg.role).toBe("system");
    }
  });

  it("anthropic 协议应带 cache_control", () => {
    const cards = [makeCardWithSections("work")];
    const msgs = injectL2(cards, "anthropic");

    expect(msgs[0]!.cache_control).toBeDefined();
    expect(msgs[0]!.cache_control!.type).toBe("ephemeral");
  });

  it("注入内容应包含卡片标题", () => {
    const cards = [makeCardWithSections("work")];
    const msgs = injectL2(cards, "openai");

    const text = (msgs[0]!.content[0] as { kind: "text"; text: string }).text;
    expect(text).toContain("卡片 work");
    expect(text).toContain("第1节");
  });
});
