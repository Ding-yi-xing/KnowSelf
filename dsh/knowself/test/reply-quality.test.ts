import { describe, expect, it } from "vitest";
import {
  cleanReplyBody,
  compactHistory,
  compactReplyContext,
  containsSensitiveDisclosure,
  debounceGate,
  detectCommitment,
  deflectsQuestion,
  detectCriticTone,
  detectSelfContradiction,
  detectSensitiveAsk,
  detectStaleCompletion,
  detectTopicRedirect,
  emojiAllowance,
  extractEmoji,
  filterEmoji,
  findUnsupportedTimeWord,
  formatClock,
  formatHistoryLines,
  isRepetitiveReply,
  isFarewell,
  isRealEmoji,
  isShortAck,
  mergeLiveHistory,
  missesQuestion,
  normalizeForRepeat,
  questionKeywords,
  sameOpenerStreak,
  stallsAnswer,
  stripChatEmoji,
  styleExamples,
} from "../src/reply-quality.js";

describe("cleanReplyBody", () => {
  it("strips the leading list marker that leaked into a real reply", () => {
    // 真实事故：模型发出去的是「1 你昨晚没回宿舍啊」。
    expect(cleanReplyBody("1 你昨晚没回宿舍啊")).toBe("你昨晚没回宿舍啊");
    expect(cleanReplyBody("1. 在楼下")).toBe("在楼下");
    expect(cleanReplyBody("- 刚下楼")).toBe("刚下楼");
  });

  it("removes wrapping quotes, markdown marks and a 回复: prefix", () => {
    expect(cleanReplyBody("「在楼下」")).toBe("在楼下");
    expect(cleanReplyBody("**好的**")).toBe("好的");
    expect(cleanReplyBody("回复：刚看到")).toBe("刚看到");
  });

  it("keeps only the first meaningful line", () => {
    expect(cleanReplyBody("在楼下\n（这是解释，不该发出去）")).toBe("在楼下");
  });

  it("returns an empty string when the model said nothing", () => {
    expect(cleanReplyBody("   \n  ")).toBe("");
  });

  it("strips randomly appended WeChat bracket emoji and unicode emoji", () => {
    expect(cleanReplyBody("那你这运动量够了[坏笑]")).toBe("那你这运动量够了");
    expect(cleanReplyBody("猜你今天又没闲着[呲牙]")).toBe("猜你今天又没闲着");
    expect(cleanReplyBody("跟我比我这运动量直接零分[旺柴]")).toBe("跟我比我这运动量直接零分");
    expect(cleanReplyBody("好的😊")).toBe("好的");
  });
});

describe("normalizeForRepeat", () => {
  it("drops whitespace and punctuation so paraphrases line up", () => {
    expect(normalizeForRepeat("你昨晚没回宿舍，去哪了？")).toBe("你昨晚没回宿舍去哪了");
  });
});

describe("isRepetitiveReply", () => {
  it("catches the real paraphrase loop (same question, different wording)", () => {
    const sent = ["昨晚没见你回宿舍 哪去了"];
    expect(isRepetitiveReply("你昨晚没回宿舍 去哪了", sent)).toBe(true);
  });

  it("catches a sentence that merely wraps the previous one", () => {
    const sent = ["昨晚没回宿舍去哪了"];
    expect(isRepetitiveReply("所以你昨晚没回宿舍去哪了", sent)).toBe(true);
  });

  it("does not flag a genuinely different follow-up", () => {
    const sent = ["你昨晚没回宿舍去哪了"];
    expect(isRepetitiveReply("那现在是刚回宿舍？", sent)).toBe(false);
    expect(isRepetitiveReply("行，不问了，你忙吧", sent)).toBe(false);
  });

  it("never fuzzy-matches short messages that naturally repeat", () => {
    expect(isRepetitiveReply("好呀", ["好"])).toBe(false);
    expect(isRepetitiveReply("在楼下", ["楼下"])).toBe(false);
    // 完全相同仍然判重复
    expect(isRepetitiveReply("楼下", ["楼下"])).toBe(true);
  });
});

describe("time grounding", () => {
  const nowMs = Date.parse("2026-11-17T13:08:00+08:00");

  it("renders today's clock and keeps the date for older messages", () => {
    expect(formatClock(Date.parse("2026-11-17T13:05:00+08:00"), nowMs)).toBe("13:05");
    expect(formatClock(Date.parse("2026-11-14T22:41:00+08:00"), nowMs)).toBe("11-14 22:41");
    expect(formatClock(undefined, nowMs)).toBe("");
  });

  it("labels each history line with time and speaker so tense can be inferred", () => {
    const lines = formatHistoryLines([
      { role: "them", content: "打电话问过了", ts_ms: Date.parse("2026-11-17T13:05:00+08:00") },
      { role: "me", content: "行", ts_ms: Date.parse("2026-11-17T13:05:30+08:00") },
    ], nowMs);
    expect(lines).toEqual(["[13:05] 对方：打电话问过了", "[13:05] 我：行"]);
  });
});

describe("styleExamples", () => {
  it("collects the user's own short lines as the voice reference", () => {
    const examples = styleExamples([
      { role: "them", content: "现在非常的激动我说实话" },
      { role: "me", content: "冷静" },
      { role: "me", content: "越不冷静越容易忘" },
      { role: "me", content: "https://example.com/very-long-link-should-be-skipped" },
      { role: "me", content: "冷静" },
      { role: "me", content: "这是一条超过四十个字的超长消息，明显是模型或者通知写出来的东西，不像打字聊天，应该被过滤掉" },
    ]);
    expect(examples).toEqual(["冷静", "越不冷静越容易忘"]);
  });
});

describe("findUnsupportedTimeWord", () => {
  it("catches a future date the other person never mentioned", () => {
    // 真实事故：对方说「要去鲤城区」（今天去），代理回「明天几点去」。
    expect(findUnsupportedTimeWord("鲤城区哪家 明天几点去", "要去鲤城区 医大二院做不")).toBe("明天");
  });

  it("accepts a future date the other person did say", () => {
    expect(findUnsupportedTimeWord("明天几点到", "他说周一了 明天去体检")).toBeUndefined();
  });

  it("does not police past-time references that are normally legitimate", () => {
    expect(findUnsupportedTimeWord("你昨晚没回宿舍啊", "在吗")).toBeUndefined();
  });
});

describe("mergeLiveHistory", () => {
  it("appends live messages the indexed context does not have yet", () => {
    const indexed = [{ role: "them", content: "在吗", ts_ms: 1000 }];
    const live = [
      { role: "them", content: "在吗", ts_ms: 1000 },
      { role: "me", content: "咋了", ts_ms: 2000 },
      { role: "them", content: "楼下", ts_ms: 3000 },
    ];
    expect(mergeLiveHistory(indexed, live).map((item) => item.content)).toEqual(["在吗", "咋了", "楼下"]);
  });

  it("keeps the newest end of the conversation when over the limit", () => {
    const indexed = Array.from({ length: 30 }, (_, index) => ({ role: "them", content: `旧${index}`, ts_ms: index }));
    const live = [{ role: "them", content: "最新", ts_ms: 99 }];
    const merged = mergeLiveHistory(indexed, live, 5);
    expect(merged).toHaveLength(5);
    expect(merged.at(-1)?.content).toBe("最新");
  });
});

describe("compactHistory", () => {
  it("collapses consecutive duplicates so the model does not see 楼下 x N", () => {
    const history = [
      { role: "me", content: "你昨晚去哪了" },
      { role: "them", content: "楼下" },
      { role: "them", content: "楼下" },
      { role: "them", content: "楼下" },
      { role: "me", content: "那你干嘛去了" },
    ];
    expect(compactHistory(history).map((item) => item.content))
      .toEqual(["你昨晚去哪了", "楼下", "那你干嘛去了"]);
  });

  it("keeps non-adjacent repeats and caps the length", () => {
    const history = [
      { role: "them", content: "在吗" },
      { role: "me", content: "在" },
      { role: "them", content: "在吗" },
      { role: "me", content: "在" },
      { role: "them", content: "在吗" },
    ];
    expect(compactHistory(history).map((item) => item.content))
      .toEqual(["在吗", "在", "在吗", "在", "在吗"]);
    expect(compactHistory([...history, ...history], 3)).toHaveLength(3);
  });
});

describe("detectSensitiveAsk", () => {
  it("flags the classic scam/fishing vectors", () => {
    expect(detectSensitiveAsk("把你身份证号发我一下")).toBe("证件号");
    expect(detectSensitiveAsk("你家住哪 发个定位")).toBe("住址/位置");
    expect(detectSensitiveAsk("最近工资多少啊")).toBe("工作单位/收入");
    expect(detectSensitiveAsk("借我五千块周转一下")).toBe("借钱/转账");
  });

  it("stays quiet on ordinary chat", () => {
    expect(detectSensitiveAsk("晚上出来吃饭吗")).toBeUndefined();
    expect(detectSensitiveAsk("你昨晚去哪了")).toBeUndefined();
  });
});

describe("containsSensitiveDisclosure", () => {
  it("catches a leaked ID / phone number / bank card in a draft", () => {
    expect(containsSensitiveDisclosure("我身份证是110101199003078888")).toBe("证件号");
    expect(containsSensitiveDisclosure("打这个号13800138000")).toBe("手机号");
    expect(containsSensitiveDisclosure("卡号6222020200112233445")).toBe("银行卡号");
  });

  it("ignores short numbers and ordinary text", () => {
    expect(containsSensitiveDisclosure("我在3号楼等你")).toBeUndefined();
    expect(containsSensitiveDisclosure("晚上八点见")).toBeUndefined();
  });
});

describe("detectTopicRedirect", () => {
  it("flags an explicit topic redirect or refusal", () => {
    expect(detectTopicRedirect("别扯开话题，现在背诵")).toBe("别扯开话题");
    expect(detectTopicRedirect("一首抵一个问题，没得商量")).toBe("没得商量");
    expect(detectTopicRedirect("先别说这个了")).toBe("先做别的/换个话题");
  });

  it("stays quiet on ordinary chat", () => {
    expect(detectTopicRedirect("可以")).toBeUndefined();
    expect(detectTopicRedirect("你背一下就知道了")).toBeUndefined();
  });
});

describe("isShortAck", () => {
  it("recognizes one-word acknowledgements", () => {
    expect(isShortAck("可以")).toBe(true);
    expect(isShortAck("嗯")).toBe(true);
    expect(isShortAck("行吧")).toBe(true);
  });

  it("rejects real content and longer messages", () => {
    expect(isShortAck("别扯开话题，现在背诵")).toBe(false);
    expect(isShortAck("你背一下，就知道了")).toBe(false);
  });
});

describe("stripChatEmoji", () => {
  it("removes WeChat bracket emoji and collapses the trailing space", () => {
    expect(stripChatEmoji("够了[坏笑]")).toBe("够了");
    expect(stripChatEmoji("行[旺柴]")).toBe("行");
  });

  it("removes unicode emoji", () => {
    expect(stripChatEmoji("好的😊")).toBe("好的");
    expect(stripChatEmoji("在吗 👋")).toBe("在吗");
  });

  it("keeps normal text untouched", () => {
    expect(stripChatEmoji("你今晚几点回来")).toBe("你今晚几点回来");
  });
});

describe("compactReplyContext", () => {
  const items = [
    { role: "them", content: "<msg><img aeskey=\"x\"/></msg>", ts_ms: 1 },
    { role: "them", content: "楼下", ts_ms: 2 },
    { role: "me", content: "楼下", ts_ms: 3 },
    { role: "them", content: "很长很长的一段话".repeat(10), ts_ms: 4 },
  ];

  it("drops XML bodies, dedupes and truncates for token efficiency", () => {
    const compacted = compactReplyContext(items, { maxPerMessage: 20, limit: 10 });
    expect(compacted.some((item) => item.content.startsWith("<"))).toBe(false);
    expect(compacted.map((item) => item.content)).toEqual(["楼下", "楼下", "很长很长的一段话很长很长的一段话很长很长…"]);
  });

  it("keeps the newest end when over the limit", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ role: "them", content: `第${index}条`, ts_ms: index }));
    const compacted = compactReplyContext(many, { limit: 3 });
    expect(compacted.map((item) => item.content)).toEqual(["第27条", "第28条", "第29条"]);
  });
});

describe("detectCommitment", () => {
  it("flags strong promises made on the user's behalf", () => {
    expect(detectCommitment("我保证给你答复")).toBe("我保证");
    expect(detectCommitment("我答应明天过去")).toBe("我答应");
    expect(detectCommitment("包在我身上")).toBe("包在我身上");
  });

  it("does not flag guessing or opinion", () => {
    expect(detectCommitment("我猜你今天没出门")).toBeUndefined();
    expect(detectCommitment("我觉得还行")).toBeUndefined();
  });
});

describe("debounceGate", () => {
  const empty = { pendingId: null, pendingSince: 0, burstStart: 0 };

  it("waits for the quiet window on a single message", () => {
    const first = debounceGate({ newestId: "a", now: 1000, debounceMs: 3000, debounceMaxMs: 10000, state: empty });
    expect(first.wait).toBe(true);
    const later = debounceGate({ newestId: "a", now: 4000, debounceMs: 3000, debounceMaxMs: 10000, state: first.state });
    expect(later.wait).toBe(false);
  });

  it("resets the quiet timer when a newer message arrives", () => {
    const first = debounceGate({ newestId: "a", now: 1000, debounceMs: 3000, debounceMaxMs: 10000, state: empty });
    const second = debounceGate({ newestId: "b", now: 3500, debounceMs: 3000, debounceMaxMs: 10000, state: first.state });
    expect(second.wait).toBe(true);
    const third = debounceGate({ newestId: "b", now: 6500, debounceMs: 3000, debounceMaxMs: 10000, state: second.state });
    expect(third.wait).toBe(false);
  });

  it("replies anyway once the burst hits the max wait", () => {
    let state = debounceGate({ newestId: "a", now: 0, debounceMs: 3000, debounceMaxMs: 5000, state: empty }).state;
    // 对方每 1s 发一条，静默计时一直被打断，但 burst 超过 5s 后必须回。
    state = debounceGate({ newestId: "b", now: 1000, debounceMs: 3000, debounceMaxMs: 5000, state }).state;
    state = debounceGate({ newestId: "c", now: 2000, debounceMs: 3000, debounceMaxMs: 5000, state }).state;
    state = debounceGate({ newestId: "d", now: 3000, debounceMs: 3000, debounceMaxMs: 5000, state }).state;
    state = debounceGate({ newestId: "e", now: 4000, debounceMs: 3000, debounceMaxMs: 5000, state }).state;
    const capped = debounceGate({ newestId: "f", now: 5000, debounceMs: 3000, debounceMaxMs: 5000, state });
    expect(capped.wait).toBe(false);
  });

  it("never waits when debounce is disabled", () => {
    const result = debounceGate({ newestId: "a", now: 1000, debounceMs: 0, debounceMaxMs: 0, state: empty });
    expect(result.wait).toBe(false);
  });
});

describe("sameOpenerStreak", () => {
  it("catches the 我猜 template repeating in a burst", () => {
    // 真实事故：陈炜那段 9 条里 5 条以「我猜」开头，整句相似度守卫抓不到。
    const recent = ["我猜还是老几样", "那我猜鸡腿堡加可乐", "点个饭跟搞地下工作似的"];
    expect(sameOpenerStreak("我猜是中杯可乐那套", recent)).toBe("我猜");
  });

  it("does not fire on the first occurrence of an opener", () => {
    expect(sameOpenerStreak("我猜是中杯可乐那套", ["塔斯汀可以", "点个饭跟搞地下工作似的"])).toBeUndefined();
  });
});

describe("detectCriticTone", () => {
  it("flags the观察者口吻 that leaked into a real reply", () => {
    expect(detectCriticTone("骂人还挺快 装完记得给反馈")).toBe("点评对方");
    expect(detectCriticTone("哟 还真就一个嗯 气性不小")).toBe("点评对方");
    expect(detectCriticTone("刚嫌我无聊 转头问我天气 你挺会转弯阿")).toBe("点评对方");
  });

  it("leaves plain chat alone", () => {
    expect(detectCriticTone("我中午也随便吃的")).toBeUndefined();
    expect(detectCriticTone("装了阿 不然我升级个啥")).toBeUndefined();
  });
});

describe("missesQuestion", () => {
  it("flags a reply that only评价 and never answers", () => {
    expect(missesQuestion("刚嫌我无聊 转头问我天气 你挺会转弯阿", true)).toBe(true);
  });

  it("accepts a reply that answers", () => {
    expect(missesQuestion("就软件升级了", true)).toBe(false);
    expect(missesQuestion("装了阿 不然我升级个啥", true)).toBe(false);
  });

  it("does nothing when the inbound is not a question", () => {
    expect(missesQuestion("刚嫌我无聊 转头问我天气 你挺会转弯阿", false)).toBe(false);
  });
});

describe("deflectsQuestion", () => {
  it("catches bouncing the question back without answering", () => {
    // 真实事故：对方问「忙啥呢」→「一堆破事 脑子都木了 你呢 下班干啥去」。
    expect(deflectsQuestion("一堆破事 脑子都木了 你呢 下班干啥去", true)).toBe(true);
  });

  it("allows a real answer followed by a question back", () => {
    expect(deflectsQuestion("我挺好的 你呢", true)).toBe(false);
    expect(deflectsQuestion("一堆破事 你呢", false)).toBe(false);
  });
});

describe("questionKeywords", () => {
  it("keeps the substance of the question", () => {
    expect(questionKeywords("忙啥呢")).toContain("忙啥");
    expect(questionKeywords("你装了吗")).toContain("你装");
    expect(questionKeywords("ok?")).toEqual([]);
  });
});

describe("stallsAnswer", () => {
  it("catches stalling on a follow-up question", () => {
    // 真实事故：对方追问「忙啥呢」→「累一天了 先躺会儿 作业晚点再说」。
    expect(stallsAnswer("累一天了 先躺会儿 作业晚点再说", true)).toBe(true);
  });

  it("only applies when the contact actually asked something", () => {
    expect(stallsAnswer("回头再说", false)).toBe(false);
    expect(stallsAnswer("刚忙完 在改代码", true)).toBe(false);
  });
});

describe("detectStaleCompletion", () => {
  it("catches asking about something the contact already finished", () => {
    // 对方 19:04 说「下了」，19:06 代理问「下班干啥去」。
    expect(detectStaleCompletion("一堆破事 脑子都木了 你呢 下班干啥去", "下了")).toBe("下了→下班");
  });

  it("leaves normal replies alone", () => {
    expect(detectStaleCompletion("那挺好的 早点休息", "下了")).toBeUndefined();
    expect(detectStaleCompletion("下班干啥去", "还没")).toBeUndefined();
  });
});

describe("detectSelfContradiction", () => {
  it("catches the two-minute翻供 from the audit", () => {
    // 10:12「装了阿 不然我升级个啥」→ 10:14「哦 那这个我真没装」。
    expect(detectSelfContradiction("哦 那这个我真没装 我说的是时间线", ["装了阿 不然我升级个啥"])).toBe("装了→没装");
  });

  it("ignores unrelated statements", () => {
    expect(detectSelfContradiction("就先把时间线捋顺", ["装了阿 不然我升级个啥"])).toBeUndefined();
  });
});

describe("styleExamples exclude", () => {
  it("drops lines the automation sent itself", () => {
    const items = [
      { role: "me" as const, content: "回来了吗" },
      { role: "me" as const, content: "我猜是中杯可乐那套" },
    ];
    const exclude = new Set([normalizeForRepeat("我猜是中杯可乐那套")]);
    expect(styleExamples(items, 8, exclude)).toEqual(["回来了吗"]);
  });
});

describe("extractEmoji", () => {
  it("finds both WeChat bracket codes and unicode emoji", () => {
    expect(extractEmoji("行吧[旺柴]")).toEqual(["[旺柴]"]);
    expect(extractEmoji("真的假的🧐")).toEqual(["🧐"]);
    expect(extractEmoji("没表情")).toEqual([]);
  });

  it("ignores export placeholders like [类型50]", () => {
    // 真实事故：模型把 [类型50] 当表情发给了杨子杰。
    expect(extractEmoji("刚下班[类型50]")).toEqual([]);
    expect(extractEmoji("[图片]")).toEqual([]);
    expect(isRealEmoji("[类型50]")).toBe(false);
    expect(isRealEmoji("[旺柴]")).toBe(true);
  });
});

describe("filterEmoji", () => {
  it("keeps only the emoji the user actually uses", () => {
    const allowed = new Set(["[旺柴]"]);
    expect(filterEmoji("行吧[旺柴]", allowed).text).toBe("行吧[旺柴]");
    // 真实事故：模型自己在语境不搭的地方挂了个 [呲牙]。
    const dropped = filterEmoji("行吧[呲牙]", allowed);
    expect(dropped.text).toBe("行吧");
    expect(dropped.dropped).toEqual(["[呲牙]"]);
  });

  it("strips everything when the set is empty", () => {
    expect(filterEmoji("行吧[旺柴]🧐", new Set()).text).toBe("行吧");
  });

  it("strips placeholders even when they are in the allowed set", () => {
    // 旧画像可能已经把 [类型50] 收进库了，这里必须强制剥掉。
    const allowed = new Set(["[类型50]"]);
    const result = filterEmoji("我这刚下班 晚上准备干点啥去[类型50]", allowed);
    expect(result.text).toBe("我这刚下班 晚上准备干点啥去");
    expect(result.dropped).toEqual(["[类型50]"]);
  });
});

describe("isFarewell", () => {
  it("only treats real wrap-ups as permission to stay silent", () => {
    expect(isFarewell("晚安")).toBe(true);
    expect(isFarewell("先睡了 明早聊")).toBe(true);
    // 敷衍/表情/英文都不算收尾：产品要求「敷衍也不要停」。
    expect(isFarewell("哦")).toBe(false);
    expect(isFarewell("🤔")).toBe(false);
    expect(isFarewell("I can't understand Chinese")).toBe(false);
  });
});

describe("emojiAllowance", () => {
  it("follows the measured rate", () => {
    expect(emojiAllowance(0.05, () => 0.04)).toBe(true);
    expect(emojiAllowance(0.05, () => 0.06)).toBe(false);
    expect(emojiAllowance(0, () => 0)).toBe(false);
  });
});
