/**
 * 主动性 / 回复延迟测试（DESIGN-12 §3.3.3 / §3.3.4 / §11.1 第 4~6 行）。
 * 全部合成数据（人名只用 张三 / 李四），无真实聊天内容。
 */
import { describe, expect, it } from "vitest";
import type { MiningMessageRow } from "@knowself/person-store";
import { SESSION_GAP_MS } from "../src/constants";
import { accumulateInitiative } from "../src/initiative";
import { accumulateReplyLatency } from "../src/reply-latency";
import { segmentConversation } from "../src/session";

const ME = "me";
const P = "person-zhangsan";
const Q = "person-lisi";

function msg(
  overrides: Partial<MiningMessageRow> & Pick<MiningMessageRow, "message_id" | "ts_ms">,
): MiningMessageRow {
  return {
    conversation_id: "wechat:conv-1",
    platform: "wechat",
    role: "other",
    sender_id: "wxid_zhangsan",
    sender_person_id: P,
    msg_date: "2026-09-10",
    content: "…",
    content_type: "text",
    reply_to: null,
    meta: "{}",
    ...overrides,
  };
}

function segmentsOf(messages: MiningMessageRow[]): ReturnType<typeof segmentConversation> {
  return segmentConversation("wechat:conv-1", messages);
}

describe("InitiativeCalculator（§3.3.3）", () => {
  it("发起者计数与 unresolved 口径", () => {
    const { segments } = segmentsOf([
      msg({ message_id: "a", ts_ms: 1_000, role: "me", sender_person_id: ME, sender_id: "me" }),
      msg({ message_id: "b", ts_ms: 1_100 }),
      // 第二个片段：第三方发起
      msg({ message_id: "c", ts_ms: 1_000 + 2 * SESSION_GAP_MS, sender_person_id: Q, sender_id: "wxid_lisi" }),
      // 第三个片段：未解析发起
      msg({
        message_id: "d", ts_ms: 1_000 + 4 * SESSION_GAP_MS,
        sender_person_id: null, sender_id: "wxid_unknown",
      }),
    ]);
    const acc = accumulateInitiative(segments, P);
    expect(acc.sessionCount).toBe(3);
    expect(acc.countMe).toBe(1);
    expect(acc.countThirdParty).toBe(1);
    expect(acc.countUnresolved).toBe(1);
    expect(acc.countOther).toBe(0);
  });
});

describe("ReplyLatencyCalculator（§3.3.4）", () => {
  it("(P→me) 与 (me→P) 样本分别入桶；证据取块边界消息", () => {
    const { segments } = segmentsOf([
      msg({ message_id: "a", ts_ms: 1_000 }), // P
      msg({ message_id: "b", ts_ms: 1_000 + 5_000, role: "me", sender_person_id: ME, sender_id: "me" }), // me 回复，lat=5s
      msg({ message_id: "c", ts_ms: 1_000 + 8_000 }), // P 连发后
      msg({ message_id: "d", ts_ms: 1_000 + 9_000 }), // P 再发（与 c 合并为块）
      msg({ message_id: "e", ts_ms: 1_000 + 12_000, role: "me", sender_person_id: ME, sender_id: "me" }), // me 回复 P 块，lat=3s
    ]);
    const acc = accumulateReplyLatency(segments, P);
    expect(acc.toMe).toHaveLength(2);
    expect(acc.toMe[0]?.latencyMs).toBe(5_000);
    expect(acc.toMe[0]?.evidence).toEqual(["a", "b"]);
    expect(acc.toMe[1]?.latencyMs).toBe(3_000);
    expect(acc.toMe[1]?.evidence).toEqual(["d", "e"]); // 连发合并：P 块末条是 d
    expect(acc.fromMe).toHaveLength(1);
    expect(acc.fromMe[0]?.evidence).toEqual(["b", "c"]); // me 块末条 b → P 块首条 c
    expect(acc.thirdParty).toHaveLength(0);
    expect(acc.censoredCount).toBe(0);
  });

  it("块间隔 > gap 计 censored 不入样本（gap 参数防御路径）", () => {
    // 消息间隔 5s < 切段 gap → 同一片段；延迟计算用更小的 gap 演示截断
    const { segments } = segmentsOf([
      msg({ message_id: "a", ts_ms: 1_000 }),
      msg({ message_id: "b", ts_ms: 6_000, role: "me", sender_person_id: ME, sender_id: "me" }),
      msg({ message_id: "c", ts_ms: 7_000, sender_person_id: Q, sender_id: "wxid_lisi" }),
      msg({ message_id: "d", ts_ms: 8_000, role: "me", sender_person_id: ME, sender_id: "me" }), // Q→me 归 thirdParty
    ]);
    const acc = accumulateReplyLatency(segments, P, 1_000);
    expect(acc.censoredCount).toBe(1); // P→me 5s > 1s
    expect(acc.toMe).toHaveLength(0);
    expect(acc.thirdParty).toHaveLength(2); // me→Q 与 Q→me 都归第三方
  });

  it("回复率：reply_rate 与 response_rate_other", () => {
    const { segments } = segmentsOf([
      msg({ message_id: "a", ts_ms: 1_000 }), // P 块 1
      msg({ message_id: "b", ts_ms: 1_100, role: "me", sender_person_id: ME, sender_id: "me" }), // me 块（回复了）
      msg({ message_id: "c", ts_ms: 1_200 }), // P 块 2（无后继 → 未回复）
    ]);
    const acc = accumulateReplyLatency(segments, P);
    expect(acc.myReplyBlocks).toBe(2);
    expect(acc.myReplyBlocksWithReply).toBe(1);
    expect(acc.myBlocks).toBe(1);
    expect(acc.myBlocksWithReply).toBe(1); // me 块后继是 P 块 c
  });
});
