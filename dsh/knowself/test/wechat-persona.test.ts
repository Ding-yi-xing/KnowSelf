import { describe, expect, it } from "vitest";
import { buildReplyPersona, deserializeReplyPersona, REPLY_PERSONA_VERSION, formatPersonaForPrompt } from "../src/wechat-persona.js";
import type { ChatChunk, ChatOptions } from "@knowself/contracts";

function generator(text: string): (options: ChatOptions, signal: AbortSignal) => AsyncIterable<ChatChunk> {
  return async function* () { yield { type: "text", delta: text }; };
}

const messages = [
  { role: "them" as const, text: "你怎么又不回我" },
  { role: "me" as const, text: "刚在忙，别生气" },
  { role: "them" as const, text: "哼" },
  { role: "me" as const, text: "晚上给你带奶茶" },
];

const validJson = `好的，这是画像：
{
  "target": {
    "summary": "嘴硬心软的女生",
    "traits": ["要面子", "敏感"],
    "psychology": ["怕被忽略"],
    "communication": ["先共情再讲道理"],
    "taboos": ["不要敷衍"],
    "relationship": "暧昧期"
  },
  "voice": {
    "tone": "轻松带点哄",
    "length": "10-25 字",
    "habits": ["会用哈哈"],
    "addressing": "宝"
  }
}`;

describe("buildReplyPersona", () => {
  it("parses structured persona JSON out of surrounding prose", async () => {
    const persona = await buildReplyPersona({
      contact_label: "宝宝",
      messages,
      provider_id: "p",
      model_id: "m",
      generate: generator(validJson),
      signal: new AbortController().signal,
      now: () => new Date("2026-11-16T10:00:00.000Z"),
    });
    expect(persona?.degraded).toBe(false);
    expect(persona?.target.traits).toEqual(["要面子", "敏感"]);
    expect(persona?.voice.addressing).toBe("宝");
    expect(persona?.source_messages).toBe(4);
  });

  it("falls back to degraded summary when the model returns non-JSON", async () => {
    const persona = await buildReplyPersona({
      contact_label: "宝宝", messages, provider_id: "p", model_id: "m",
      generate: generator("她看起来有点敏感"), signal: new AbortController().signal,
    });
    expect(persona?.degraded).toBe(true);
    expect(persona?.target.summary).toContain("敏感");
  });

  it("returns null when there is not enough history", async () => {
    const persona = await buildReplyPersona({
      contact_label: "宝宝", messages: messages.slice(0, 2), provider_id: "p", model_id: "m",
      generate: generator(validJson), signal: new AbortController().signal,
    });
    expect(persona).toBeNull();
  });

  it("formats persona fields into prompt lines", async () => {
    const persona = await buildReplyPersona({
      contact_label: "宝宝", messages, provider_id: "p", model_id: "m",
      generate: generator(validJson), signal: new AbortController().signal,
    });
    const text = formatPersonaForPrompt(persona);
    expect(text).toContain("嘴硬心软的女生");
    expect(text).toContain("要面子");
    expect(text).toContain("先共情再讲道理");
    expect(formatPersonaForPrompt(null)).toBe("");
  });

  it("deserializes a persisted persona payload and rejects garbage", () => {
    const persisted = JSON.stringify({
      target: { summary: "嘴硬心软", traits: ["要面子"], psychology: [], communication: [], taboos: [], relationship: "暧昧" },
      voice: { tone: "轻松", length: "15 字", habits: [], addressing: "宝" },
      generated_at: "2026-11-16T10:00:00.000Z",
      source_messages: 120,
      degraded: false,
    });
    const persona = deserializeReplyPersona(persisted);
    expect(persona?.target.traits).toEqual(["要面子"]);
    expect(persona?.source_messages).toBe(120);
    expect(deserializeReplyPersona("not json")).toBeNull();
    expect(deserializeReplyPersona('{"target":"x","voice":{}}')).toBeNull();
  });

  it("parses the ex-skill style voice fields and renders them", async () => {
    const json = `{"target":{"summary":"","traits":[],"psychology":[],"communication":[],"taboos":[],"relationship":""},"voice":{"tone":"直接","length":"5 字","habits":[],"addressing":"你","particles":["嗯","哦"],"punctuation":"几乎不用句号，两句之间用空格","message_format":"一次只发一句","examples":["对方：在干嘛 / 我：没干嘛","对方：想你 / 我：滚"]}}`;
    const persona = await buildReplyPersona({
      contact_label: "x", messages, provider_id: "p", model_id: "m",
      generate: generator(json), signal: new AbortController().signal,
    });
    expect(persona?.voice.particles).toEqual(["嗯", "哦"]);
    expect(persona?.voice.punctuation).toContain("不用句号");
    expect(persona?.voice.examples).toHaveLength(2);
    const text = formatPersonaForPrompt(persona);
    expect(text).toContain("语气词：嗯、哦");
    expect(text).toContain("标点/断句");
    expect(text).toContain("我平时这么说话");
    expect(text).toContain("我：滚");
  });

  it("renders user corrections with the highest priority", async () => {
    const json = `{"target":{"summary":"","traits":[],"psychology":[],"communication":[],"taboos":[],"relationship":""},"voice":{"tone":"","length":"","habits":[],"addressing":""}}`;
    const persona = await buildReplyPersona({
      contact_label: "x", messages, provider_id: "p", model_id: "m",
      generate: generator(json), signal: new AbortController().signal,
    });
    const text = formatPersonaForPrompt({
      ...persona!,
      corrections: [{ layer: "Layer 2", wrong: "太正式", right: "我一般说「行吧」", at: "2026-11-18T00:00:00.000Z" }],
    });
    expect(text).toContain("用户亲自纠正过的");
    expect(text).toContain("「太正式」是错的，应该是「我一般说「行吧」」");
  });

  it("gives the model the measured message length instead of letting it guess", async () => {
    const long = [
      { role: "them" as const, text: "在干嘛" },
      { role: "me" as const, text: "在天" },
      { role: "me" as const, text: "在吃" },
      { role: "me" as const, text: "刚回来" },
      { role: "me" as const, text: "还没" },
      { role: "me" as const, text: "在忙" },
    ];
    const prompts: string[] = [];
    await buildReplyPersona({
      contact_label: "x", messages: long, provider_id: "p", model_id: "m",
      signal: new AbortController().signal,
      generate: async function* (options: ChatOptions) {
        prompts.push(
          options.messages[options.messages.length - 1]?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "",
        );
        yield { type: "text", delta: validJson };
      },
    });
    expect(prompts[0]).toContain("实测");
    expect(prompts[0]).toContain("中位");
  });

  it("measures the user's emoji rate and repertoire from my messages only", async () => {
    // 对方发的表情必须不进统计：这里 them 发了 5 个 [哈哈]，不应影响 rate/repertoire。
    const mine = Array.from({ length: 18 }, (_, index) => ({ role: "me" as const, text: `第${index}条` }));
    const theirs = Array.from({ length: 5 }, () => ({ role: "them" as const, text: "哈哈[哈哈]" }));
    const withEmoji = [
      ...mine,
      ...theirs,
      { role: "me" as const, text: "行吧[旺柴]" },
      { role: "me" as const, text: "真的🧐" },
    ];
    const persona = await buildReplyPersona({
      contact_label: "x", messages: withEmoji, provider_id: "p", model_id: "m",
      generate: generator(validJson), signal: new AbortController().signal,
    });
    expect(persona?.voice.emoji?.rate).toBe(0.1); // 2/20，对方的 5 个 [哈哈] 没有混入
    expect(persona?.voice.emoji?.messages).toBe(20);
    expect(persona?.voice.emoji?.total).toBe(2);
    // 🧐 只出现一次 → 不进常驻库；[旺柴] 也才 1 次，所以库是空的。
    expect(persona?.voice.emoji?.repertoire).toEqual([]);
  });

  it("excludes placeholder messages like [图片] from the denominator", async () => {
    const mine = Array.from({ length: 18 }, (_, index) => ({ role: "me" as const, text: `第${index}条` }));
    const withEmoji = [
      ...mine,
      { role: "me" as const, text: "[图片]" },   // 占位，不计入分母
      { role: "me" as const, text: "[语音]" },   // 占位，不计入分母
      { role: "me" as const, text: "行吧[旺柴]" },
      { role: "me" as const, text: "走了[旺柴]" },
    ];
    const persona = await buildReplyPersona({
      contact_label: "x", messages: withEmoji, provider_id: "p", model_id: "m",
      generate: generator(validJson), signal: new AbortController().signal,
    });
    expect(persona?.voice.emoji?.messages).toBe(20); // 18 + 2 带表情的，2 条占位被排除
    expect(persona?.voice.emoji?.rate).toBe(0.1);
    expect(persona?.voice.emoji?.repertoire).toEqual(["[旺柴]"]);
  });

  it("keeps emoji used at least twice in the repertoire", async () => {
    const mine = Array.from({ length: 20 }, (_, index) => ({ role: "me" as const, text: `第${index}条` }));
    const withEmoji = [
      ...mine,
      { role: "me" as const, text: "行吧[旺柴]" },
      { role: "me" as const, text: "走了[旺柴]" },
    ];
    const persona = await buildReplyPersona({
      contact_label: "x", messages: withEmoji, provider_id: "p", model_id: "m",
      generate: generator(validJson), signal: new AbortController().signal,
    });
    expect(persona?.voice.emoji?.repertoire).toEqual(["[旺柴]"]);
  });

  it("stamps the persona version so stale caches are rebuilt", async () => {
    const persona = await buildReplyPersona({
      contact_label: "x", messages, provider_id: "p", model_id: "m",
      generate: generator(validJson), signal: new AbortController().signal,
    });
    expect(persona?.version).toBe(REPLY_PERSONA_VERSION);
    // 旧口径（把「招聘信息」写成「我报考」）必须触发重建。
    expect(REPLY_PERSONA_VERSION).toBeGreaterThan(1);
  });

  it("tells the model to keep the 'saw it' vs 'did it' distinction", async () => {
    const prompts: string[] = [];
    await buildReplyPersona({
      contact_label: "x", messages, provider_id: "p", model_id: "m",
      signal: new AbortController().signal,
      generate: async function* (options: ChatOptions) {
        prompts.push(options.messages[0]?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
        yield { type: "text", delta: validJson };
      },
    });
    expect(prompts[0]).toContain("我做过");
    expect(prompts[0]).toContain("原文依据");
  });

  it("parses shared memory and renders it into the prompt", async () => {
    const json = `{"target":{"summary":"嘴硬","traits":[],"psychology":[],"communication":[],"taboos":[],"relationship":""},"voice":{"tone":"","length":"","habits":[],"addressing":""},"shared":{"facts":["在准备软考高级"],"timeline":["11-14 面试挂了"],"people":["班长"]}}`;
    const persona = await buildReplyPersona({
      contact_label: "x", messages, provider_id: "p", model_id: "m",
      generate: generator(json), signal: new AbortController().signal,
    });
    expect(persona?.shared?.facts).toEqual(["在准备软考高级"]);
    const text = formatPersonaForPrompt(persona);
    expect(text).toContain("共同记忆");
    expect(text).toContain("在准备软考高级");
    expect(text).toContain("11-14 面试挂了");
    expect(text).toContain("班长");
  });
});
