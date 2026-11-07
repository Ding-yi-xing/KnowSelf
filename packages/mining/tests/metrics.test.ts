/**
 * 指标编排层测试（DESIGN-12 §3.5 指标字典 + §3.7 粒度 + 不变量 M2）。
 * 全部合成数据（人名只用 张三 / 李四），无真实聊天内容。
 */
import { describe, expect, it } from "vitest";
import type { MiningMessageRow } from "@knowself/person-store";
import { SESSION_GAP_MS } from "../src/constants";
import { buildMetrics } from "../src/metrics";

const T0 = 1_700_000_000_000;
let counter = 0;

function msg(
  conversationId: string,
  senderPersonId: string | null,
  tsMs: number,
  overrides: Partial<MiningMessageRow> = {},
): MiningMessageRow {
  counter += 1;
  return {
    message_id: `m-${counter}`,
    conversation_id: conversationId,
    platform: "wechat",
    role: senderPersonId === "me" ? "me" : "other",
    sender_id: senderPersonId === null ? "unresolved" : `uid-${senderPersonId}`,
    sender_person_id: senderPersonId,
    ts_ms: tsMs,
    msg_date: "2023-11-14",
    content: "合成文案",
    content_type: "text",
    reply_to: null,
    meta: "{}",
    ...overrides,
  };
}

const DIRECT = "wechat:conv-direct";
const GROUP = "wechat:group-1";

/** 单聊：me 与张三各 2 条，片段 1 个（间隔 < G）。 */
function directMessages(): MiningMessageRow[] {
  return [
    msg(DIRECT, "person-zhangsan", T0),
    msg(DIRECT, "me", T0 + 60_000),
    msg(DIRECT, "person-zhangsan", T0 + 120_000),
    msg(DIRECT, "me", T0 + 180_000),
  ];
}

/** 群聊：张三 3 条 + me 2 条 + 第三方李四 2 条（块序保证 toMe / fromMe 样本均非空）。 */
function groupMessages(): MiningMessageRow[] {
  return [
    msg(GROUP, "person-zhangsan", T0),
    msg(GROUP, "me", T0 + 1_000),
    msg(GROUP, "person-lisi", T0 + 2_000),
    msg(GROUP, "person-lisi", T0 + 3_000),
    msg(GROUP, "person-zhangsan", T0 + 4_000),
    msg(GROUP, "me", T0 + 5_000),
    msg(GROUP, "person-zhangsan", T0 + 6_000),
  ];
}

const DIRECT_KEYS = [
  "msg_count_me",
  "msg_count_other",
  "msg_count_total",
  "active_day_count",
  "session_count",
  "session_count_one_sided",
  "sessions_cross_day",
  "session_duration_total_ms",
  "session_duration_p50_ms",
  "session_msg_p50",
  "active_duration_total_ms",
  "initiative_count_me",
  "initiative_count_other",
  "initiative_ratio_me",
  "initiative_ratio_other",
  "reply_latency_p50_ms",
  "reply_latency_p90_ms",
  "reply_latency_mean_ms",
  "reply_latency_censored_count",
  "my_reply_latency_p50_ms",
  "reply_rate",
  "response_rate_other",
  "intent_dist",
];

const GROUP_ONLY_KEYS = [
  "msg_count_third_party",
  "msg_count_other_to_me",
  "initiative_count_third_party",
];

describe("buildMetrics（§3.5 指标字典 / §3.7 粒度）", () => {
  it("direct scope：产出 23 个适用键，且不含 group-only / global-only 键", () => {
    const result = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "direct", scope_id: DIRECT },
      messages: directMessages(),
      computedAt: "2026-09-22T10:00:00+08:00",
    });
    const keys = result.rows.map((row) => row.metric_key).sort();
    expect(keys).toEqual([...DIRECT_KEYS].sort());
    for (const groupOnly of GROUP_ONLY_KEYS) expect(keys).not.toContain(groupOnly);
    expect(keys).not.toContain("active_hour_hist");
  });

  it("group scope：补出 group-only 三键（共 26 键）", () => {
    const result = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "group", scope_id: GROUP },
      messages: groupMessages(),
    });
    const keys = result.rows.map((row) => row.metric_key);
    for (const key of GROUP_ONLY_KEYS) expect(keys).toContain(key);
    expect(keys).toHaveLength(DIRECT_KEYS.length + GROUP_ONLY_KEYS.length);
  });

  it("global scope：补出 active_hour_hist（24 桶 json）", () => {
    const result = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "global", scope_id: "" },
      messages: [...directMessages(), ...groupMessages()],
      hourOf: () => 9,
    });
    const hist = result.rows.find((row) => row.metric_key === "active_hour_hist");
    expect(hist).toBeDefined();
    expect(hist?.metric_value).toBeNull();
    const parsed = JSON.parse(String(hist?.metric_value_json)) as Record<string, number>;
    expect(Object.keys(parsed)).toHaveLength(24);
    expect(parsed["9"]).toBeGreaterThan(0);
  });

  it("不变量 M2：第三方消息不改变 (me, P) 主指标", () => {
    const base = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "group", scope_id: GROUP },
      messages: groupMessages().filter((m) => m.sender_person_id !== "person-lisi"),
    });
    const withThirdParty = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "group", scope_id: GROUP },
      messages: groupMessages(),
    });
    const valueOf = (rows: typeof base.rows, key: string): unknown =>
      rows.find((row) => row.metric_key === key)?.metric_value;
    for (const key of [
      "msg_count_me",
      "msg_count_other",
      "msg_count_total",
      "initiative_count_other",
    ]) {
      expect(valueOf(withThirdParty.rows, key)).toBe(valueOf(base.rows, key));
    }
    expect(valueOf(withThirdParty.rows, "msg_count_third_party")).toBe(2);
  });

  it("无样本指标 → 不落行并记 NO_SAMPLE_KEYS（§3.3.2；DDL 不允许双 null）", () => {
    const result = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "direct", scope_id: DIRECT },
      messages: [msg(DIRECT, "person-zhangsan", T0)],
    });
    const latency = result.rows.find((row) => row.metric_key === "reply_latency_p50_ms");
    expect(latency).toBeUndefined();
    expect(
      result.warnings.some(
        (warning) =>
          warning.startsWith("NO_SAMPLE_KEYS") && warning.includes("reply_latency_p50_ms"),
      ),
    ).toBe(true);
    const censored = result.rows.find((row) => row.metric_key === "reply_latency_censored_count");
    expect(censored?.metric_value).toBe(0);
  });

  it("确定性：同输入两次构建逐行一致（附录 B #6）", () => {
    const build = (): string =>
      JSON.stringify(
        buildMetrics({
          personId: "person-zhangsan",
          scope: { scope_kind: "group", scope_id: GROUP },
          messages: groupMessages(),
          computedAt: "2026-09-22T10:00:00+08:00",
        }).rows,
      );
    expect(build()).toBe(build());
  });

  it("intent_dist 落 json 键；版本位与 scope 正确写入每一行", () => {
    const result = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "direct", scope_id: DIRECT },
      messages: directMessages(),
      intents: ["business", "social", "business"],
      computedAt: "2026-09-22T10:00:00+08:00",
    });
    const dist = result.rows.find((row) => row.metric_key === "intent_dist");
    expect(JSON.parse(String(dist?.metric_value_json))).toEqual({ business: 2, social: 1 });
    for (const row of result.rows) {
      expect(row.person_id).toBe("person-zhangsan");
      expect(row.scope_kind).toBe("direct");
      expect(row.scope_id).toBe(DIRECT);
      expect(row.period).toBe("all");
      expect(row.computed_at).toBe("2026-09-22T10:00:00+08:00");
      expect(row.produced_by).toBe("mining:metrics-v1");
    }
  });

  it("回复延迟样本超阈值时标记近似（§3.3.4 直方图降级）", () => {
    const messages: MiningMessageRow[] = [];
    const far = SESSION_GAP_MS + 5_000;
    for (let i = 0; i < 30; i += 1) {
      messages.push(msg(DIRECT, "person-zhangsan", T0 + far * i));
      messages.push(msg(DIRECT, "me", T0 + far * i + 1_000));
    }
    const result = buildMetrics({
      personId: "person-zhangsan",
      scope: { scope_kind: "direct", scope_id: DIRECT },
      messages,
      approximateThreshold: 10,
    });
    const p50 = result.rows.find((row) => row.metric_key === "reply_latency_p50_ms");
    expect(p50?.metric_value_json).not.toBeNull();
    expect(JSON.parse(String(p50?.metric_value_json))).toMatchObject({ approximate: true });
    expect(result.warnings.some((w) => w.startsWith("REPLY_LATENCY_APPROXIMATED"))).toBe(true);
  });
});
