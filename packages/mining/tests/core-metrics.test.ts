/**
 * 核心指标组件测试（DESIGN-12 §3.2 / §3.3.1 / §3.3.2 / §11.1 前 3 行）：
 * SessionSegmenter / FrequencyCounter / DurationCalculator / Percentile。
 * 全部合成数据，人名只用 张三 / 李四，无真实聊天内容（§9.1 铁律）。
 */
import { describe, expect, it } from "vitest";
import type { MiningMessageRow } from "@knowself/person-store";
import { SESSION_GAP_MS } from "../src/constants";
import { accumulateDuration } from "../src/duration";
import { countFrequency } from "../src/frequency";
import { describeSamples, percentile } from "../src/percentile";
import { segmentConversation } from "../src/session";

const ME = "me";
const P = "person-zhangsan";

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

describe("SessionSegmenter（§3.2）", () => {
  it("相邻间隔 > 30 分钟切段；跨天不截断", () => {
    const messages = [
      msg({ message_id: "a", ts_ms: 1_000 }),
      msg({ message_id: "b", ts_ms: 1_000 + 60_000 }), // 1 分钟
      msg({ message_id: "c", ts_ms: 1_000 + 2 * SESSION_GAP_MS, msg_date: "2026-09-11" }), // 次日但间隔 > G → 切
    ];
    const result = segmentConversation("wechat:conv-1", messages);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.msg_count).toBe(2);
    expect(result.segments[0]?.crosses_day).toBe(false);
    expect(result.segments[1]?.msg_count).toBe(1);
    expect(result.tsRegressions).toBe(0);
  });

  it("跨天且间隔 ≤ G → 同一片段，crosses_day=true", () => {
    const messages = [
      msg({ message_id: "a", ts_ms: 86_400_000 - 60_000, msg_date: "2026-09-09" }),
      msg({ message_id: "b", ts_ms: 86_400_000, msg_date: "2026-09-10" }),
    ];
    const result = segmentConversation("wechat:conv-1", messages);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.crosses_day).toBe(true);
  });

  it("时间戳回退的片段整体跳过并计 TS_REGRESSION", () => {
    const messages = [
      msg({ message_id: "a", ts_ms: 2_000 }),
      msg({ message_id: "b", ts_ms: 1_000 }), // 回退
    ];
    const result = segmentConversation("wechat:conv-1", messages);
    expect(result.segments).toHaveLength(0);
    expect(result.tsRegressions).toBe(1);
  });
});

describe("FrequencyCounter（§3.3.1 / §3.4）", () => {
  it("direct 归因：me / P / 第三方 / 未解析 各自入桶", () => {
    const result = countFrequency({
      personId: P,
      messages: [
        msg({ message_id: "1", ts_ms: 1, role: "me", sender_person_id: ME, sender_id: "me" }),
        msg({ message_id: "2", ts_ms: 2 }),
        msg({ message_id: "3", ts_ms: 3, sender_person_id: "person-lisi", sender_id: "wxid_lisi" }),
        msg({ message_id: "4", ts_ms: 4, sender_person_id: null }),
      ],
    });
    expect(result.msgCountMe).toBe(1);
    expect(result.msgCountOther).toBe(1);
    expect(result.msgCountThirdParty).toBe(1);
    expect(result.senderUnresolvedCount).toBe(1);
    expect(result.activeDays.size).toBe(1);
  });

  it("群聊定向互动：P @me 计入 msg_count_other_to_me；第三方 @me 单独入桶", () => {
    const result = countFrequency({
      personId: P,
      messages: [
        msg({ message_id: "1", ts_ms: 1 }),
        msg({ message_id: "2", ts_ms: 2, sender_person_id: "person-lisi", sender_id: "wxid_lisi" }),
      ],
      mentionsByMessageId: new Map([
        ["1", [{ message_id: "1", person_id: ME, mention_kind: "at", created_at: "" }]],
        ["2", [{ message_id: "2", person_id: ME, mention_kind: "at", created_at: "" }]],
      ]),
    });
    expect(result.msgCountOtherToMe).toBe(1);
    expect(result.msgCountThirdPartyToMe).toBe(1);
    expect(result.msgCountOther).toBe(1); // 主指标不被第三方污染（不变量 M2）
  });
});

describe("DurationCalculator（§3.3.2）", () => {
  it("窗口时长与活跃时长分开累计", () => {
    const messages = [
      msg({ message_id: "a", ts_ms: 1_000 }),
      msg({ message_id: "b", ts_ms: 1_000 + 60_000 }),
      msg({ message_id: "c", ts_ms: 1_000 + 120_000 }),
    ];
    const { segments } = segmentConversation("wechat:conv-1", messages);
    const acc = accumulateDuration(segments);
    expect(acc.sessionDurationTotalMs).toBe(120_000);
    expect(acc.activeDurationTotalMs).toBe(120_000);
    expect(acc.sessionDurationSamples).toEqual([120_000]);
    expect(acc.sessionMsgSamples).toEqual([3]);
  });

  it("单条消息片段 duration=0 合法", () => {
    const { segments } = segmentConversation("wechat:conv-1", [msg({ message_id: "a", ts_ms: 1_000 })]);
    const acc = accumulateDuration(segments);
    expect(acc.sessionDurationTotalMs).toBe(0);
    expect(acc.activeDurationTotalMs).toBe(0);
  });
});

describe("Percentile", () => {
  it("nearest-rank 分位数与空样本", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it("describeSamples 返回 P50/P90/均值", () => {
    expect(describeSamples([10, 20, 30, 40])).toEqual({ p50: 20, p90: 40, mean: 25 });
    expect(describeSamples([])).toEqual({ p50: null, p90: null, mean: null });
  });
});
