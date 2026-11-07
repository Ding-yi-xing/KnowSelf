/**
 * `DurationCalculator`（DESIGN-12 §3.3.2）：时长族指标。
 * 口径诚实声明（§3.3.2）：`session_duration_*` 是对话窗口长度（上界），
 * `active_duration_*` 是保守下界（相邻消息间隔之和）——两者都落指标，
 * 调用方展示时必须注明口径，不得当作"陪伴时长"宣称。
 */
import type { DurationAccumulator, SessionSegment } from "./types";

export function accumulateDuration(
  segments: readonly SessionSegment[],
): DurationAccumulator {
  const acc: DurationAccumulator = {
    sessionDurationTotalMs: 0,
    activeDurationTotalMs: 0,
    sessionDurationSamples: [],
    sessionMsgSamples: [],
  };
  for (const segment of segments) {
    const windowMs = segment.end_ts_ms - segment.start_ts_ms;
    acc.sessionDurationTotalMs += windowMs;
    acc.sessionDurationSamples.push(windowMs);
    acc.sessionMsgSamples.push(segment.msg_count);
    let activeMs = 0;
    for (let i = 1; i < segment.messages.length; i += 1) {
      const prev = segment.messages[i - 1];
      const next = segment.messages[i];
      if (prev !== undefined && next !== undefined) {
        activeMs += next.ts_ms - prev.ts_ms;
      }
    }
    acc.activeDurationTotalMs += activeMs;
  }
  return acc;
}

export const DurationCalculator = { accumulateDuration };
