/**
 * IntentRuleEngine 测试（DESIGN-12 §5.2 / §11.1 第 7 行 T8 的前置）。
 * §5.5 gold 集（n≥200 分层盲标）是独立验收工单；本文件验证判定公式与优先级语义。
 * 全部合成文案（人名只用 张三 / 李四），无真实聊天内容。
 */
import { describe, expect, it } from "vitest";
import type { MiningMessageRow } from "@knowself/person-store";
import { INTENT_PRODUCED_BY } from "../src/constants";
import { classifyMessage, classifyMessages } from "../src/intent-engine";

const NOW = "2026-09-10T10:00:00+08:00";
let counter = 0;

function msg(content: string, overrides: Partial<MiningMessageRow> = {}): MiningMessageRow {
  counter += 1;
  return {
    message_id: `m-${counter}`,
    conversation_id: "wechat:conv-1",
    platform: "wechat",
    role: "other",
    sender_id: "wxid_aaaaaaaaaaaa22",
    sender_person_id: "person-zhangsan",
    ts_ms: 1_000,
    msg_date: "2026-09-10",
    content,
    content_type: "text",
    reply_to: null,
    meta: "{}",
    ...overrides,
  };
}

describe("classifyMessage（L0 判定公式，§5.2）", () => {
  it("词典命中且分差 ≥ DELTA → 定类，confidence=min(1, score/3)", () => {
    const result = classifyMessage(msg("这个怎么退款啊，请给我订单号"));
    expect(result?.intent).toBe("after_sales");
    expect(result?.ambiguous).toBe(false);
    expect(result?.matchedRules).toEqual(
      expect.arrayContaining(["lexicon:after_sales:退款", "lexicon:after_sales:订单号"]),
    );
  });

  it("金额正则命中 finance；类间冲突按优先级裁决", () => {
    const result = classifyMessage(msg("转账 ¥100 给你，尾款"));
    expect(result?.intent).toBe("finance"); // finance 优先级最高
    expect(result?.matchedRules).toContain("regex:amount");
  });

  it("零命中 → other, confidence=0", () => {
    const result = classifyMessage(msg("……"));
    expect(result?.intent).toBe("other");
    expect(result?.confidence).toBe(0);
  });

  it("分差 < DELTA → ambiguous=true, confidence=0.5", () => {
    const result = classifyMessage(msg("怎么报名")); // consult(怎么)=1 vs notice(报名)=1 → 分差 0
    expect(result?.ambiguous).toBe(true);
    expect(result?.confidence).toBe(0.5);
    expect(result?.rivals).toContain("consult");
  });

  it("结构硬规则：system 内容直接 notice；recalled 不参与打标", () => {
    expect(classifyMessage(msg("", { content_type: "system" }))?.intent).toBe("notice");
    expect(classifyMessage(msg("你好", { meta: '{"recalled":true}' }))).toBeNull();
  });

  it("否定词清零该类", () => {
    const result = classifyMessage(msg("不用问怎么弄"));
    expect(result?.intent).not.toBe("consult");
  });
});

describe("classifyMessages（上下文 tie-break，§5.2）", () => {
  it("并列时邻居不命中并列集合 → 保持 ambiguous", () => {
    const rows = classifyMessages(
      [
        msg("售后的问题请问怎么处理", { message_id: "m-101" }), // after_sales 高分 → 非并列
        msg("怎么报名", { message_id: "m-102" }), // consult vs notice 并列
      ],
      undefined,
      NOW,
    );
    const m2 = rows.find((r) => r.message_id === "m-102");
    // m-101 已判定 after_sales；m-102 的并列集合 {notice, consult} 均未命中邻居 → 保持 ambiguous
    expect(m2?.ambiguous).toBe(true);
    expect(m2?.produced_by).toBe(INTENT_PRODUCED_BY);
  });

  it("邻居命中并列集合 → tie-break 胜出且置信度 ≥ 0.6", () => {
    const rows = classifyMessages(
      [
        msg("怎么报名", { message_id: "m-201" }), // consult(怎么)=1 vs notice(报名)=1 并列 → top1=notice（优先级）
        msg("怎么报名", { message_id: "m-202" }), // 同样并列；邻居 m-201 已判定 notice → 命中并列集合
      ],
      undefined,
      NOW,
    );
    const m2 = rows.find((r) => r.message_id === "m-202");
    expect(m2?.ambiguous).toBe(false);
    expect(m2?.intent).toBe("notice");
    expect(m2?.matched_rules).toContain("context_tiebreak");
    expect(m2?.confidence).toBeGreaterThanOrEqual(0.6);
  });
});
