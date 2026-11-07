import { describe, expect, it } from "vitest";
import {
  judgeTier,
  TIER_REASON_CODES,
  TIER_RULE_VERSION,
  TIER_RULES,
  TierJudge,
  type TierJudgeInput,
  type TierMessageLike,
  type TierReasonCode,
} from "../src/tier";

const NOW_MS = new Date("2026-09-10T10:00:00+08:00").getTime();
const CONV = "wechat:wxid_aaaaaaaaaaaa22";
const TS = new Date("2024-01-02T13:45:00+08:00").getTime();

function message(over: Partial<TierMessageLike> = {}): TierMessageLike {
  return {
    message_id: `${CONV}:1`,
    sender_id: "name:张三",
    role: "other",
    ts_ms: TS,
    content: "你好",
    content_type: "text",
    ...over,
  };
}

function baseInput(): TierJudgeInput {
  return {
    messages: [message()],
    conversation: { conversation_id: CONV, kind: "direct", exists: true, member_count: 2 },
    cursor: null,
    known_sender_ids: ["name:张三"],
    encoding: { replacement_ratio: 0, has_nul: false },
    batch: { parsed_failures: 0, total_lines: 20 },
    manual_flags: [],
  };
}

/** §6.2 表格 11 行逐行一个用例（reason_code → 可执行判据）。 */
describe("TierJudge — 11 个 reason_code（DESIGN-11 §6.2）", () => {
  it("规则表与 §6.2 的码集合、顺序、版本号一致", () => {
    expect(TIER_RULE_VERSION).toBe("chat-tier-v1");
    expect(TIER_RULES.map((rule) => rule.code)).toEqual([...TIER_REASON_CODES]);
    expect(TIER_REASON_CODES).toHaveLength(11);
  });

  it("空集 → Tier A", () => {
    const verdict = judgeTier({ ...baseInput(), now_ms: NOW_MS });
    expect(verdict).toEqual({ tier: "auto", reason_codes: [] });
  });

  const cases: { code: TierReasonCode; input: TierJudgeInput }[] = [
    {
      code: "ENCODING_LOSS",
      input: { ...baseInput(), encoding: { replacement_ratio: 0.01, has_nul: false } },
    },
    {
      code: "TS_INVALID",
      input: { ...baseInput(), messages: [message({ ts_ms: 0 })] },
    },
    {
      code: "TS_REGRESSION",
      input: { ...baseInput(), cursor: { last_ts_ms: TS + 1000, last_message_id: null } },
    },
    {
      code: "SENDER_UNRESOLVED",
      input: { ...baseInput(), known_sender_ids: ["name:李四"] },
    },
    {
      code: "CONTENT_TYPE_UNKNOWN",
      input: {
        ...baseInput(),
        messages: [message({ content: "[类型244813135921]" })],
        content_type_markers: { exact: ["[图片]"], prefixes: ["[语音"] },
      },
    },
    {
      code: "ID_FALLBACK",
      input: { ...baseInput(), messages: [message({ message_id: `${CONV}:sha1:abc` })] },
    },
    {
      code: "ID_CONFLICT",
      input: {
        ...baseInput(),
        lookup_existing: (messageId: string) =>
          messageId === `${CONV}:1` ? { content: "不一样", ts_ms: TS } : null,
      },
    },
    {
      code: "NEW_CONVERSATION",
      input: {
        ...baseInput(),
        conversation: { conversation_id: CONV, kind: "direct", exists: false, member_count: 2 },
      },
    },
    {
      code: "GROUP_MEMBER_UNKNOWN",
      input: {
        ...baseInput(),
        conversation: { conversation_id: CONV, kind: "group", exists: true, member_count: -1 },
      },
    },
    {
      code: "BATCH_QUALITY",
      input: { ...baseInput(), batch: { parsed_failures: 2, total_lines: 100 } },
    },
    {
      code: "MANUAL_FLAG",
      input: { ...baseInput(), manual_flags: [CONV] },
    },
  ];

  for (const item of cases) {
    it(`${item.code} → review`, () => {
      const verdict = judgeTier({ ...item.input, now_ms: NOW_MS });
      expect(verdict.tier).toBe("review");
      expect(verdict.reason_codes).toContain(item.code);
    });
  }

  it("MANUAL_FLAG 也认 sender_id（review.txt 可列人）", () => {
    const verdict = judgeTier({
      ...baseInput(),
      manual_flags: ["name:张三"],
      now_ms: NOW_MS,
    });
    expect(verdict.reason_codes).toContain("MANUAL_FLAG");
  });

  it("SENDER_UNRESOLVED 不误报 me / system", () => {
    const verdict = judgeTier({
      ...baseInput(),
      known_sender_ids: [],
      messages: [
        message({ sender_id: "me", role: "me" }),
        message({ sender_id: "name:未知(sender=22)", role: "system", content: "[系统消息]" }),
      ],
      now_ms: NOW_MS,
    });
    expect(verdict.reason_codes).not.toContain("SENDER_UNRESOLVED");
  });

  it("known_sender_ids = null → 跳过规则 4（不臆断）", () => {
    const verdict = judgeTier({ ...baseInput(), known_sender_ids: null, now_ms: NOW_MS });
    expect(verdict.reason_codes).not.toContain("SENDER_UNRESOLVED");
  });

  it("TS_INVALID 也判未来时间（now + 1 天之外）", () => {
    const verdict = judgeTier({
      ...baseInput(),
      messages: [message({ ts_ms: NOW_MS + 2 * 86_400_000 })],
      now_ms: NOW_MS,
    });
    expect(verdict.reason_codes).toContain("TS_INVALID");
  });

  it("多个规则同时命中 → 全量列出（顺序稳定）", () => {
    const verdict = judgeTier({
      ...baseInput(),
      messages: [message({ message_id: `${CONV}:sha1:abc`, ts_ms: 0 })],
      now_ms: NOW_MS,
    });
    expect(verdict.reason_codes).toEqual(["TS_INVALID", "ID_FALLBACK"]);
  });
});

/** §6.2 末段：Tier A 四条硬门槛。 */
describe("TierJudge.enforceHardGates — Tier A 四条硬门槛", () => {
  const clean = { tier: "auto" as const, reason_codes: [] as TierReasonCode[] };

  it("门槛 2：content_type=other → 降级并补 CONTENT_TYPE_UNKNOWN", () => {
    const verdict = TierJudge.enforceHardGates({
      verdict: clean,
      content_types: ["text", "other"],
      gates: {
        conversation_id: CONV,
        conversation_exists: true,
        auto_ok_conversation_ids: [],
        batch_quality_failed: false,
      },
    });
    expect(verdict.tier).toBe("review");
    expect(verdict.reason_codes).toContain("CONTENT_TYPE_UNKNOWN");
  });

  it("门槛 3：会话不存在且不在 auto_ok → NEW_CONVERSATION", () => {
    const gates = {
      conversation_id: CONV,
      conversation_exists: false,
      auto_ok_conversation_ids: [] as string[],
      batch_quality_failed: false,
    };
    expect(
      TierJudge.enforceHardGates({ verdict: clean, content_types: ["text"], gates }),
    ).toEqual({ tier: "review", reason_codes: ["NEW_CONVERSATION"] });

    const whitelisted = TierJudge.enforceHardGates({
      verdict: clean,
      content_types: ["text"],
      gates: { ...gates, auto_ok_conversation_ids: [CONV] },
    });
    expect(whitelisted).toEqual({ tier: "auto", reason_codes: [] });
  });

  it("门槛 4：批次级 BATCH_QUALITY 触发 → 全部不得自动落档", () => {
    const verdict = TierJudge.enforceHardGates({
      verdict: clean,
      content_types: ["text"],
      gates: {
        conversation_id: CONV,
        conversation_exists: true,
        auto_ok_conversation_ids: [],
        batch_quality_failed: true,
      },
    });
    expect(verdict).toEqual({ tier: "review", reason_codes: ["BATCH_QUALITY"] });
  });

  it("门槛 1：reason_codes 非空时不可 auto", () => {
    const verdict = TierJudge.enforceHardGates({
      verdict: { tier: "review", reason_codes: ["MANUAL_FLAG"] },
      content_types: ["text"],
      gates: {
        conversation_id: CONV,
        conversation_exists: true,
        auto_ok_conversation_ids: [],
        batch_quality_failed: false,
      },
    });
    expect(verdict.tier).toBe("review");
  });

  /**
   * 回归（QA Round 1）：规则 8 在 `judgeNow` 阶段就产出 `NEW_CONVERSATION`，
   * 硬门槛 3 必须能**撤销**它（白名单的「或」语义），否则 auto_ok 对首次出现的会话永远失效。
   */
  it("门槛 3（组合路径）：judgeNow 产出的 NEW_CONVERSATION 被 auto_ok 撤销", () => {
    const judged = judgeTier({
      ...baseInput(),
      conversation: { conversation_id: CONV, kind: "direct", exists: false, member_count: 2 },
      now_ms: NOW_MS,
    });
    expect(judged.reason_codes).toContain("NEW_CONVERSATION");

    const gated = TierJudge.enforceHardGates({
      verdict: judged,
      content_types: ["text"],
      gates: {
        conversation_id: CONV,
        conversation_exists: false,
        auto_ok_conversation_ids: [CONV],
        batch_quality_failed: false,
      },
    });
    expect(gated).toEqual({ tier: "auto", reason_codes: [] });
  });

  it("门槛 3：白名单只豁免 NEW_CONVERSATION，不得豁免其余 10 个码", () => {
    const gated = TierJudge.enforceHardGates({
      verdict: { tier: "review", reason_codes: ["ID_FALLBACK", "NEW_CONVERSATION"] },
      content_types: ["text"],
      gates: {
        conversation_id: CONV,
        conversation_exists: false,
        auto_ok_conversation_ids: [CONV],
        batch_quality_failed: false,
      },
    });
    expect(gated).toEqual({ tier: "review", reason_codes: ["ID_FALLBACK"] });
  });
});
