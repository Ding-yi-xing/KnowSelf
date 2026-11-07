/**
 * `ReplyLatencyCalculator`（DESIGN-12 §3.3.4）：回复延迟族指标。
 * 块 → 块：同一发送者的连续消息合并为一块；相邻块 (A, B) 且 A ≠ B：
 *   lat = first_ts(B) − last_ts(A)；lat < 0 跳过（TS_REGRESSION）；
 *   lat > G 计入 censored，不入样本；否则记样本 (A → B)。
 * 跨片段不算（逐片段处理天然满足）。样本归属（§3.3.4 群聊归因）：
 *   (P → me) → toMe（画像主指标）；(me → P) → fromMe（我的响应性）；
 *   其余（第三方→me / me→第三方 / 他人→他人）→ thirdParty（仅 §4.3 辅助特征）。
 */
import { SELF_PERSON_ID, type MiningMessageRow } from "@knowself/person-store";
import { SESSION_GAP_MS } from "./constants";
import type { LatencyAccumulator, ReplyLatencySample, SessionSegment } from "./types";

interface Block {
  senderPersonId: string;
  firstTsMs: number;
  lastTsMs: number;
  firstMessageId: string;
  lastMessageId: string;
}

/** 把片段内消息按发送者切成连续块（sender_person_id 相同合并；null 用 sender_id 占位，不参与人际判定）。 */
function toBlocks(messages: readonly MiningMessageRow[]): Block[] {
  const blocks: Block[] = [];
  for (const message of messages) {
    const senderId = message.sender_person_id ?? `__unresolved__:${message.sender_id}`;
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.senderPersonId === senderId) {
      last.lastTsMs = message.ts_ms;
      last.lastMessageId = message.message_id;
    } else {
      blocks.push({
        senderPersonId: senderId,
        firstTsMs: message.ts_ms,
        lastTsMs: message.ts_ms,
        firstMessageId: message.message_id,
        lastMessageId: message.message_id,
      });
    }
  }
  return blocks;
}

function emptyAcc(): LatencyAccumulator {
  return {
    toMe: [],
    fromMe: [],
    thirdParty: [],
    censoredCount: 0,
    myReplyBlocks: 0,
    myReplyBlocksWithReply: 0,
    myBlocks: 0,
    myBlocksWithReply: 0,
  };
}

export function accumulateReplyLatency(
  segments: readonly SessionSegment[],
  personId: string,
  gapMs: number = SESSION_GAP_MS,
): LatencyAccumulator {
  const acc = emptyAcc();
  for (const segment of segments) {
    const blocks = toBlocks(segment.messages);
    for (let i = 1; i < blocks.length; i += 1) {
      const a = blocks[i - 1];
      const b = blocks[i];
      if (a === undefined || b === undefined) continue;
      if (a.senderPersonId === b.senderPersonId) continue;
      const lat = b.firstTsMs - a.lastTsMs;
      if (lat < 0) continue; // TS_REGRESSION：不计样本也不计 censored（§3.3.4）
      if (lat > gapMs) {
        acc.censoredCount += 1;
        continue;
      }
      const sample: ReplyLatencySample = {
        fromPersonId: a.senderPersonId,
        toPersonId: b.senderPersonId,
        latencyMs: lat,
        evidence: [a.lastMessageId, b.firstMessageId],
      };
      if (a.senderPersonId === personId && b.senderPersonId === SELF_PERSON_ID) {
        acc.toMe.push(sample); // (P → me)：画像主指标
      } else if (a.senderPersonId === SELF_PERSON_ID && b.senderPersonId === personId) {
        acc.fromMe.push(sample); // (me → P)：我的响应性
      } else {
        acc.thirdParty.push(sample);
      }
    }
    // 块级回复率（§3.3.4 reply_rate / response_rate_other）
    for (let i = 0; i < blocks.length; i += 1) {
      const a = blocks[i];
      if (a === undefined) continue;
      const b = blocks[i + 1];
      const hasSuccessor = b !== undefined && b.senderPersonId !== a.senderPersonId;
      if (a.senderPersonId === personId) {
        acc.myReplyBlocks += 1;
        if (hasSuccessor && b?.senderPersonId === SELF_PERSON_ID) acc.myReplyBlocksWithReply += 1;
      } else if (a.senderPersonId === SELF_PERSON_ID) {
        acc.myBlocks += 1;
        if (hasSuccessor && b?.senderPersonId === personId) acc.myBlocksWithReply += 1;
      }
    }
  }
  return acc;
}

export const ReplyLatencyCalculator = { accumulateReplyLatency };
