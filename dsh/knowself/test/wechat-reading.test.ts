import { describe, expect, it } from "vitest";
import { buildReadingPrompt, formatReadingForPrompt, parseReading, type Reading } from "../src/wechat-reading.js";

function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    intent: "question",
    presupposition: "",
    presupposition_holds: true,
    challenges_my_last_line: false,
    must_answer: false,
    needs_realtime_state: false,
    ...overrides,
  };
}

describe("parseReading", () => {
  it("parses the reading JSON even when the model wraps it in prose", () => {
    const raw = `好的，我读懂了：
{"intent":"challenge","presupposition":"我有作业要写","presupposition_holds":false,"challenges_my_last_line":true,"must_answer":true,"needs_realtime_state":false}
以上。`;
    const parsed = parseReading(raw);
    expect(parsed?.intent).toBe("challenge");
    expect(parsed?.presupposition).toBe("我有作业要写");
    expect(parsed?.presupposition_holds).toBe(false);
    expect(parsed?.challenges_my_last_line).toBe(true);
  });

  it("returns null when intent is missing or unknown", () => {
    expect(parseReading('{"presupposition":"x"}')).toBeNull();
    expect(parseReading('{"intent":"dance"}')).toBeNull();
    expect(parseReading("not json at all")).toBeNull();
    expect(parseReading("")).toBeNull();
  });

  it("treats an empty presupposition as holding, so it cannot look like a conflict", () => {
    const parsed = parseReading('{"intent":"share","presupposition":"","presupposition_holds":false}');
    expect(parsed?.presupposition).toBe("");
    expect(parsed?.presupposition_holds).toBe(true);
  });

  it("defaults must_answer to true for questions and challenges", () => {
    expect(parseReading('{"intent":"question"}')?.must_answer).toBe(true);
    expect(parseReading('{"intent":"challenge"}')?.must_answer).toBe(true);
    expect(parseReading('{"intent":"joke"}')?.must_answer).toBe(false);
  });
});

describe("buildReadingPrompt", () => {
  it("tells the model that a 'saw' fact is not something I did", () => {
    const prompt = buildReadingPrompt({
      inbound: "你不是不考公？",
      recent: [{ role: "them", content: "考公资料发过来一下" }],
      facts: [{ text: "建阳税务局招三个人", kind: "saw" }],
      lastOwnLine: "刷着刷着就刷到考公的了 晦气",
    });
    expect(prompt.system).toContain("看到的信息");
    expect(prompt.user).toContain("建阳税务局招三个人");
    expect(prompt.user).toContain("不是我做过的事");
    expect(prompt.user).toContain("我上一句");
  });

  it("marks a missing last line instead of inventing one", () => {
    const prompt = buildReadingPrompt({ inbound: "在吗", recent: [], facts: [], lastOwnLine: null });
    expect(prompt.user).toContain("还没开口");
    expect(prompt.user).toContain("暂无已确认的事实");
  });
});

describe("formatReadingForPrompt", () => {
  it("turns a false presupposition into a hard instruction", () => {
    const text = formatReadingForPrompt(
      reading({ intent: "challenge", presupposition: "我有作业要写", presupposition_holds: false }),
    );
    expect(text).toContain("「我有作业要写」");
    expect(text).toContain("不许顺着它往下演");
  });

  it("asks for substance when the contact is pushing", () => {
    const text = formatReadingForPrompt(reading({ must_answer: true }));
    expect(text).toContain("必须给出实质内容");
    expect(text).toContain("晚点再说");
  });

  it("bans inventing realtime state when none is known", () => {
    const text = formatReadingForPrompt(reading({ needs_realtime_state: true }));
    expect(text).toContain("绝不给具体状态");
  });

  it("returns an empty string when there is nothing to constrain", () => {
    expect(formatReadingForPrompt(reading({ intent: "share", must_answer: false }))).toBe("");
  });
});
