import { describe, it, expect } from "vitest";
import {
  EventKindSchema,
  SentimentLabelSchema,
  EventCandidateSchema,
  SemanticSentimentSchema,
  SemanticExtractOutputSchema,
  SentimentSessionSchema,
} from "../src/semantic";

const candidate = {
  event_kind: "transaction",
  title: "借给张三 2000 元",
  summary: "9 月 1 日转账 2000 元",
  event_date: "2026-09-01",
  date_explicit: true,
  occurred_at: null,
  importance: 4,
  confidence: 0.85,
  evidence: ["wechat:c1:1001"],
};

const output = {
  events: [candidate],
  sentiment: { score: -0.6, confidence: 0.85 },
};

describe("semantic 语义抽取契约", () => {
  it("EventKindSchema 是封闭 8 值枚举", () => {
    expect(EventKindSchema.options).toEqual([
      "meetup",
      "transaction",
      "milestone",
      "health",
      "work",
      "conflict",
      "travel",
      "other",
    ]);
    expect(EventKindSchema.safeParse("party").success).toBe(false);
  });

  it("SentimentLabelSchema 取 3 值（由 score 阈值推导，不由 LLM 填）", () => {
    expect(SentimentLabelSchema.options).toEqual(["positive", "neutral", "negative"]);
  });

  it("EventCandidateSchema 接受事件候选并套用 summary/evidence 默认", () => {
    const parsed = EventCandidateSchema.parse({
      event_kind: "meetup",
      title: "一起吃饭",
      event_date: null,
      date_explicit: false,
      occurred_at: null,
      importance: 3,
      confidence: 0.6,
    });
    expect(parsed.summary).toBe("");
    expect(parsed.evidence).toEqual([]);
  });

  it("EventCandidateSchema 拒绝 >5 条 evidence 与越界 importance", () => {
    expect(
      EventCandidateSchema.safeParse({ ...candidate, evidence: ["a", "b", "c", "d", "e", "f"] })
        .success,
    ).toBe(false);
    expect(EventCandidateSchema.safeParse({ ...candidate, importance: 6 }).success).toBe(false);
  });

  it("SemanticSentimentSchema 只收 score + confidence（label 不给 LLM）", () => {
    expect(SemanticSentimentSchema.parse({ score: 0.2, confidence: 0.5 }).score).toBe(0.2);
    expect(SemanticSentimentSchema.safeParse({ score: 1.4, confidence: 0.5 }).success).toBe(false);
  });

  it("SemanticExtractOutputSchema 接受 §5.3 的 LLM 出参（events ≤5）", () => {
    const parsed = SemanticExtractOutputSchema.parse(output);
    expect(parsed.events[0]!.event_kind).toBe("transaction");
    expect(
      SemanticExtractOutputSchema.safeParse({ ...output, events: new Array(6).fill(candidate) })
        .success,
    ).toBe(false);
  });

  it("SentimentSessionSchema 接受片段级结果（rule / llm 两法）", () => {
    const parsed = SentimentSessionSchema.parse({
      session_key: "sha1:abc",
      person_id: "p_0001",
      score: -0.35,
      label: "negative",
      confidence: 0.62,
      method: "rule",
      samples: 18,
    });
    expect(parsed.method).toBe("rule");
    expect(SentimentSessionSchema.safeParse({ ...parsed, method: "hybrid" }).success).toBe(false);
    expect(SentimentSessionSchema.safeParse({ ...parsed, score: -1.5 }).success).toBe(false);
  });
});
