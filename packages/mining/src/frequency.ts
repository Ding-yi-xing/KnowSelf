/**
 * `FrequencyCounter`（DESIGN-12 §3.3.1 / §3.4）：频次计数与群聊归因。
 * 不变量 M2：`(me, P)` 主指标只由 `sender ∈ {me, P}` 的消息贡献；第三方消息进
 * `msg_count_third_party` / `msg_count_third_party_to_me`，永不抬高或压低主指标。
 * `sender_person_id IS NULL` → 不计入任何归因（§3.1 规则 ③，记 `senderUnresolvedCount`）。
 */
import { SELF_PERSON_ID, type MentionRow, type MiningMessageRow } from "@knowself/person-store";
import type { FrequencyAccumulator } from "./types";

export interface FrequencyInput {
  /** 画像对象 P 的 person_id。 */
  personId: string;
  /** 已过滤消息（§3.1：非 system、时间窗内）。 */
  messages: readonly MiningMessageRow[];
  /** 按 message_id 索引的 mention 行（群聊定向互动判定）。 */
  mentionsByMessageId?: ReadonlyMap<string, readonly MentionRow[]>;
}

export function countFrequency(
  input: FrequencyInput,
): FrequencyAccumulator & { senderUnresolvedCount: number } {
  const acc: FrequencyAccumulator = {
    msgCountMe: 0,
    msgCountOther: 0,
    msgCountThirdParty: 0,
    msgCountOtherToMe: 0,
    msgCountThirdPartyToMe: 0,
    activeDays: new Set<string>(),
  };
  let senderUnresolvedCount = 0;

  for (const message of input.messages) {
    acc.activeDays.add(message.msg_date.slice(0, 10));
    const mentions = input.mentionsByMessageId?.get(message.message_id) ?? [];
    const targetedMe = mentions.some((mention) => mention.person_id === SELF_PERSON_ID);

    if (message.role === "me" || message.sender_person_id === SELF_PERSON_ID) {
      acc.msgCountMe += 1;
    } else if (message.sender_person_id === input.personId) {
      acc.msgCountOther += 1;
      if (targetedMe) acc.msgCountOtherToMe += 1;
    } else if (message.sender_person_id !== null) {
      acc.msgCountThirdParty += 1;
      if (targetedMe) acc.msgCountThirdPartyToMe += 1;
    } else {
      senderUnresolvedCount += 1;
    }
  }

  return { ...acc, senderUnresolvedCount };
}

export const FrequencyCounter = { countFrequency };
