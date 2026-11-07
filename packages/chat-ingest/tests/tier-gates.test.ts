/**
 * TierJudge 边界与硬门槛组合（DESIGN-11 §6.2 / §9.2 第 5 行）。
 *
 * 与 `tier.test.ts` 的分工：那个文件覆盖「11 个码各命中一次」的 happy path，
 * 本文件只补**边界**（恰好等于阈值 / 恰好不触发）与**硬门槛 × 规则的真实组合路径**。
 * 数据全部为合成内容（§9.1 铁律 2）。
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_CONTENT_TYPES,
  judgeTier,
  TierJudge,
  type TierGateInput,
  type TierJudgeInput,
  type TierMessageLike,
  type TierReasonCode,
} from "../src/tier";

const NOW_MS = new Date("2026-09-10T10:00:00+08:00").getTime();
/** 2011-01-01T00:00:00Z（§6.2 规则 2 的下界）。 */
const MIN_TS_MS = 1_293_840_000_000;
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

function base(): TierJudgeInput {
  return {
    messages: [message()],
    conversation: { conversation_id: CONV, kind: "direct", exists: true, member_count: 2 },
    cursor: null,
    known_sender_ids: ["name:张三"],
    encoding: { replacement_ratio: 0, has_nul: false },
    batch: { parsed_failures: 0, total_lines: 100 },
    manual_flags: [],
  };
}

function verdictOf(over: Partial<TierJudgeInput>) {
  return judgeTier({ ...base(), ...over, now_ms: NOW_MS });
}

function has(over: Partial<TierJudgeInput>, code: TierReasonCode): boolean {
  return verdictOf(over).reason_codes.includes(code);
}

describe("§6.2 规则边界：阈值必须「严格大于」才命中", () => {
  it("规则 1 ENCODING_LOSS：U+FFFD 占比恰 0.5% 不命中，> 0.5% 才命中；含 \\x00 直接命中", () => {
    // §6.2 规则 1：「占比 > 0.5%」
    expect(has({ encoding: { replacement_ratio: 0.005, has_nul: false } }, "ENCODING_LOSS")).toBe(false);
    expect(has({ encoding: { replacement_ratio: 0.0050001, has_nul: false } }, "ENCODING_LOSS")).toBe(true);
    expect(has({ encoding: { replacement_ratio: 0, has_nul: true } }, "ENCODING_LOSS")).toBe(true);
  });

  it("规则 2 TS_INVALID：下界 2011-01-01 恰等不命中，早 1ms 命中；未来 +1 天恰等不命中", () => {
    expect(has({ messages: [message({ ts_ms: MIN_TS_MS })] }, "TS_INVALID")).toBe(false);
    expect(has({ messages: [message({ ts_ms: MIN_TS_MS - 1 })] }, "TS_INVALID")).toBe(true);
    expect(has({ messages: [message({ ts_ms: NOW_MS + 86_400_000 })] }, "TS_INVALID")).toBe(false);
    expect(has({ messages: [message({ ts_ms: NOW_MS + 86_400_001 })] }, "TS_INVALID")).toBe(true);
    // 非整数 ts_ms（§6.2：「非整数」）
    expect(has({ messages: [message({ ts_ms: TS + 0.5 })] }, "TS_INVALID")).toBe(true);
  });

  it("规则 3 TS_REGRESSION：max(ts) 恰等游标不命中，小于才命中；无游标不命中", () => {
    const cursor = { last_ts_ms: TS, last_message_id: `${CONV}:9` };
    expect(has({ cursor }, "TS_REGRESSION")).toBe(false);
    expect(has({ cursor: { ...cursor, last_ts_ms: TS + 1 } }, "TS_REGRESSION")).toBe(true);
    expect(has({ cursor: null, messages: [message({ ts_ms: 0 })] }, "TS_REGRESSION")).toBe(false);
  });

  it("规则 6 ID_CONFLICT：同 id 且 content/ts 完全一致不命中；任一不同才命中", () => {
    const lookup = () => ({ content: "你好", ts_ms: TS });
    expect(has({ lookup_existing: lookup }, "ID_CONFLICT")).toBe(false);
    expect(
      has({ lookup_existing: () => ({ content: "不一样", ts_ms: TS }) }, "ID_CONFLICT"),
    ).toBe(true);
    expect(
      has({ lookup_existing: () => ({ content: "你好", ts_ms: TS + 1 }) }, "ID_CONFLICT"),
    ).toBe(true);
    expect(has({ lookup_existing: () => null }, "ID_CONFLICT")).toBe(false);
  });

  it("规则 8/9：会话已存在不命中 NEW_CONVERSATION；单聊成员数为 0 不算 GROUP_MEMBER_UNKNOWN", () => {
    expect(has({ conversation: { conversation_id: CONV, kind: "direct", exists: true, member_count: 2 } }, "NEW_CONVERSATION")).toBe(false);
    expect(has({ conversation: { conversation_id: CONV, kind: "direct", exists: true, member_count: 0 } }, "GROUP_MEMBER_UNKNOWN")).toBe(false);
    expect(has({ conversation: { conversation_id: CONV, kind: "group", exists: true, member_count: 0 } }, "GROUP_MEMBER_UNKNOWN")).toBe(true);
    expect(has({ conversation: { conversation_id: CONV, kind: "group", exists: true, member_count: 1 } }, "GROUP_MEMBER_UNKNOWN")).toBe(false);
  });

  it("规则 10 BATCH_QUALITY：失败率恰 1% 不命中，> 1% 命中；total=0 不命中", () => {
    expect(has({ batch: { parsed_failures: 2, total_lines: 200 } }, "BATCH_QUALITY")).toBe(false);
    expect(has({ batch: { parsed_failures: 3, total_lines: 200 } }, "BATCH_QUALITY")).toBe(true);
    expect(has({ batch: { parsed_failures: 1, total_lines: 0 } }, "BATCH_QUALITY")).toBe(false);
  });

  it("规则 5 CONTENT_TYPE_UNKNOWN：命中 exact / prefix 标记不算未知；非 [ < 开头不算；非 text 不算", () => {
    const markers = { exact: ["[图片]"], prefixes: ["[语音"] };
    const unknown = (over: Partial<TierMessageLike>) =>
      has({ messages: [message(over)], content_type_markers: markers }, "CONTENT_TYPE_UNKNOWN");

    expect(unknown({ content: "[图片]" })).toBe(false);
    expect(unknown({ content: "[语音] 0:03" })).toBe(false);
    expect(unknown({ content: "[类型244813135921]" })).toBe(true);
    expect(unknown({ content: "普通文本 [在中间]" })).toBe(false);
    expect(unknown({ content: "[图片]", content_type: "image" })).toBe(false);
    expect(unknown({ content: "   " })).toBe(false);
    // 无 descriptor 标记表 → 从严判定
    expect(has({ messages: [message({ content: "[图片]" })] }, "CONTENT_TYPE_UNKNOWN")).toBe(true);
  });

  it("规则 4 SENDER_UNRESOLVED：空 sender_id 命中；me/system 不参与归因", () => {
    expect(has({ messages: [message({ sender_id: "  " })] }, "SENDER_UNRESOLVED")).toBe(true);
    expect(
      has(
        {
          known_sender_ids: [],
          messages: [
            message({ sender_id: "me", role: "me" }),
            message({ sender_id: "name:系统", role: "system", content_type: "system" }),
          ],
        },
        "SENDER_UNRESOLVED",
      ),
    ).toBe(false);
  });

  it("规则 11 MANUAL_FLAG：空白行忽略；无关值不命中", () => {
    expect(has({ manual_flags: ["  ", ""] }, "MANUAL_FLAG")).toBe(false);
    expect(has({ manual_flags: ["wechat:other"] }, "MANUAL_FLAG")).toBe(false);
    expect(has({ manual_flags: ["name:张三"] }, "MANUAL_FLAG")).toBe(true);
  });

  it("不变量：tier='auto' ⇔ reason_codes 为空集（§6.2 硬门槛 1）", () => {
    const clean = verdictOf({});
    expect(clean.tier).toBe("auto");
    expect(clean.reason_codes).toEqual([]);
    const dirty = verdictOf({ manual_flags: [CONV] });
    expect(dirty.tier).toBe("review");
    expect(dirty.reason_codes.length).toBeGreaterThan(0);
  });
});

describe("§6.2 硬门槛 2/3/4 的边界与组合", () => {
  const gates = (over: Partial<TierGateInput> = {}): TierGateInput => ({
    conversation_id: CONV,
    conversation_exists: true,
    auto_ok_conversation_ids: [],
    batch_quality_failed: false,
    ...over,
  });
  const clean = { tier: "auto" as const, reason_codes: [] as TierReasonCode[] };

  it("门槛 2：白名单 7 个类型全放行；'other' 一律进队列；空集合放行", () => {
    expect([...AUTO_CONTENT_TYPES]).toEqual([
      "text",
      "image",
      "file",
      "link",
      "voice",
      "video",
      "system",
    ]);
    expect(
      TierJudge.enforceHardGates({ verdict: clean, content_types: [...AUTO_CONTENT_TYPES], gates: gates() }),
    ).toEqual({ tier: "auto", reason_codes: [] });
    expect(
      TierJudge.enforceHardGates({ verdict: clean, content_types: ["other"], gates: gates() }).reason_codes,
    ).toEqual(["CONTENT_TYPE_UNKNOWN"]);
    expect(
      TierJudge.enforceHardGates({ verdict: clean, content_types: [], gates: gates() }).tier,
    ).toBe("auto");
  });

  it("门槛 3：会话已存在 → 放行；不存在且在 auto_ok → 放行；不存在且不在 auto_ok → 进队列", () => {
    expect(TierJudge.enforceHardGates({ verdict: clean, content_types: ["text"], gates: gates() }).tier).toBe("auto");
    expect(
      TierJudge.enforceHardGates({
        verdict: clean,
        content_types: ["text"],
        gates: gates({ conversation_exists: false, auto_ok_conversation_ids: [CONV] }),
      }).tier,
    ).toBe("auto");
    expect(
      TierJudge.enforceHardGates({
        verdict: clean,
        content_types: ["text"],
        gates: gates({ conversation_exists: false }),
      }).reason_codes,
    ).toEqual(["NEW_CONVERSATION"]);
  });

  /**
   * 回归用例（§6.2 硬门槛 3 与规则 8 的**真实组合路径**）：
   * `judgeNow` 会先因 `exists=false` 产出 NEW_CONVERSATION，硬门槛 3 的白名单必须能覆盖它。
   * 旧实现只 add 不 delete，导致 auto_ok 永久失效（首采永远进队列）。
   */
  it("门槛 3 × 规则 8：judgeNow 已判 NEW_CONVERSATION 时，auto_ok 白名单必须能放行", () => {
    const judged = verdictOf({
      conversation: { conversation_id: CONV, kind: "direct", exists: false, member_count: 2 },
    });
    // 规则 8 在 judge 阶段先命中，这是预期的第一段
    expect(judged.reason_codes).toContain("NEW_CONVERSATION");

    const gated = TierJudge.enforceHardGates({
      verdict: judged,
      content_types: ["text"],
      gates: gates({ conversation_exists: false, auto_ok_conversation_ids: [CONV] }),
    });
    expect(gated).toEqual({ tier: "auto", reason_codes: [] });
  });

  it("白名单只豁免 NEW_CONVERSATION，不得洗白其它码", () => {
    const judged = verdictOf({
      conversation: { conversation_id: CONV, kind: "direct", exists: false, member_count: 2 },
      messages: [message({ message_id: `${CONV}:sha1:abc` })],
    });
    const gated = TierJudge.enforceHardGates({
      verdict: judged,
      content_types: ["text"],
      gates: gates({ conversation_exists: false, auto_ok_conversation_ids: [CONV] }),
    });
    expect(gated.tier).toBe("review");
    expect(gated.reason_codes).toEqual(["ID_FALLBACK"]);
  });

  it("门槛 4：批次级失败时，即使会话已存在且在白名单也不得自动落档", () => {
    const gated = TierJudge.enforceHardGates({
      verdict: clean,
      content_types: ["text"],
      gates: gates({ auto_ok_conversation_ids: [CONV], batch_quality_failed: true }),
    });
    expect(gated).toEqual({ tier: "review", reason_codes: ["BATCH_QUALITY"] });
  });

  it("门槛 1：reason_codes 非空 → 无论如何不得 auto", () => {
    const gated = TierJudge.enforceHardGates({
      verdict: { tier: "review", reason_codes: ["MANUAL_FLAG"] },
      content_types: ["text"],
      gates: gates({ auto_ok_conversation_ids: [CONV] }),
    });
    expect(gated.tier).toBe("review");
    expect(gated.reason_codes).toContain("MANUAL_FLAG");
  });
});
