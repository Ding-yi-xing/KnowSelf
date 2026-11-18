import { describe, expect, it } from "vitest";
import { canAskNow, hasQuestionForm, looksLikePlanFragment, parseReplyPlan } from "../src/reply-plan.js";

describe("parseReplyPlan", () => {
  it("reads a one-line JSON plan", () => {
    const plan = parseReplyPlan('{"known":["他在楼下"],"slot":"为什么没回","move":"guess","ask_budget":0,"line":"我猜你是躲人吧"}');
    expect(plan).toMatchObject({
      structured: true,
      line: "我猜你是躲人吧",
      move: "guess",
      slot: "为什么没回",
      askBudget: 0,
      known: ["他在楼下"],
    });
  });

  it("tolerates fenced JSON and surrounding prose", () => {
    const plan = parseReplyPlan('好的，这是本轮回复：\n```json\n{"move":"mirror","ask_budget":1,"line":"在楼下啊"}\n```');
    expect(plan.structured).toBe(true);
    expect(plan.line).toBe("在楼下啊");
    expect(plan.askBudget).toBe(1);
  });

  it("accepts boolean budgets and drops blank facts", () => {
    const plan = parseReplyPlan('{"ask_budget":true,"known":["  ","在楼下"],"line":"然后呢"}');
    expect(plan.askBudget).toBe(1);
    expect(plan.known).toEqual(["在楼下"]);
  });

  it("falls back to plain text when the model ignores the format", () => {
    const plan = parseReplyPlan("在的，咋了");
    expect(plan.structured).toBe(false);
    expect(plan.line).toBe("在的，咋了");
    expect(plan.known).toEqual([]);
  });

  it("rescues a line field even when the surrounding JSON is malformed", () => {
    const plan = parseReplyPlan('{"line":"在楼下" 少了个括号');
    expect(plan.structured).toBe(true);
    expect(plan.line).toBe("在楼下");
  });

  it("treats an empty output as silence", () => {
    expect(parseReplyPlan("   ").line).toBe("");
  });

  it("rescues the line field from a truncated JSON plan", () => {
    // 真实事故：max_tokens 截断后 line 在 known 之后 → 必须仍能救回要发的那句。
    const plan = parseReplyPlan('{"known":["他在楼下"],"slot":"昨晚去哪","move":"guess","ask_budget":0,"line":"我猜你躲人吧"');
    expect(plan.line).toBe("我猜你躲人吧");
    expect(plan.structured).toBe(true);
  });

  it("never sends a JSON fragment without a usable line", () => {
    // 真实事故原样：截断在 known 里，没有 line → 这一轮必须静默。
    const plan = parseReplyPlan('{"known":["对方说去年看过分公司招聘","对方让我看今年的招聘信息');
    expect(plan.line).toBe("");
    expect(looksLikePlanFragment(plan.line)).toBe(false);
  });

  it("refuses any text that still looks like plan structure", () => {
    expect(looksLikePlanFragment('{"known":["x"]')).toBe(true);
    expect(looksLikePlanFragment("[1,2]")).toBe(true);
    expect(looksLikePlanFragment('"ask_budget": 0')).toBe(true);
    expect(looksLikePlanFragment("在楼下")).toBe(false);
  });
});

describe("hasQuestionForm", () => {
  it("flags real questions", () => {
    for (const text of ["你昨晚去哪了？", "在吗", "你住哪儿", "几点回来", "为什么没回", "咋了", "是不是躲人去了", "你人呢", "你昨晚去哪了", "昨晚跟谁一起"]) {
      expect(hasQuestionForm(text), text).toBe(true);
    }
  });

  it("does not flag statements", () => {
    for (const text of ["在楼下", "我猜你是躲人去了吧", "行 早点睡", "冷静", "我昨晚也没睡好"]) {
      expect(hasQuestionForm(text), text).toBe(false);
    }
  });
});

describe("canAskNow", () => {
  const base = { structured: true, askBudget: 1, lastOwnWasQuestion: false, slotAskedBefore: false };

  it("allows a budgeted first-time question", () => {
    expect(canAskNow(base)).toBe(true);
  });

  it("refuses a second direct question in a row", () => {
    expect(canAskNow({ ...base, lastOwnWasQuestion: true })).toBe(false);
  });

  it("refuses when the slot was already asked", () => {
    expect(canAskNow({ ...base, slotAskedBefore: true })).toBe(false);
  });

  it("refuses when the plan gives no budget", () => {
    expect(canAskNow({ ...base, askBudget: 0 })).toBe(false);
    expect(canAskNow({ ...base, askBudget: undefined })).toBe(false);
  });

  it("keeps legacy plain-text replies usable but still blocks consecutive questions", () => {
    expect(canAskNow({ ...base, structured: false, askBudget: undefined })).toBe(true);
    expect(canAskNow({ ...base, structured: false, askBudget: undefined, lastOwnWasQuestion: true })).toBe(false);
  });
});
