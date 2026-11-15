/**
 * 自动归档判定（批次 2 / B2-2）：**规则优先、LLM 兜底**。
 *
 * ## 为什么必须规则优先
 * 15 万条真实数据，全走 LLM 就是 15 万次调用 —— 成本与延迟都不可接受，而且绝大多数
 * 会话根本不需要模型：群聊 20 个人刷屏 vs 单聊 2000 条，人一眼就能分。模型只该处理
 * 「规则说不清」的那一小撮（这也是统计 `ruleCoverage` 的意义）。
 *
 * ## 判定顺序（**不可换**）
 *   1. `discard`：系统消息 / 纯表情 / 公众号服务号 / 空内容 —— 先剔噪，否则后面规则
 *      会把"全是系统消息的群"判成 chat_only 进图谱，图谱上多一个空节点；
 *   2. `material`：出现强记忆意图（"记住…""提醒我…""我的…"）—— 这是**用户明确要求归档**，
 *      优先级高于"这是个群所以只进图谱"；
 *   3. `chat_only`：群聊且发言人数 > `group_speaker_threshold`（默认 5）—— 人多嘴杂，
 *      建档案没有意义，进图谱看关系即可；
 *   4. `person`：单聊且消息数 > `direct_message_threshold`（默认 20）—— 有来有回才值得建档；
 *   5. 其余 → `null`（规则判不了）→ 交 LLM；LLM 也不可用 → `review`（**不阻断导入**）。
 *
 * ## 为什么把规则写成纯函数
 * 规则是本批次唯一需要"反复调阈值"的东西。纯函数 + `ClassifyInput` 快照，
 * 就能在真实数据上离线跑覆盖率（见 `scripts/archive-coverage.mjs`），不用起应用、不写库。
 */

/** 归档目标（与 proposal 的 `suggested_target` 同值域）。 */
export type ArchiveTarget = "person" | "material" | "discard" | "chat_only";

/** 规则/模型给出的判定。 */
export interface ClassifyVerdict {
  /** 建议归档到哪。 */
  target: ArchiveTarget;
  /** 0~1；规则命中给固定值，LLM 给模型自评。 */
  confidence: number;
  /** 谁判的：`rule:<name>` / `llm:<provider>`。用于回溯"这条为什么自动过了"。 */
  classifier: string;
  /** 人可读理由（进 proposal 的 reasoning 尾巴，不覆盖原文）。 */
  reason: string;
}

/** 分类器输入（会话级快照，全部来自已落库数据，不需要重新读 txt）。 */
export interface ClassifyInput {
  /** 会话类型。 */
  kind: "direct" | "group";
  /** 本会话消息条数。 */
  message_count: number;
  /** 不同发言人数（系统消息不计）。 */
  speaker_count: number;
  /** 抽样正文（最多 200 条，够规则用；LLM 也只喂抽样，控制 token）。 */
  samples: readonly string[];
  /** 内容类型直方图（键为 `text` / `image` / `system` …）。 */
  content_types: Readonly<Record<string, number>>;
  /** 会话标题（公众号/服务号判定用）。 */
  title: string;
}

/** 阈值（可被 settings 覆盖；这里给默认值，便于纯函数测试）。 */
export interface ClassifyThresholds {
  /** 群聊"人多"阈值：发言人数 > 该值 → chat_only。 */
  group_speaker_threshold: number;
  /** 单聊"剔噪"阈值：消息数 > 该值才建档（**只用来剔一两句寒暄**，不再承担"值不值得"）。 */
  direct_message_threshold: number;
}

/** 默认阈值。 */
export const DEFAULT_THRESHOLDS: ClassifyThresholds = {
  group_speaker_threshold: 5,
  direct_message_threshold: 3,
};

/** 强记忆意图（命中即 material）。刻意保守：宁可漏判给 LLM，也不要误把闲聊灌进资料库。 */
const MATERIAL_PATTERNS: readonly RegExp[] = [
  // 明确要求"记住"的祈使句
  /记住|记一下|帮我记|别忘了|提醒我|备忘/,
  // 我的 + 强属性（不是"我的天""我的妈"这类语气词：枚举的属性名必须具体）
  /我的(生日|电话|手机号|地址|住址|邮箱|身份证|银行卡|车牌|工号|学号|密码|社保|公积金)/,
  // 文档类名词（合同/体检/成绩单…）：这类内容本质是"资料"，值得进资料库
  // 只用"强文档名词"，**不收** `通知`/`安排表`：实测它们在群聊里极常见（约一分钟一条），
  // 会把 2 个群硬拉成 material。宁可漏判交 LLM，也不要污染资料库。
  /(合同|发票|保单|体检报告|病例|病历|处方|成绩单|证书)/,
];
// ⚠ 刻意**不**收 `我住在/我工作在` 这类句式：
// 真实数据实测（15,969 条）它会命中"等我住进宿舍才算读哈哈哈"这种闲聊，
// 把普通单聊误判成 material（实测误判 1/10 会话）。宁可漏判交 LLM，也不要污染资料库。

/** 公众号 / 服务号 / 系统号的标题特征（真实数据里常见 `xxx公众号`、`服务通知`、`微信团队`）。 */
const OFFICIAL_PATTERNS: readonly RegExp[] = [
  /公众号$|订阅号$|服务号$|企业微信|微信团队|服务通知|微信支付|微信运动|文件传输助手/,
];

/**
 * 判"这行内容有没有信息量"：纯表情 / 纯占位 / 长度 < 2 视为无信息。
 * @param text 单条正文
 */
function hasSubstance(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  // 去掉占位符与表情后还剩什么
  const stripped = t
    .replace(/\[[^\]]{1,12}\]/g, "")
    .replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .trim();
  return stripped.length >= 2;
}

/**
 * 规则层判定（纯函数，无 I/O、无模型）。
 *
 * @param input 会话快照
 * @param thresholds 阈值
 * @returns 命中的判定；`null` 表示规则判不了（该交 LLM 或 review）
 */
export function classifyByRules(
  input: ClassifyInput,
  thresholds: ClassifyThresholds = DEFAULT_THRESHOLDS,
): ClassifyVerdict | null {
  const total = Math.max(0, input.message_count);
  if (total === 0) {
    return { target: "discard", confidence: 0.99, classifier: "rule:empty", reason: "会话没有消息" };
  }

  // ① 公众号 / 服务号
  if (OFFICIAL_PATTERNS.some((pattern) => pattern.test(input.title))) {
    return {
      target: "discard",
      confidence: 0.95,
      classifier: "rule:official-account",
      reason: `标题命中公众号/服务号特征：${input.title}`,
    };
  }

  // ② 系统消息占绝对多数（> 80%）→ 没有对话内容
  const systemCount = input.content_types.system ?? 0;
  if (systemCount / total > 0.8) {
    return {
      target: "discard",
      confidence: 0.9,
      classifier: "rule:system-heavy",
      reason: `系统消息占 ${Math.round((systemCount / total) * 100)}%`,
    };
  }

  // ③ 有信息量的消息太少（纯表情/占位）→ discard
  const substantive = input.samples.filter(hasSubstance).length;
  if (input.samples.length > 0 && substantive / input.samples.length < 0.1) {
    return {
      target: "discard",
      confidence: 0.85,
      classifier: "rule:no-substance",
      reason: `抽样中仅 ${substantive}/${input.samples.length} 条有实质内容`,
    };
  }

  // ④ 强记忆意图 → material（优先于"群聊只进图谱"：用户明确要求记住的东西不该被性别判掉）
  for (const pattern of MATERIAL_PATTERNS) {
    const hit = input.samples.find((sample) => pattern.test(sample));
    if (hit !== undefined) {
      return {
        target: "material",
        confidence: 0.82,
        classifier: "rule:memory-intent",
        reason: `命中记忆意图：${hit.trim().slice(0, 40)}`,
      };
    }
  }

  // ⑤ 单聊、且不是一两句寒暄 → person
  //
  // 阈值从 20 降到 3 之后，它**不再承担"值不值得建档"的判断**，只用来剔掉
  // "在吗/收到"这种没有信息量的一两句。全量实测：单聊消息数 P50=16，
  // 用 20 当门槛会把一半单聊判成 undecided（157/285 的主要来源），那是阈值在替类型做决定。
  if (input.kind === "direct" && total > thresholds.direct_message_threshold) {
    return {
      target: "person",
      confidence: 0.8,
      classifier: "rule:direct-substantial",
      reason: `单聊 ${total} 条消息（阈值 ${thresholds.direct_message_threshold}）`,
    };
  }

  // ⑥ 群聊 → chat_only（**类型优先**：群就是群，进不进图谱与"几个人说过话"无关）
  //
  // 全量实测：135 个群里发言人数 P50=2 —— 大量小群只有两个人说话。
  // 旧规则用"发言人数 > 5"当门槛，把这批全丢进 undecided（55% 的主要来源）。
  // 现在只要不是噪（系统消息/无实质内容已在 ①②③ 剔掉），群一律进图谱。
  if (input.kind === "group") {
    return {
      target: "chat_only",
      confidence: 0.85,
      classifier: "rule:group-chat",
      reason: `群聊（${input.speaker_count} 人发言）只进图谱`,
    };
  }

  return null;
}

/** LLM 分类器的注入面（由调用方接 provider；纯函数模块不 import 任何 provider）。 */
export interface LlmClassifier {
  /**
   * 调模型给出判定。
   * @param input 会话快照
   * @returns 判定；模型不可用/输出不合法时返回 `null`（调用方据此落 review）
   */
  classify(input: ClassifyInput): Promise<ClassifyVerdict | null>;
}

/**
 * 规则优先、LLM 兜底。
 *
 * @param input 会话快照
 * @param options.thresholds 阈值
 * @param options.llm 可选的 LLM 分类器
 * @returns 判定 + 来源标记（`source` 便于统计规则覆盖率）
 */
export async function classifyConversation(
  input: ClassifyInput,
  options: { thresholds?: ClassifyThresholds; llm?: LlmClassifier } = {},
): Promise<{ verdict: ClassifyVerdict | null; source: "rule" | "llm" | "none" }> {
  const byRule = classifyByRules(input, options.thresholds ?? DEFAULT_THRESHOLDS);
  if (byRule !== null) return { verdict: byRule, source: "rule" };

  if (options.llm === undefined) return { verdict: null, source: "none" };
  try {
    const byLlm = await options.llm.classify(input);
    if (byLlm === null) return { verdict: null, source: "none" };
    return { verdict: byLlm, source: "llm" };
  } catch {
    // 模型不可用**不是错误**：落 review，让导入继续（B2-2 第 3 条）
    return { verdict: null, source: "none" };
  }
}
