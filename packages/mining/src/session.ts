/**
 * `SessionSegmenter`（DESIGN-12 §3.2）：会话片段切分——全部指标的地基。
 * 边界裁定：跨天不截断；period 归属取片段首条消息 msg_date；
 * 单条消息片段 `duration=0` 合法；含时间戳回退的片段记 `TS_REGRESSION` 并整体跳过。
 * 输入为**已过滤**消息（§3.1 的 system / content_type 过滤是调用方职责），按 ts_ms 升序。
 */
import { SESSION_GAP_MS } from "./constants";
import type { SegmentResult, SessionSegment } from "./types";
import type { MiningMessageRow } from "@knowself/person-store";

function dayOf(msgDate: string): string {
  return msgDate.slice(0, 10);
}

/**
 * 切分一个会话的消息序列。返回的片段不含回归片段（计入 `tsRegressions`）。
 * 确定性：同输入同输出（附录 B #6）。
 */
export function segmentConversation(
  conversationId: string,
  messages: readonly MiningMessageRow[],
  gapMs: number = SESSION_GAP_MS,
): SegmentResult {
  const segments: SessionSegment[] = [];
  let tsRegressions = 0;
  let current: MiningMessageRow[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const start = current[0];
    const end = current[current.length - 1];
    if (start === undefined || end === undefined) return;
    // 时间戳回退检测（§3.2 边界裁定）：片段内存在 ts 递减 → TS_REGRESSION，整体跳过
    let regressed = false;
    for (let i = 1; i < current.length; i += 1) {
      const prev = current[i - 1];
      const next = current[i];
      if (prev !== undefined && next !== undefined && next.ts_ms < prev.ts_ms) {
        regressed = true;
        break;
      }
    }
    if (regressed) {
      tsRegressions += 1;
      current = [];
      return;
    }
    const days = new Set(current.map((m) => dayOf(m.msg_date)));
    segments.push({
      session_no: segments.length + 1,
      conversation_id: conversationId,
      start_ts_ms: start.ts_ms,
      end_ts_ms: end.ts_ms,
      msg_count: current.length,
      first_message_id: start.message_id,
      first_role: start.role,
      first_sender_person_id: start.sender_person_id,
      messages: current,
      crosses_day: days.size > 1,
    });
    current = [];
  };

  for (const message of messages) {
    const previous = current[current.length - 1];
    if (previous !== undefined && message.ts_ms - previous.ts_ms > gapMs) {
      flush();
    }
    current.push(message);
  }
  flush();

  return { segments, tsRegressions, excludedSystemCount: 0 };
}

/** 便捷入口：`SessionSegmenter` 别名（DESIGN-12 §12 P1-2 命名）。 */
export const SessionSegmenter = { segmentConversation };
