/**
 * `InitiativeCalculator`（DESIGN-12 §3.3.3）：主动性族指标。
 * 片段发起者 = 片段首条消息的发送者；`first_role='me'` 记为 'me'。
 * 边界：三者之和 = session_count；`sender_person_id IS NULL` 计入 unresolved，
 * 比例分母用 `session_count − unresolved`（避免比例失真，§3.3.3 边界）。
 */
import { SELF_PERSON_ID } from "@knowself/person-store";
import type { InitiativeAccumulator, SessionSegment } from "./types";

export function accumulateInitiative(
  segments: readonly SessionSegment[],
  personId: string,
): InitiativeAccumulator {
  const acc: InitiativeAccumulator = {
    countMe: 0,
    countOther: 0,
    countThirdParty: 0,
    countUnresolved: 0,
    sessionCount: segments.length,
    crossDayCount: 0,
  };
  for (const segment of segments) {
    if (segment.crosses_day) acc.crossDayCount += 1;
    const initiator = segment.first_sender_person_id;
    if (segment.first_role === "me" || initiator === SELF_PERSON_ID) {
      acc.countMe += 1;
    } else if (initiator === personId) {
      acc.countOther += 1;
    } else if (initiator === null) {
      acc.countUnresolved += 1;
    } else {
      acc.countThirdParty += 1;
    }
  }
  return acc;
}

export const InitiativeCalculator = { accumulateInitiative };
