import { describe, expect, it } from "vitest";
import {
  buildIdentityExtractionPrompt,
  formatIdentityStatesForPrompt,
  parseIdentityStates,
} from "../src/identity-timeline.js";

describe("parseIdentityStates", () => {
  it("keeps entries that carry a quote from my own words", () => {
    const raw = `[
      {"category":"enrollment","text":"还在念书","source_quote":"还不如专心那学业搞好"},
      {"category":"work","text":"在找工作","source_quote":"翻翻招聘信息 投简历"}
    ]`;
    const states = parseIdentityStates(raw);
    expect(states).toHaveLength(2);
    expect(states[0]?.category).toBe("enrollment");
    expect(states[1]?.text).toBe("在找工作");
  });

  it("drops entries without a source quote — this is the anti-fabrication gate", () => {
    // 真实事故：模型凭空编了「我早不读了」和「在家投简历」，两句都没有原文依据。
    const raw = `[
      {"category":"enrollment","text":"早不读了","source_quote":""},
      {"category":"work","text":"在家待业"}
    ]`;
    expect(parseIdentityStates(raw)).toEqual([]);
  });

  it("dedupes the same category+text and caps the batch", () => {
    const raw = `[
      {"category":"work","text":"在找工作","source_quote":"投简历"},
      {"category":"work","text":"在找工作","source_quote":"翻招聘信息"}
    ]`;
    expect(parseIdentityStates(raw)).toHaveLength(1);
  });

  it("falls back to 'other' for unknown categories", () => {
    const raw = `[{"category":"whatever","text":"搬到泉州了","source_quote":"我搬去泉州了"}]`;
    expect(parseIdentityStates(raw)[0]?.category).toBe("other");
  });

  it("returns [] for garbage", () => {
    expect(parseIdentityStates("no array here")).toEqual([]);
    expect(parseIdentityStates("[{bad json")).toEqual([]);
    expect(parseIdentityStates("[]")).toEqual([]);
  });
});

describe("buildIdentityExtractionPrompt", () => {
  it("only feeds my own messages and forbids third-person phrasing", () => {
    const prompt = buildIdentityExtractionPrompt([
      { role: "them", text: "我当时已经毕业了啊" },
      { role: "me", text: "还不如专心那学业搞好，毕业找工作" },
    ]);
    expect(prompt.user).toContain("还不如专心那学业搞好");
    expect(prompt.user).not.toContain("我当时已经毕业了");
    expect(prompt.system).toContain("对方说「我毕业了」说的是对方，不要收");
    expect(prompt.system).toContain("不要写成「用户……」");
  });
});

describe("formatIdentityStatesForPrompt", () => {
  it("orders enrollment before work and keeps the quote", () => {
    const text = formatIdentityStatesForPrompt([
      { category: "work", text: "在找工作", source_quote: "投简历" },
      { category: "enrollment", text: "在读", source_quote: "学业" },
    ]);
    expect(text.indexOf("在读")).toBeLessThan(text.indexOf("在找工作"));
    expect(text).toContain("原话「投简历」");
  });

  it("returns an empty string with no states", () => {
    expect(formatIdentityStatesForPrompt([])).toBe("");
  });
});
