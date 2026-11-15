/**
 * 批次 2 / B2-2：分类器的**规则层**与 LLM 兜底。
 *
 * 规则是这批唯一要反复调的东西，所以每条规则都给正例 + 反例（尤其"不该命中"的），
 * 并把实测踩到的两个误判写成回归用例：
 *   - "等我住进宿舍才算读哈哈哈" 不许判 material（`我住` 句式太宽，已从规则里删掉）；
 *   - 群聊里满屏"通知" 不许判 material（`通知` 已从文档名词里删掉）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyByRules,
  classifyConversation,
  DEFAULT_THRESHOLDS,
  type ClassifyInput,
  type LlmClassifier,
} from "../src/archive-classifier.js";

/** 造一个分类输入（默认：单聊、100 条、2 人、无强意图）。 */
function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    kind: "direct",
    message_count: 100,
    speaker_count: 2,
    samples: ["今天吃什么", "随便", "那吃面吧"],
    content_types: { text: 100 },
    title: "张三",
    ...over,
  };
}

describe("规则层：命中即定", () => {
  it("公众号/服务号 → discard", () => {
    const v = classifyByRules(input({ title: "某某科技公众号" }));
    expect(v?.target).toBe("discard");
    expect(v?.classifier).toBe("rule:official-account");
  });

  it("系统消息占 80% 以上 → discard", () => {
    const v = classifyByRules(input({ content_types: { system: 90, text: 10 } }));
    expect(v?.target).toBe("discard");
    expect(v?.classifier).toBe("rule:system-heavy");
  });

  it("抽样几乎没实质内容 → discard", () => {
    const v = classifyByRules(input({ samples: ["[表情]", "[图片]", "哦", "[语音]"] }));
    expect(v?.target).toBe("discard");
    expect(v?.classifier).toBe("rule:no-substance");
  });

  it("强记忆意图 → material（优先级高于群聊只进图谱）", () => {
    const v = classifyByRules(
      input({ kind: "group", samples: ["记住我下周三要去体检", "收到"] }),
    );
    expect(v?.target).toBe("material");
    expect(v?.classifier).toBe("rule:memory-intent");
  });

  it("群聊 → chat_only（**类型优先**，与发言人数无关）", () => {
    // 裁定 2：群就是群。2 人说话的群同样进图谱，不再因为"人少"掉进 undecided。
    const twoSpeakers = classifyByRules(input({ kind: "group", speaker_count: 2 }));
    expect(twoSpeakers?.target).toBe("chat_only");
    expect(twoSpeakers?.classifier).toBe("rule:group-chat");
    const many = classifyByRules(input({ kind: "group", speaker_count: 30 }));
    expect(many?.target).toBe("chat_only");
  });

  it("单聊且消息数超阈值 → person", () => {
    const v = classifyByRules(input({ kind: "direct", message_count: DEFAULT_THRESHOLDS.direct_message_threshold + 1 }));
    expect(v?.target).toBe("person");
    expect(v?.classifier).toBe("rule:direct-substantial");
  });

  it("都没有消息 → discard（空会话没有归档价值）", () => {
    expect(classifyByRules(input({ message_count: 0 }))?.target).toBe("discard");
  });

  it("判不了 → null（只剩「单聊且一两句寒暄」这一种）", () => {
    // 类型优先之后，规则只剩一个空档：单聊 + 消息数 ≤ 3。其余都有明确归属。
    const v = classifyByRules(
      input({ kind: "direct", message_count: 2, samples: ["在吗", "在"] }),
    );
    expect(v).toBeNull();
  });
});

describe("规则误判回归（真实数据 15,969 条实测踩到的两条）", () => {
  it("「等我住进宿舍才算读哈哈哈」不许判 material", () => {
    const v = classifyByRules(
      input({ message_count: 1792, samples: ["等我住进宿舍才算读哈哈哈", "哈哈哈哈"] }),
    );
    expect(v?.target).toBe("person");
    expect(v?.classifier).not.toBe("rule:memory-intent");
  });

  it("群聊里满屏「通知」不许判 material", () => {
    const v = classifyByRules(
      input({ kind: "group", speaker_count: 13, samples: ["通知一下", "收到通知了", "发通知了"] }),
    );
    expect(v?.target).toBe("chat_only");
  });
});

describe("LLM 兜底（只处理规则判不了的）", () => {
  it("规则命中时**不调**模型", async () => {
    const llm: LlmClassifier = { classify: vi.fn() };
    const result = await classifyConversation(input({ message_count: 500 }), { llm });
    expect(result.source).toBe("rule");
    expect(llm.classify).not.toHaveBeenCalled();
  });

  it("规则判不了 → 用模型结果", async () => {
    const llm: LlmClassifier = {
      classify: async () => ({ target: "material", confidence: 0.9, classifier: "llm:test", reason: "看起来是资料" }),
    };
    // 5 条单聊现在会被规则判成 person（阈值 3），所以用 2 条才落得到模型
    const result = await classifyConversation(input({ message_count: 2 }), { llm });
    expect(result.source).toBe("llm");
    expect(result.verdict?.target).toBe("material");
  });

  it("模型抛错 → 不算失败，返回 none（调用方落 review，导入继续）", async () => {
    const llm: LlmClassifier = { classify: async () => { throw new Error("model down"); } };
    const result = await classifyConversation(input({ message_count: 2 }), { llm });
    expect(result.source).toBe("none");
    expect(result.verdict).toBeNull();
  });
});
