/**
 * 指标编排层（DESIGN-12 §3.5 指标字典 / §3.7 粒度矩阵 / §3.3 各族公式）。
 * 把 `SessionSegmenter` / `FrequencyCounter` / `DurationCalculator` / `InitiativeCalculator` /
 * `ReplyLatencyCalculator` / `Percentile` 的纯组件输出翻译成 `person_metrics` 行。
 * 本模块产出 §3.5 的 #1~#27；`value_score` / `value_rank` / `value_score_breakdown`（#28）由 `ValueScorer` 产出。
 * 不变量：M2（第三方不改变 (me,P) 主指标）、不猜（无样本 → `metric_value = null`，不伪造 0）、确定性。
 * 时区：`active_hour_hist` 的「本地小时」由调用方注入 `hourOf`；缺省用 UTC（管线应注入 `persons_meta.timezone` 版本）。
 */
import type { ScopeKind } from "@knowself/contracts";
import {
  SELF_PERSON_ID,
  type IntentKind,
  type MentionRow,
  type MetricUpsert,
  type MiningMessageRow,
  type Period,
} from "@knowself/person-store";
import { HISTOGRAM_THRESHOLD, METRICS_PRODUCED_BY, SESSION_GAP_MS } from "./constants";
import { accumulateDuration } from "./duration";
import { countFrequency } from "./frequency";
import { accumulateInitiative } from "./initiative";
import { describeSamples, logHistogram, percentile } from "./percentile";
import { accumulateReplyLatency } from "./reply-latency";
import { segmentConversation } from "./session";

export interface MetricsScope {
  readonly scope_kind: ScopeKind;
  readonly scope_id: string;
}

export interface MetricsBuildInput {
  /** 画像对象 P。 */
  readonly personId: string;
  readonly scope: MetricsScope;
  /** 该 scope 窗口内的消息（§3.1 过滤；system 消息本模块再兜底过滤一次）。 */
  readonly messages: readonly MiningMessageRow[];
  readonly mentionsByMessageId?: ReadonlyMap<string, readonly MentionRow[]>;
  /** 该 scope 窗口内的意图判定结果（§5）。 */
  readonly intents?: readonly IntentKind[];
  readonly computedAt?: string;
  readonly producedBy?: string;
  readonly period?: Period;
  readonly periodKey?: string;
  /** 「本地小时」取值函数；缺省 UTC。 */
  readonly hourOf?: (tsMs: number) => number;
  /** 回复延迟样本近似阈值（§3.3.4）；缺省 `HISTOGRAM_THRESHOLD`。 */
  readonly approximateThreshold?: number;
}

export interface MetricsBuildResult {
  readonly rows: MetricUpsert[];
  readonly warnings: string[];
  readonly senderUnresolvedCount: number;
  readonly sessionCount: number;
}

/** 仅 group scope 适用的键（§3.5 #4 / #5 / #16）。 */
const GROUP_ONLY_KEYS: ReadonlySet<string> = new Set([
  "msg_count_third_party",
  "msg_count_other_to_me",
  "initiative_count_third_party",
]);
/** 仅 global scope 适用的键（§3.5 #26）。 */
const GLOBAL_ONLY_KEYS: ReadonlySet<string> = new Set(["active_hour_hist"]);

function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** 直方图近似分位数（§3.3.4 大样本降级路径）。 */
function approximatePercentile(
  hist: { histogram: number[]; maxValue: number },
  p: number,
): number {
  const total = hist.histogram.reduce((acc, value) => acc + value, 0);
  if (total === 0) return 0;
  const target = Math.ceil(p * total);
  let cumulative = 0;
  const bucketCount = hist.histogram.length;
  for (let i = 0; i < bucketCount; i += 1) {
    cumulative += hist.histogram[i] ?? 0;
    if (cumulative >= target) {
      const upper = Math.exp(((i + 1) / bucketCount) * Math.log(hist.maxValue + 1)) - 1;
      return Math.max(0, Math.round(upper));
    }
  }
  return hist.maxValue;
}

export function buildMetrics(input: MetricsBuildInput): MetricsBuildResult {
  const producedBy = input.producedBy ?? METRICS_PRODUCED_BY;
  const computedAt = input.computedAt ?? new Date().toISOString();
  const period: Period = input.period ?? "all";
  const periodKey = input.periodKey ?? "";
  const hourOf = input.hourOf ?? ((tsMs: number): number => new Date(tsMs).getUTCHours());
  const approximateThreshold = input.approximateThreshold ?? HISTOGRAM_THRESHOLD;
  const warnings: string[] = [];

  // §3.1 兜底过滤 + 确定性排序
  const messages = input.messages
    .filter((m) => m.role !== "system" && m.content_type !== "system")
    .slice()
    .sort(
      (a, b) =>
        (a.conversation_id < b.conversation_id
          ? -1
          : a.conversation_id > b.conversation_id
            ? 1
            : 0) ||
        a.ts_ms - b.ts_ms ||
        (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0),
    );

  // 片段必须按会话分别切分（global scope 跨会话）
  const byConversation = new Map<string, MiningMessageRow[]>();
  for (const message of messages) {
    const bucket = byConversation.get(message.conversation_id) ?? [];
    bucket.push(message);
    byConversation.set(message.conversation_id, bucket);
  }
  const segments = [...byConversation.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([conversationId, rows]) => segmentConversation(conversationId, rows).segments);

  const frequency = countFrequency({
    personId: input.personId,
    messages,
    ...(input.mentionsByMessageId === undefined
      ? {}
      : { mentionsByMessageId: input.mentionsByMessageId }),
  });
  const duration = accumulateDuration(segments);
  const initiative = accumulateInitiative(segments, input.personId);
  const latency = accumulateReplyLatency(segments, input.personId, SESSION_GAP_MS);

  const oneSidedSessions = segments.filter((segment) => {
    const participants = new Set(
      segment.messages
        .map((m) => m.sender_person_id)
        .filter((id): id is string => id === SELF_PERSON_ID || id === input.personId),
    );
    return participants.size === 1;
  }).length;

  const latencySamples = latency.toMe.map((sample) => sample.latencyMs);
  const approximated = latencySamples.length > approximateThreshold;
  let latencyJson: string | null = null;
  let replyP50: number | null;
  let replyP90: number | null;
  let replyMean: number | null;
  if (approximated) {
    const hist = logHistogram(latencySamples);
    replyP50 = approximatePercentile(hist, 0.5);
    replyP90 = approximatePercentile(hist, 0.9);
    const total = latencySamples.reduce((acc, value) => acc + value, 0);
    replyMean = Math.round(total / latencySamples.length);
    latencyJson = JSON.stringify({ approximate: true, buckets: hist.histogram.length });
    warnings.push(`REPLY_LATENCY_APPROXIMATED:samples=${latencySamples.length}`);
  } else {
    const described = describeSamples(latencySamples);
    replyP50 = described.p50;
    replyP90 = described.p90;
    replyMean = described.mean === null ? null : Math.round(described.mean);
  }

  const myReplyP50 = percentile(
    sortedAsc(latency.fromMe.map((sample) => sample.latencyMs)),
    0.5,
  );

  const ratioDenominator = initiative.sessionCount - initiative.countUnresolved;
  const initiativeRatioMe = ratioDenominator > 0 ? initiative.countMe / ratioDenominator : null;
  const initiativeRatioOther =
    ratioDenominator > 0 ? initiative.countOther / ratioDenominator : null;

  const hourHistogram: Record<string, number> = {};
  for (let hour = 0; hour < 24; hour += 1) hourHistogram[String(hour)] = 0;
  for (const message of messages) {
    if (message.sender_person_id !== input.personId) continue;
    const hour = String(hourOf(message.ts_ms));
    hourHistogram[hour] = (hourHistogram[hour] ?? 0) + 1;
  }

  const intentTotals: Record<string, number> = {};
  for (const intent of input.intents ?? []) {
    intentTotals[intent] = (intentTotals[intent] ?? 0) + 1;
  }

  const rows: MetricUpsert[] = [];
  const skippedNoSample: string[] = [];
  const push = (
    metricKey: string,
    metricUnit: string,
    metricValue: number | null,
    metricValueJson: string | null = null,
  ): void => {
    if (metricValue === null && metricValueJson === null) {
      // §3.3.2：空样本不落行（DDL CHECK 要求两列至少一列非空；落双 null 会被库拒绝）
      skippedNoSample.push(metricKey);
      return;
    }
    rows.push({
      person_id: input.personId,
      scope_kind: input.scope.scope_kind,
      scope_id: input.scope.scope_id,
      period,
      period_key: periodKey,
      metric_key: metricKey,
      metric_value: metricValue,
      metric_value_json: metricValueJson,
      metric_unit: metricUnit,
      produced_by: producedBy,
      computed_at: computedAt,
    });
  };

  push("msg_count_me", "count", frequency.msgCountMe);
  push("msg_count_other", "count", frequency.msgCountOther);
  push("msg_count_total", "count", frequency.msgCountMe + frequency.msgCountOther);
  push("msg_count_third_party", "count", frequency.msgCountThirdParty);
  push("msg_count_other_to_me", "count", frequency.msgCountOtherToMe);
  push("active_day_count", "count", frequency.activeDays.size);
  push("session_count", "count", segments.length);
  push("session_count_one_sided", "count", oneSidedSessions);
  push("sessions_cross_day", "count", initiative.crossDayCount);
  push("session_duration_total_ms", "ms", duration.sessionDurationTotalMs);
  push("session_duration_p50_ms", "ms", percentile(sortedAsc(duration.sessionDurationSamples), 0.5));
  push("session_msg_p50", "count", percentile(sortedAsc(duration.sessionMsgSamples), 0.5));
  push("active_duration_total_ms", "ms", duration.activeDurationTotalMs);
  push("initiative_count_me", "count", initiative.countMe);
  push("initiative_count_other", "count", initiative.countOther);
  push("initiative_count_third_party", "count", initiative.countThirdParty);
  push("initiative_ratio_me", "ratio", initiativeRatioMe);
  push("initiative_ratio_other", "ratio", initiativeRatioOther);
  push("reply_latency_p50_ms", "ms", replyP50, latencyJson);
  push("reply_latency_p90_ms", "ms", replyP90, latencyJson);
  push("reply_latency_mean_ms", "ms", replyMean, latencyJson);
  push("reply_latency_censored_count", "count", latency.censoredCount);
  push("my_reply_latency_p50_ms", "ms", myReplyP50);
  push(
    "reply_rate",
    "ratio",
    latency.myReplyBlocks > 0 ? latency.myReplyBlocksWithReply / latency.myReplyBlocks : null,
  );
  push(
    "response_rate_other",
    "ratio",
    latency.myBlocks > 0 ? latency.myBlocksWithReply / latency.myBlocks : null,
  );
  push("active_hour_hist", "json", null, JSON.stringify(hourHistogram));
  push("intent_dist", "json", null, JSON.stringify(intentTotals));

  const applicable = rows.filter((row) => {
    if (GROUP_ONLY_KEYS.has(row.metric_key)) return input.scope.scope_kind === "group";
    if (GLOBAL_ONLY_KEYS.has(row.metric_key)) return input.scope.scope_kind === "global";
    return true;
  });
  if (skippedNoSample.length > 0) {
    warnings.push(`NO_SAMPLE_KEYS:${[...skippedNoSample].sort().join(",")}`);
  }

  return {
    rows: applicable,
    warnings,
    senderUnresolvedCount: frequency.senderUnresolvedCount,
    sessionCount: segments.length,
  };
}

/** `MetricsBuilder` 别名（§12 P1-2/P1-3 的编排入口）。 */
export const MetricsBuilder = { build: buildMetrics };
