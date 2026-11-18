/**
 * 「先读懂，再回话」的理解层。
 *
 * 背景：此前所有语义事故（把「建阳税务局招三个人」说成「我报过、没考上」、
 * 把「写作业吗」当成「你在写作业吗」、把「忙啥呢」用「一堆破事 你呢」弹回去）
 * 都不是措辞问题，而是**模型没有先理解对方这句话**就开口了。
 *
 * 这一层在生成之前单独跑一次小调用，把「对方这句话的预设是什么、成立吗、
 * 是不是在质疑我上一句、我是否必须给实质内容」显式产出来，作为生成阶段的硬输入。
 *
 * 失败（超时 / 空 / JSON 坏）返回 null，调用方退化成原来的单阶段行为——绝不阻断回复。
 *
 * @module @knowself/dsh-plugin/wechat-reading
 */

/** 对方这句话在干什么。 */
export type ReadingIntent = "question" | "challenge" | "share" | "dismiss" | "wrap_up" | "joke";

const INTENTS: readonly ReadingIntent[] = ["question", "challenge", "share", "dismiss", "wrap_up", "joke"];

export interface Reading {
  intent: ReadingIntent;
  /**
   * 这句话隐含的预设，没有就空串。
   * 例：「写作业吗」→「我有作业要写」；「你不是不考公？」→「我考过公」。
   */
  presupposition: string;
  /** 预设是否成立（依据给到的事实列表判断）。 */
  presupposition_holds: boolean;
  /** 这句话是不是在质疑我上一句话。 */
  challenges_my_last_line: boolean;
  /** 我这一轮是否必须给出实质内容（对方在追问时 true）。 */
  must_answer: boolean;
  /** 我这一轮要不要声明自己的实时状态（在哪 / 在忙 / 吃没吃）。 */
  needs_realtime_state: boolean;
}

export interface ReadingFactHint {
  text: string;
  /** "did" = 我亲口说过做过；"saw" = 我看到的信息；"known" = 一般事实。 */
  kind?: string;
}

export interface ReadingInput {
  inbound: string;
  recent: Array<{ role: string; content: string }>;
  facts: ReadingFactHint[];
  /** 我上一句发出去的原话；首次搭话为 null。 */
  lastOwnLine: string | null;
}

const READING_SCHEMA = `{
  "intent": "question|challenge|share|dismiss|wrap_up|joke",
  "presupposition": "这句话隐含的预设；没有就空串",
  "presupposition_holds": true,
  "challenges_my_last_line": false,
  "must_answer": true,
  "needs_realtime_state": false
}`;

/**
 * 构造理解层的 prompt。
 *
 * 只做一件事：把对方这句话**读明白**，不生成回复。
 */
export function buildReadingPrompt(input: ReadingInput): { system: string; user: string } {
  const facts = input.facts.length === 0
    ? "（暂无已确认的事实）"
    : input.facts
        .map((fact) => `- ${fact.text}${fact.kind === "saw" ? "（这是「看到的信息」，不是我做过的事）" : ""}`)
        .join("\n");
  const history = input.recent.length === 0
    ? "（无）"
    : input.recent
        .map((item) => `${item.role === "me" ? "我" : "对方"}：${item.content}`)
        .join("\n");

  const system = [
    "你只负责**读懂**对方这句话，不负责回复。",
    "输出一行 JSON，不要解释、不要代码块。",
    "",
    "要判断的六件事：",
    "1. intent：对方在提问(question) / 质疑我上一句(challenge) / 分享他的事(share) / 敷衍(dismiss) / 收尾下班睡觉(wrap_up) / 开玩笑(joke)。",
    "2. presupposition：这句话里**隐含的假设**。",
    "   例：「写作业吗」隐含「你有作业要写」；「你不是不考公？」隐含「你考过公」；「下班干啥去」隐含「你还没下班」。",
    "   对方只是在陈述事实、没有隐含假设时，填空串。",
    "3. presupposition_holds：这个假设能否被下面的事实支持。**事实里没有证据，就填 false**——宁可不成立，也不要顺着演。",
    "   特别注意：事实里标了「看到的信息」的（如「某单位招三个人」），只能说明我看到了招聘，**不能**说明我报过或考过。",
    "4. challenges_my_last_line：对方是不是在针对我上一句话发问或挑刺。",
    "5. must_answer：对方是不是在追问同一件事、必须给实质内容（是则 true）。",
    "6. needs_realtime_state：我这一轮如果要开口，是否**必须**说明自己在哪/在干什么/吃没吃。",
    "",
    "JSON 结构：",
    READING_SCHEMA,
  ].join("\n");

  const user = [
    `我上一句：${input.lastOwnLine === null ? "（还没开口）" : input.lastOwnLine}`,
    "",
    "最近几条对话（旧→新）：",
    history,
    "",
    "已确认的事实：",
    facts,
    "",
    `对方刚发来的这句：${input.inbound}`,
  ].join("\n");

  return { system, user };
}

/** 把任意值读成布尔；认不出的按 fallback。 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1" || text === "yes") return true;
    if (text === "false" || text === "0" || text === "no") return false;
  }
  return fallback;
}

/**
 * 解析理解层输出。
 *
 * 允许模型在 JSON 前后带散文（真实模型经常这样）；JSON 坏掉或字段缺失过多返回 null。
 */
export function parseReading(raw: string): Reading | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  // intent 是唯一必填的字段：读不出意图，这次理解就没有价值，交给调用方退化。
  const rawIntent = typeof record.intent === "string" ? record.intent.trim().toLowerCase() : "";
  if (!INTENTS.includes(rawIntent as ReadingIntent)) return null;
  const intent = rawIntent as ReadingIntent;

  const presupposition = typeof record.presupposition === "string" ? record.presupposition.trim() : "";

  return {
    intent,
    presupposition,
    // 没有预设时，「成不成立」无所谓，统一给 true 免得下游误判成冲突。
    presupposition_holds: presupposition === "" ? true : readBoolean(record.presupposition_holds, false),
    challenges_my_last_line: readBoolean(record.challenges_my_last_line, false),
    // 追问和质疑默认都需要给实质内容：这是真实事故里最常见的失败模式。
    must_answer: readBoolean(record.must_answer, intent === "question" || intent === "challenge"),
    needs_realtime_state: readBoolean(record.needs_realtime_state, false),
  };
}

/**
 * 把理解结果翻成生成阶段的硬指令。
 *
 * 空串表示这一轮不需要额外约束。
 */
export function formatReadingForPrompt(reading: Reading): string {
  const lines: string[] = [];
  if (reading.presupposition !== "" && !reading.presupposition_holds) {
    lines.push(
      `对方这句话的预设是「${reading.presupposition}」，但事实不支持它。先把这个前提纠正掉，不许顺着它往下演。`,
    );
  } else if (reading.presupposition !== "" && reading.presupposition_holds) {
    lines.push(`对方这句话的预设是「${reading.presupposition}」，事实支持它，可以顺着说。`);
  }
  if (reading.challenges_my_last_line) {
    lines.push("对方在质疑你上一句。正面解释你上一句的依据（你到底在忙什么、你什么时候说过什么），不许换话题、不许反问。");
  }
  if (reading.must_answer) {
    lines.push("对方在追问，必须给出实质内容：不许用「一堆破事」「没什么」糊过去，不许「晚点再说」，不许用「你呢」弹回去。");
  }
  if (reading.needs_realtime_state) {
    lines.push("你要说自己此刻在哪/在干什么/吃没吃，只能用【此刻】里写明的情况；没写就用「在忙」之类的模糊话，绝不给具体状态。");
  }
  return lines.join("\n");
}
