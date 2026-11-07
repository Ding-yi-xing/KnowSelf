/**
 * 意图词典（DESIGN-12 §5.2 L0 规则层的数据部分）。
 * 设计定位是数据文件 `data/mining/intent-lexicon.json`（用户可改不改代码）；
 * 当前以 TS 常量承载（与 chat-ingest 的 descriptor 同做法），**结构即未来 JSON 的 schema**：
 * 每类 = 词条（词 + 权重）+ 否定词（命中即该类清零）。P2 时抽成 JSON 加载，引擎接口不变。
 * 种子版每类 5~8 词（§5.1 判据摘要的典型触发词）；扩词不改代码结构。
 */
import type { IntentKind } from "@knowself/person-store";

export interface LexiconWord {
  w: string;
  weight: number;
}

export interface LexiconEntry {
  words: readonly LexiconWord[];
  /** 命中否定词 → 该类分数清零（如 "不用问" 不该算 consult）。 */
  negations: readonly string[];
}

export type IntentLexicon = Record<IntentKind, LexiconEntry>;

export const INTENT_LEXICON: IntentLexicon = {
  consult: {
    words: [
      { w: "怎么", weight: 1 },
      { w: "如何", weight: 1 },
      { w: "请问", weight: 1 },
      { w: "哪", weight: 0.5 },
      { w: "多少", weight: 0.5 },
      { w: "能不能", weight: 1 },
      { w: "吗", weight: 0.5 },
      { w: "推荐", weight: 1 },
    ],
    negations: ["不用问", "别问", "不用介绍"],
  },
  after_sales: {
    words: [
      { w: "退款", weight: 2 },
      { w: "退货", weight: 2 },
      { w: "售后", weight: 2 },
      { w: "维修", weight: 2 },
      { w: "发票", weight: 1.5 },
      { w: "订单号", weight: 1.5 },
      { w: "投诉", weight: 2 },
      { w: "坏了", weight: 1.5 },
    ],
    negations: [],
  },
  business: {
    words: [
      { w: "合作", weight: 2 },
      { w: "报价", weight: 2 },
      { w: "合同", weight: 2 },
      { w: "签约", weight: 2 },
      { w: "渠道", weight: 1.5 },
      { w: "分成", weight: 1.5 },
      { w: "对接", weight: 1 },
    ],
    negations: [],
  },
  work: {
    words: [
      { w: "会议", weight: 1.5 },
      { w: "排期", weight: 1.5 },
      { w: "进度", weight: 1.5 },
      { w: "需求", weight: 1 },
      { w: "上线", weight: 1.5 },
      { w: "评审", weight: 1.5 },
      { w: "交付", weight: 1.5 },
      { w: "周报", weight: 1.5 },
    ],
    negations: [],
  },
  social: {
    words: [
      { w: "哈哈", weight: 1 },
      { w: "在吗", weight: 0.5 },
      { w: "吃了吗", weight: 0.5 },
      { w: "周末", weight: 0.5 },
      { w: "天气", weight: 0.5 },
      { w: "生日快乐", weight: 1.5 },
      { w: "好久不见", weight: 1 },
    ],
    negations: [],
  },
  family: {
    words: [
      { w: "爸妈", weight: 2 },
      { w: "孩子", weight: 1.5 },
      { w: "接娃", weight: 2 },
      { w: "回家", weight: 1.5 },
      { w: "买菜", weight: 1.5 },
      { w: "做饭", weight: 1.5 },
      { w: "家里", weight: 1 },
    ],
    negations: [],
  },
  finance: {
    words: [
      { w: "转账", weight: 2 },
      { w: "借", weight: 1.5 },
      { w: "还钱", weight: 2 },
      { w: "红包", weight: 1.5 },
      { w: "账", weight: 1 },
      { w: "付款", weight: 2 },
      { w: "尾款", weight: 2 },
      { w: "打款", weight: 2 },
    ],
    negations: [],
  },
  notice: {
    words: [
      { w: "公告", weight: 2 },
      { w: "通知", weight: 1.5 },
      { w: "@所有人", weight: 2 },
      { w: "报名", weight: 1 },
      { w: "活动", weight: 1 },
    ],
    negations: [],
  },
  other: { words: [], negations: [] },
};
