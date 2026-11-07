/**
 * `ValueScorer`（DESIGN-12 §6）：8 特征价值打分 + 可调权重 + 排名。
 * 特征全部归一化到 `[0,1]`（§6.1）；`value_score = Σ w_i · f_i`；`value_rank` 同 scope 内降序
 * （并列按 `person_id` 字典序，保证确定性）。
 * 归一化基准（p95 / max_deg）在**同批次内**计算——调用方必须整批打分，否则分数不可比。
 * 权重来源：数据文件 `data/mining/score-weights.json`（缺失时回退 §6.2 默认值）；非法即拒绝加载。
 * 版本位（§6.3）：`produced_by = 'mining:score-v1+' + sha1(权重内容).slice(0,8)`——改权重即改版本。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ScopeKind } from "@knowself/contracts";
import type { MetricUpsert, Period } from "@knowself/person-store";
import { RECENCY_TAU_DAYS } from "./constants";
import { percentile } from "./percentile";

export type ScoreFeature =
  | "f_freq"
  | "f_recency"
  | "f_initiative"
  | "f_responsiveness"
  | "f_reciprocity"
  | "f_depth"
  | "f_business"
  | "f_network";

export const SCORE_FEATURES: readonly ScoreFeature[] = [
  "f_freq",
  "f_recency",
  "f_initiative",
  "f_responsiveness",
  "f_reciprocity",
  "f_depth",
  "f_business",
  "f_network",
];

/** 权重文件 schema 版本（§6.3）。 */
export const SCORE_WEIGHTS_VERSION = "score-v1";
/** 权重文件默认位置（§6.3；数据文件，用户可改不改代码）。 */
export const DEFAULT_SCORE_WEIGHTS_FILE = "data/mining/score-weights.json";
/** 权重和容差（§6.3）。 */
const WEIGHT_SUM_TOLERANCE = 1e-6;
/** §6.1 `f_responsiveness` 的归一化上界（24 小时）。 */
const RESPONSIVENESS_CAP_MS = 86_400_000;
/** 商务类意图（§6.1 `f_business` 的分子）。 */
const BUSINESS_INTENTS: readonly string[] = ["business", "after_sales", "finance"];

export interface ScoreWeights {
  readonly version: string;
  readonly weights: Readonly<Record<ScoreFeature, number>>;
}

/** §6.2 默认权重（和 = 1.0）。 */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  version: SCORE_WEIGHTS_VERSION,
  weights: {
    f_freq: 0.2,
    f_recency: 0.2,
    f_initiative: 0.1,
    f_responsiveness: 0.1,
    f_reciprocity: 0.1,
    f_depth: 0.1,
    f_business: 0.1,
    f_network: 0.1,
  },
};

/** 权重文件非法（§6.3 `SCORE_WEIGHTS_INVALID`）。 */
export class ScoreWeightsInvalidError extends Error {
  readonly code = "SCORE_WEIGHTS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ScoreWeightsInvalidError";
  }
}

function canonicalWeightsJson(weights: ScoreWeights): string {
  const ordered: Record<string, number> = {};
  for (const key of SCORE_FEATURES) ordered[key] = weights.weights[key];
  return JSON.stringify({ version: weights.version, weights: ordered });
}

/** 版本位：`'mining:score-v1+' + sha1(权重内容).slice(0,8)`（§6.3）。 */
export function scoreProducedBy(text: string, version: string = SCORE_WEIGHTS_VERSION): string {
  const digest = createHash("sha1").update(text).digest("hex").slice(0, 8);
  return `mining:${version}+${digest}`;
}

/** 解析并校验权重文件（§6.3：和 = 1.0 ± 1e-6；未知键拒绝）。 */
export function parseScoreWeights(text: string): ScoreWeights {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ScoreWeightsInvalidError("权重文件不是合法 JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new ScoreWeightsInvalidError("权重文件顶层必须是对象");
  }
  const candidate = raw as { version?: unknown; weights?: unknown };
  if (typeof candidate.version !== "string" || candidate.version.length === 0) {
    throw new ScoreWeightsInvalidError("权重文件缺少 version");
  }
  if (typeof candidate.weights !== "object" || candidate.weights === null) {
    throw new ScoreWeightsInvalidError("权重文件缺少 weights");
  }
  const rawWeights = candidate.weights as Record<string, unknown>;
  for (const key of Object.keys(rawWeights)) {
    if (!SCORE_FEATURES.includes(key as ScoreFeature)) {
      throw new ScoreWeightsInvalidError(`未知特征键：${key}`);
    }
  }
  const weights = {} as Record<ScoreFeature, number>;
  for (const key of SCORE_FEATURES) {
    const value = rawWeights[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new ScoreWeightsInvalidError(`特征权重非法：${key}`);
    }
    weights[key] = value;
  }
  const sum = SCORE_FEATURES.reduce((acc, key) => acc + weights[key], 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new ScoreWeightsInvalidError(`权重和必须为 1.0 ± 1e-6，实际为 ${sum}`);
  }
  return { version: candidate.version, weights };
}

export interface LoadedScoreWeights {
  readonly weights: ScoreWeights;
  readonly producedBy: string;
}

/** 加载权重文件；文件缺失回退 §6.2 默认值，文件非法则抛 `ScoreWeightsInvalidError`。 */
export function loadScoreWeights(
  filePath: string = DEFAULT_SCORE_WEIGHTS_FILE,
): LoadedScoreWeights {
  let text: string | null = null;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    text = null;
  }
  if (text === null) {
    return {
      weights: DEFAULT_SCORE_WEIGHTS,
      producedBy: scoreProducedBy(canonicalWeightsJson(DEFAULT_SCORE_WEIGHTS)),
    };
  }
  const weights = parseScoreWeights(text);
  return { weights, producedBy: scoreProducedBy(text, weights.version) };
}

export interface ValueScorerPersonInput {
  readonly person_id: string;
  /** §6.1 f_freq 原始值：近 90 天 `msg_count_other`。 */
  readonly msgCountOther90d: number;
  /** §6.1 f_recency 原始值：距今天数 `d`。 */
  readonly daysSinceLastMsg: number;
  /** §6.1 f_initiative 原始值：近 90 天 `initiative_ratio_other`。 */
  readonly initiativeRatioOther: number;
  /** §6.1 f_responsiveness 原始值：`reply_latency_p50_ms`（对方→我）；无样本传 `null`。 */
  readonly replyLatencyP50Ms: number | null;
  readonly msgCountMe: number;
  readonly msgCountOther: number;
  /** §6.1 f_depth 原始值：近 90 天片段平均消息数。 */
  readonly avgSessionMsgs90d: number;
  /** §6.1 f_business 原始值：意图分布（`intent_dist`）。 */
  readonly intentDist: Readonly<Record<string, number>>;
  /** §6.1 f_network 原始值：共现网络度中心性。 */
  readonly degree: number;
}

/** 特征分解条目（§6.3 `value_score_breakdown`）。 */
export interface FeatureBreakdown {
  /** 原始值；无样本为 `null`（如 `f_responsiveness` 无回复延迟样本）。 */
  readonly raw: number | null;
  readonly norm: number;
  readonly weight: number;
  readonly contrib: number;
}

export interface ScoredPerson {
  readonly person_id: string;
  readonly value_score: number;
  readonly value_rank: number;
  readonly breakdown: Readonly<Record<ScoreFeature, FeatureBreakdown>>;
}

export interface ValueScorerInput {
  readonly persons: readonly ValueScorerPersonInput[];
  readonly weights?: ScoreWeights;
  /** 版本位；缺省由权重内容计算（§6.3）。 */
  readonly producedBy?: string;
  readonly now?: string;
  readonly scopeKind?: ScopeKind;
  readonly scopeId?: string;
  readonly period?: Period;
  readonly periodKey?: string;
}

export interface ValueScorerResult {
  /** 按 `value_rank` 升序（并列按 `person_id` 字典序）。 */
  readonly scored: readonly ScoredPerson[];
  /** 每人 3 行：`value_score` / `value_rank` / `value_score_breakdown`（§6.4）。 */
  readonly rows: readonly MetricUpsert[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** `log1p(x)/log1p(p95)` 截断到 1；`p95 ≤ 0` 或 `x ≤ 0` → 0（全 0 队列不产生 NaN）。 */
function normalizeLogP95(value: number, p95: number): number {
  if (!(p95 > 0) || !(value > 0)) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(p95));
}

interface NormalizationContext {
  readonly p95Freq: number;
  readonly p95Depth: number;
  readonly maxDeg: number;
}

function computeFeatures(
  person: ValueScorerPersonInput,
  context: NormalizationContext,
): Record<ScoreFeature, { raw: number | null; norm: number }> {
  const reciprocityTotal = person.msgCountMe + person.msgCountOther;
  const businessCount = BUSINESS_INTENTS.reduce(
    (acc, key) => acc + (person.intentDist[key] ?? 0),
    0,
  );
  const intentTotal = Object.values(person.intentDist).reduce((acc, value) => acc + value, 0);
  return {
    f_freq: {
      raw: person.msgCountOther90d,
      norm: normalizeLogP95(person.msgCountOther90d, context.p95Freq),
    },
    f_recency: {
      raw: person.daysSinceLastMsg,
      norm: clamp01(Math.exp(-person.daysSinceLastMsg / RECENCY_TAU_DAYS)),
    },
    f_initiative: {
      raw: person.initiativeRatioOther,
      norm: clamp01(person.initiativeRatioOther),
    },
    f_responsiveness: {
      raw: person.replyLatencyP50Ms,
      norm:
        person.replyLatencyP50Ms === null
          ? 0 // 无样本 → 不给分（附录 B #7 不猜）
          : clamp01(
              1 -
                Math.min(
                  1,
                  Math.log1p(Math.max(0, person.replyLatencyP50Ms)) /
                    Math.log1p(RESPONSIVENESS_CAP_MS),
                ),
            ),
    },
    f_reciprocity: {
      raw: reciprocityTotal === 0 ? null : reciprocityTotal,
      norm:
        reciprocityTotal === 0
          ? 0
          : clamp01(
              1 - Math.abs(person.msgCountMe - person.msgCountOther) / reciprocityTotal,
            ),
    },
    f_depth: {
      raw: person.avgSessionMsgs90d,
      norm: normalizeLogP95(person.avgSessionMsgs90d, context.p95Depth),
    },
    f_business: {
      raw: intentTotal === 0 ? null : businessCount,
      norm: intentTotal === 0 ? 0 : clamp01(businessCount / intentTotal),
    },
    f_network: {
      raw: person.degree,
      norm: context.maxDeg === 0 ? 0 : clamp01(person.degree / context.maxDeg),
    },
  };
}

function byKeyAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function scorePersons(input: ValueScorerInput): ValueScorerResult {
  const weights = input.weights ?? DEFAULT_SCORE_WEIGHTS;
  const producedBy =
    input.producedBy ?? scoreProducedBy(canonicalWeightsJson(weights), weights.version);
  const now = input.now ?? new Date().toISOString();
  const scopeKind: ScopeKind = input.scopeKind ?? "global";
  const scopeId = input.scopeId ?? "";
  const period: Period = input.period ?? "all";
  const periodKey = input.periodKey ?? "";

  const context: NormalizationContext = {
    p95Freq:
      percentile(
        input.persons.map((p) => p.msgCountOther90d).sort((a, b) => a - b),
        0.95,
      ) ?? 0,
    p95Depth:
      percentile(
        input.persons.map((p) => p.avgSessionMsgs90d).sort((a, b) => a - b),
        0.95,
      ) ?? 0,
    maxDeg: input.persons.reduce((max, p) => Math.max(max, p.degree), 0),
  };

  const unranked = input.persons.map((person) => {
    const features = computeFeatures(person, context);
    const breakdown = {} as Record<ScoreFeature, FeatureBreakdown>;
    let score = 0;
    for (const key of SCORE_FEATURES) {
      const weight = weights.weights[key];
      const feature = features[key];
      const contrib = feature.norm * weight;
      breakdown[key] = {
        raw: feature.raw,
        norm: feature.norm,
        weight,
        contrib,
      };
      score += contrib;
    }
    return { person_id: person.person_id, value_score: clamp01(score), breakdown };
  });

  // §6.2：降序排名，并列按 person_id 字典序（确定性）
  const order = [...unranked].sort(
    (a, b) => b.value_score - a.value_score || byKeyAsc(a.person_id, b.person_id),
  );
  const rankById = new Map(order.map((entry, index) => [entry.person_id, index + 1]));
  const scored: ScoredPerson[] = order.map((entry) => ({
    person_id: entry.person_id,
    value_score: entry.value_score,
    value_rank: rankById.get(entry.person_id) ?? 0,
    breakdown: entry.breakdown,
  }));

  const rows: MetricUpsert[] = [];
  for (const entry of scored) {
    const base = {
      person_id: entry.person_id,
      scope_kind: scopeKind,
      scope_id: scopeId,
      period,
      period_key: periodKey,
      produced_by: producedBy,
      computed_at: now,
    };
    rows.push({
      ...base,
      metric_key: "value_score",
      metric_value: entry.value_score,
      metric_value_json: null,
      metric_unit: "score",
    });
    rows.push({
      ...base,
      metric_key: "value_rank",
      metric_value: entry.value_rank,
      metric_value_json: null,
      metric_unit: "rank",
    });
    rows.push({
      ...base,
      metric_key: "value_score_breakdown",
      metric_value: null,
      metric_value_json: JSON.stringify(entry.breakdown),
      metric_unit: "json",
    });
  }

  return { scored, rows };
}

/** `ValueScorer` 别名（DESIGN-12 §12 P1-6 命名）。 */
export const ValueScorer = {
  score: scorePersons,
  parseWeights: parseScoreWeights,
  loadWeights: loadScoreWeights,
};
