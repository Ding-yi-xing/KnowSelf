import { describe, expect, it } from "vitest";
import { activeFacts, formatFactsForPrompt, parseFacts, reconcileFacts, serializeFacts, type ReplyFact } from "../src/reply-facts.js";

const NOW = "2026-11-18T12:00:00.000Z";

describe("parseFacts", () => {
  it("reads legacy string arrays without losing anything", () => {
    // 旧库里的 facts_json 是 ["某事实"]，必须能读成 known 事实。
    const facts = parseFacts('["对方在准备考试","对方叫小王"]');
    expect(facts).toEqual([
      { text: "对方在准备考试", kind: "known" },
      { text: "对方叫小王", kind: "known" },
    ]);
  });

  it("keeps kind / quote / validity on structured facts", () => {
    const raw = JSON.stringify([
      { text: "建阳税务局招三个人", kind: "saw", source_quote: "我建阳税务局招三个人", valid_from: NOW },
    ]);
    const [fact] = parseFacts(raw);
    expect(fact?.kind).toBe("saw");
    expect(fact?.source_quote).toBe("我建阳税务局招三个人");
  });

  it("returns an empty list for garbage instead of throwing", () => {
    expect(parseFacts("not json")).toEqual([]);
    expect(parseFacts("")).toEqual([]);
    expect(parseFacts(null)).toEqual([]);
    expect(parseFacts('[{"noText":1}]')).toEqual([]);
  });

  it("round-trips through serialize", () => {
    const facts: ReplyFact[] = [{ text: "在准备软考", kind: "did", valid_from: NOW }];
    expect(parseFacts(serializeFacts(facts))).toEqual(facts);
  });
});

describe("reconcileFacts", () => {
  it("drops exact duplicates", () => {
    const existing: ReplyFact[] = [{ text: "对方在准备考试", kind: "known" }];
    const merged = reconcileFacts(existing, [{ text: "对方在准备考试", kind: "known" }], NOW);
    expect(merged).toHaveLength(1);
  });

  it("invalidates the opposite claim instead of overwriting it", () => {
    // 真实事故：先说「装了」，两分钟后又说「没装」。旧事实要保留但打上失效时间。
    const existing: ReplyFact[] = [{ text: "我装了 harness", kind: "did", valid_from: "2026-11-18T10:12:00.000Z" }];
    const merged = reconcileFacts(existing, [{ text: "我没装 harness", kind: "did", valid_from: NOW }], NOW);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.invalid_at).toBe(NOW);
    expect(merged[1]?.invalid_at).toBeUndefined();
  });

  it("keeps unrelated facts active", () => {
    const existing: ReplyFact[] = [{ text: "对方中午吃鸡腿饭", kind: "known" }];
    const merged = reconcileFacts(existing, [{ text: "我装了 harness", kind: "did" }], NOW);
    expect(merged[0]?.invalid_at).toBeUndefined();
    expect(merged).toHaveLength(2);
  });
});

describe("activeFacts", () => {
  it("drops invalidated facts and keeps the newest ones", () => {
    const all: ReplyFact[] = [
      { text: "旧的", kind: "known", valid_from: "2026-11-17T00:00:00.000Z" },
      { text: "新的", kind: "known", valid_from: "2026-11-18T11:00:00.000Z" },
      { text: "失效的", kind: "known", valid_from: "2026-11-18T10:00:00.000Z", invalid_at: NOW },
    ];
    expect(activeFacts(all, 8).map((fact) => fact.text)).toEqual(["旧的", "新的"]);
    expect(activeFacts(all, 1).map((fact) => fact.text)).toEqual(["新的"]);
  });

  it("keeps facts without a timestamp (legacy) but sorts them last", () => {
    const all: ReplyFact[] = [
      { text: "没有时间", kind: "known" },
      { text: "有时间", kind: "known", valid_from: "2026-11-18T11:00:00.000Z" },
    ];
    expect(activeFacts(all, 8).map((fact) => fact.text)).toEqual(["有时间", "没有时间"]);
  });
});

describe("formatFactsForPrompt", () => {
  it("labels 'saw' facts so they cannot pass as something I did", () => {
    const text = formatFactsForPrompt([
      { text: "建阳税务局招三个人", kind: "saw", source_quote: "我建阳税务局招三个人" },
    ]);
    expect(text).toContain("我看到的消息（不是我做过的事）");
    expect(text).toContain("原话：「我建阳税务局招三个人」");
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(formatFactsForPrompt([])).toBe("");
  });
});
