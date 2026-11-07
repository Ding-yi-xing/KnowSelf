/**
 * mining 内部类型：会话片段与指标中间产物。
 * 行类型（MiningMessageRow / MetricUpsert 等）复用 `@knowself/person-store` 导出。
 */
import type { MiningMessageRow } from "@knowself/person-store";

/** 会话片段（DESIGN-12 §3.2）：跨天不截断；period 归属取首条消息 msg_date。 */
export interface SessionSegment {
  session_no: number;
  conversation_id: string;
  start_ts_ms: number;
  end_ts_ms: number;
  msg_count: number;
  first_message_id: string;
  first_role: MiningMessageRow["role"];
  first_sender_person_id: string | null;
  /** 片段内消息（按 ts_ms, message_id 升序）。 */
  messages: readonly MiningMessageRow[];
  /** 跨自然日片段标记（审计用，不改变归属）。 */
  crosses_day: boolean;
}

/** 频次累加器（§3.3.1 / §3.4 群聊归因）。 */
export interface FrequencyAccumulator {
  msgCountMe: number;
  msgCountOther: number;
  msgCountThirdParty: number;
  msgCountOtherToMe: number;
  msgCountThirdPartyToMe: number;
  activeDays: Set<string>;
}

/** 时长累加器（§3.3.2）：窗口时长与活跃时长分开累计。 */
export interface DurationAccumulator {
  sessionDurationTotalMs: number;
  activeDurationTotalMs: number;
  sessionDurationSamples: number[];
  sessionMsgSamples: number[];
}

/** 主动性累加器（§3.3.3）。 */
export interface InitiativeAccumulator {
  countMe: number;
  countOther: number;
  countThirdParty: number;
  countUnresolved: number;
  sessionCount: number;
  crossDayCount: number;
}

/** 回复延迟样本（§3.3.4）：块 → 块，A ≠ B。 */
export interface ReplyLatencySample {
  fromPersonId: string;
  toPersonId: string;
  latencyMs: number;
  evidence: [string, string];
}

/** 回复延迟累加器（§3.3.4）。 */
export interface LatencyAccumulator {
  /** (P → me) 样本。 */
  toMe: ReplyLatencySample[];
  /** (me → P) 样本。 */
  fromMe: ReplyLatencySample[];
  /** 第三方样本（仅辅助特征，§4.3）。 */
  thirdParty: ReplyLatencySample[];
  censoredCount: number;
  /** 对方发言后我回复的比例：分母 = 对方块数。 */
  myReplyBlocks: number;
  myReplyBlocksWithReply: number;
  /** 我发言后对方回复的比例：分母 = 我的块数。 */
  myBlocks: number;
  myBlocksWithReply: number;
}

/** 片段切分结果（含跳过原因，§3.2 边界裁定）。 */
export interface SegmentResult {
  segments: readonly SessionSegment[];
  /** `TS_REGRESSION` 片段数（时间戳回退，跳过指标）。 */
  tsRegressions: number;
  excludedSystemCount: number;
}
