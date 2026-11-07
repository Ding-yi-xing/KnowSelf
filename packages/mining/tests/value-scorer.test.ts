/**
 * ValueScorer / 权重文件测试（DESIGN-12 §6 + §11.1 + §6.3 校验规则）。
 * 全部合成数据（人名只用 张三 / 李四 / 王五），无真实聊天内容。
 */
import { describe, expect, it } from "vitest";
import { RECENCY_TAU_DAYS } from "../src/constants";
import {
  DEFAULT_SCORE_WEIGHTS,
  SCORE_FEATURES,
  ScoreWeightsInvalidError,
  loadScoreWeights,
  parseScoreWeights,
  scorePersons,
  scoreProducedBy,
  type ValueScorerPersonInput,
} from "../src/value-scorer";

const HOUR_24_MS = 86_400_000;

function person(overrides: Partial<ValueScorerPersonInput> = {}): ValueScorerPersonInput {
  return {
    person_id: "person-zhangsan",
    msgCountOther90d: 0,
    daysSinceLastMsg: 0,
    initiativeRatioOther: 0,
    replyLatencyP50Ms: null,
    msgCountMe: 0,
    msgCountOther: 0,
    avgSessionMsgs90d: 0,
    intentDist: {},
    degree: 0,
    ...overrides,
  };
}

function validWeightsJson(overrides: Record<string, number> = {}): string {
  return JSON.stringify({
    version: "score-v1",
    weights: { ...DEFAULT_SCORE_WEIGHTS.weights, ...overrides },
  });
}

describe("parseScoreWeights / scoreProducedBy（§6.3 校验与版本位）", () => {
  it("合法权重文件通过校验，version 与 weights 原样保留", () => {
    const parsed = parseScoreWeights(validWeightsJson());
    expect(parsed.version).toBe("score-v1");
    expect(parsed.weights.f_freq).toBeCloseTo(0.2, 9);
    const sum = SCORE_FEATURES.reduce((acc, key) => acc + parsed.weights[key], 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("权重和 ≠ 1（超出 1e-6 容差）→ SCORE_WEIGHTS_INVALID", () => {
    expect(() => parseScoreWeights(validWeightsJson({ f_freq: 0.5 }))).toThrow(
      ScoreWeightsInvalidError,
    );
    try {
      parseScoreWeights(validWeightsJson({ f_freq: 0.5 }));
    } catch (error) {
      expect((error as ScoreWeightsInvalidError).code).toBe("SCORE_WEIGHTS_INVALID");
    }
  });

  it("容差 1e-6 内的浮点误差仍通过", () => {
    const parsed = parseScoreWeights(
      validWeightsJson({ f_freq: 0.2 + 5e-7, f_recency: 0.2 - 5e-7 }),
    );
    expect(parsed.weights.f_freq).toBeCloseTo(0.2, 6);
  });

  it("未知特征键 / 缺特征键 / 非法 JSON → 拒绝加载", () => {
    expect(() =>
      parseScoreWeights(
        JSON.stringify({
          version: "score-v1",
          weights: { ...DEFAULT_SCORE_WEIGHTS.weights, f_unknown: 0.1 },
        }),
      ),
    ).toThrow(ScoreWeightsInvalidError);
    const missing: Record<string, number> = { ...DEFAULT_SCORE_WEIGHTS.weights };
    delete missing.f_network;
    expect(() =>
      parseScoreWeights(JSON.stringify({ version: "score-v1", weights: missing })),
    ).toThrow(ScoreWeightsInvalidError);
    expect(() => parseScoreWeights("{ not json")).toThrow(ScoreWeightsInvalidError);
  });

  it("版本位：'mining:score-v1+' + sha1(权重文件内容).slice(0,8)，同文本同值", () => {
    const text = validWeightsJson();
    const producedBy = scoreProducedBy(text);
    expect(producedBy).toMatch(/^mining:score-v1\+[0-9a-f]{8}$/);
    expect(scoreProducedBy(text)).toBe(producedBy);
    expect(scoreProducedBy(validWeightsJson({ f_freq: 0.19, f_recency: 0.21 }))).not.toBe(
      producedBy,
    );
  });

  it("loadScoreWeights：文件缺失回退设计默认权重（§6.2）", () => {
    const loaded = loadScoreWeights("data/mining/__not-exists__.json");
    expect(loaded.weights.weights.f_freq).toBeCloseTo(0.2, 9);
    expect(loaded.producedBy).toMatch(/^mining:score-v1\+[0-9a-f]{8}$/);
  });
});

describe("特征归一化（§6.1 八个特征，全部 ∈ [0,1]）", () => {
  it("全 0 队列：p95=0 / max_deg=0 → 不产生 NaN，八特征全 0", () => {
    // 零互动者：窗口内无消息 → 距今天数必然远大于窗口长度（不能取 0，否则 f_recency=exp(0)=1）
    const result = scorePersons({ persons: [person({ daysSinceLastMsg: 3_650 })] });
    const scored = result.scored[0];
    expect(scored?.value_score).toBeCloseTo(0, 6);
    for (const key of SCORE_FEATURES) {
      expect(scored?.breakdown[key].norm).toBeCloseTo(0, 6);
    }
  });

  it("满分队列（单样本，各项取满）→ value_score = Σw = 1", () => {
    const result = scorePersons({
      persons: [
        person({
          msgCountOther90d: 100,
          daysSinceLastMsg: 0,
          initiativeRatioOther: 1,
          replyLatencyP50Ms: 0,
          msgCountMe: 10,
          msgCountOther: 10,
          avgSessionMsgs90d: 8,
          intentDist: { business: 4 },
          degree: 5,
        }),
      ],
    });
    const scored = result.scored[0];
    for (const key of SCORE_FEATURES) {
      expect(scored?.breakdown[key].norm).toBeCloseTo(1, 9);
    }
    expect(scored?.value_score).toBeCloseTo(1, 9);
  });

  it("f_recency = exp(-d/τ)：d=0 → 1；d=τ → e^-1", () => {
    const result = scorePersons({
      persons: [
        person({ person_id: "person-a", daysSinceLastMsg: 0 }),
        person({ person_id: "person-b", daysSinceLastMsg: RECENCY_TAU_DAYS }),
      ],
    });
    const byId = new Map(result.scored.map((s) => [s.person_id, s]));
    expect(byId.get("person-a")?.breakdown.f_recency.norm).toBeCloseTo(1, 9);
    expect(byId.get("person-b")?.breakdown.f_recency.norm).toBeCloseTo(Math.exp(-1), 9);
  });

  it("f_responsiveness：0ms → 1；24h → 0；超过 24h 截断到 0；无样本 → 0", () => {
    const result = scorePersons({
      persons: [
        person({ person_id: "person-a", replyLatencyP50Ms: 0 }),
        person({ person_id: "person-b", replyLatencyP50Ms: HOUR_24_MS }),
        person({ person_id: "person-c", replyLatencyP50Ms: HOUR_24_MS * 3 }),
        person({ person_id: "person-d", replyLatencyP50Ms: null }),
      ],
    });
    const byId = new Map(result.scored.map((s) => [s.person_id, s]));
    expect(byId.get("person-a")?.breakdown.f_responsiveness.norm).toBeCloseTo(1, 9);
    expect(byId.get("person-b")?.breakdown.f_responsiveness.norm).toBeCloseTo(0, 9);
    expect(byId.get("person-c")?.breakdown.f_responsiveness.norm).toBe(0);
    expect(byId.get("person-d")?.breakdown.f_responsiveness.norm).toBe(0);
    expect(byId.get("person-d")?.breakdown.f_responsiveness.raw).toBeNull();
  });

  it("f_reciprocity = 1 - |a-b|/(a+b)：均衡 → 1；双向为 0 → 0", () => {
    const result = scorePersons({
      persons: [
        person({ person_id: "person-a", msgCountMe: 10, msgCountOther: 10 }),
        person({ person_id: "person-b", msgCountMe: 10, msgCountOther: 0 }),
        person({ person_id: "person-c", msgCountMe: 0, msgCountOther: 0 }),
      ],
    });
    const byId = new Map(result.scored.map((s) => [s.person_id, s]));
    expect(byId.get("person-a")?.breakdown.f_reciprocity.norm).toBeCloseTo(1, 9);
    expect(byId.get("person-b")?.breakdown.f_reciprocity.norm).toBe(0);
    expect(byId.get("person-c")?.breakdown.f_reciprocity.norm).toBe(0);
  });

  it("f_freq / f_depth 按 p95 归一化并截断到 1", () => {
    const persons = Array.from({ length: 20 }, (_, i) =>
      person({
        person_id: `person-${String(i).padStart(2, "0")}`,
        msgCountOther90d: (i + 1) * 10,
      }),
    );
    const result = scorePersons({ persons });
    for (const scored of result.scored) {
      expect(scored.breakdown.f_freq.norm).toBeGreaterThanOrEqual(0);
      expect(scored.breakdown.f_freq.norm).toBeLessThanOrEqual(1);
    }
    const top = result.scored.find((s) => s.person_id === "person-19");
    expect(top?.breakdown.f_freq.norm).toBe(1); // 超过 p95 → 截断到 1
  });

  it("f_business = (business + after_sales + finance) / 总意图数", () => {
    const result = scorePersons({
      persons: [
        person({ person_id: "person-a", intentDist: { business: 3, social: 1 } }),
        person({ person_id: "person-b", intentDist: { social: 4 } }),
        person({ person_id: "person-c", intentDist: {} }),
      ],
    });
    const byId = new Map(result.scored.map((s) => [s.person_id, s]));
    expect(byId.get("person-a")?.breakdown.f_business.norm).toBeCloseTo(0.75, 9);
    expect(byId.get("person-b")?.breakdown.f_business.norm).toBe(0);
    expect(byId.get("person-c")?.breakdown.f_business.norm).toBe(0);
  });

  it("f_network = deg / max_deg", () => {
    const result = scorePersons({
      persons: [
        person({ person_id: "person-a", degree: 4 }),
        person({ person_id: "person-b", degree: 2 }),
      ],
    });
    const byId = new Map(result.scored.map((s) => [s.person_id, s]));
    expect(byId.get("person-a")?.breakdown.f_network.norm).toBe(1);
    expect(byId.get("person-b")?.breakdown.f_network.norm).toBeCloseTo(0.5, 9);
  });
});

describe("打分与排名（§6.2）", () => {
  it("value_rank 降序 1..N；并列时按 person_id 字典序且可复现", () => {
    const tie = {
      msgCountOther90d: 50,
      daysSinceLastMsg: 3,
      msgCountMe: 5,
      msgCountOther: 5,
      degree: 2,
    };
    const input = {
      persons: [
        person({ person_id: "person-lisi", ...tie }),
        person({ person_id: "person-zhangsan", ...tie }),
        person({ person_id: "person-wangwu", msgCountOther90d: 10 }),
      ],
    };
    const first = scorePersons(input);
    const second = scorePersons(input);
    const rankOf = (result: typeof first, id: string): number | undefined =>
      result.scored.find((s) => s.person_id === id)?.value_rank;
    // 并列两人分数相同 → 字典序在前的 rank 更小
    expect(rankOf(first, "person-lisi")).toBe(1);
    expect(rankOf(first, "person-zhangsan")).toBe(2);
    expect(rankOf(first, "person-wangwu")).toBe(3);
    expect(second.scored.map((s) => `${s.person_id}:${s.value_rank}`)).toEqual(
      first.scored.map((s) => `${s.person_id}:${s.value_rank}`),
    );
  });
});

describe("输出行（§6.4）", () => {
  it("每人 3 行：value_score / value_rank / value_score_breakdown", () => {
    const result = scorePersons({
      persons: [person({ person_id: "person-zhangsan", msgCountOther90d: 30, degree: 1 })],
      now: "2026-09-22T10:00:00+08:00",
    });
    const keys = result.rows.map((row) => row.metric_key);
    expect(keys).toEqual(["value_score", "value_rank", "value_score_breakdown"]);
    const score = result.rows.find((row) => row.metric_key === "value_score");
    const rank = result.rows.find((row) => row.metric_key === "value_rank");
    const breakdown = result.rows.find((row) => row.metric_key === "value_score_breakdown");
    expect(score?.metric_value).toBeGreaterThanOrEqual(0);
    expect(score?.metric_value).toBeLessThanOrEqual(1);
    expect(score?.metric_value_json).toBeNull();
    expect(score?.metric_unit).toBe("score");
    expect(rank?.metric_value).toBe(1);
    expect(rank?.metric_unit).toBe("rank");
    expect(breakdown?.metric_value).toBeNull();
    const parsed = JSON.parse(String(breakdown?.metric_value_json)) as Record<
      string,
      { raw: number | null; norm: number; weight: number; contrib: number }
    >;
    expect(Object.keys(parsed).sort()).toEqual([...SCORE_FEATURES].sort());
    for (const key of SCORE_FEATURES) {
      const entry = parsed[key];
      expect(entry?.weight).toBeCloseTo(DEFAULT_SCORE_WEIGHTS.weights[key], 9);
      expect(entry?.contrib).toBeCloseTo((entry?.norm ?? 0) * (entry?.weight ?? 0), 9);
    }
    for (const row of result.rows) {
      expect(row.scope_kind).toBe("global");
      expect(row.produced_by).toMatch(/^mining:score-v1\+[0-9a-f]{8}$/);
      expect(row.computed_at).toBe("2026-09-22T10:00:00+08:00");
    }
  });
});
