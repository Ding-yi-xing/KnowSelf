/**
 * 「先规划、再出话」的单次调用结构（方案 A）。
 *
 * 背景：2026-11-17 实测，回复代理把「套出信息」直接执行成审问——用户要求是
 * **在聊天里慢慢套**，模型却张口就问。YIELD（ACL 2026，Information Elicitation Agents）、
 * ASTRO（ACL 2025 Findings）与 MA²P（ACL 2026 Findings）的共识是：把「策略」和「措辞」分开，
 * 策略层决定本轮用什么动作（接话/调侃/猜测/自曝/共情/直接问/留白），措辞层只负责把话说得像人。
 *
 * 我们不做两次模型调用（会多 2~4 秒），而是让模型在**一次输出**里同时给结构化计划和正文：
 *
 * ```json
 * {"known":["他在楼下"],"slot":"为什么整晚没回","move":"guess","ask_budget":0,"line":"我猜你是躲人吧"}
 * ```
 *
 * 这里只做纯函数：解析、问句判定、提问预算。策略执行在 worker 里。
 *
 * @module @knowself/dsh-plugin/reply-plan
 */

/** 允许的对话动作；`ask_direct` 才是"直接问"，默认应当少用。 */
export const REPLY_MOVES = [
  "mirror",       // 接住对方的话
  "tease",        // 调侃
  "guess",        // 猜测式试探（套话主力）
  "self_disclose",// 自曝一点换对方信息
  "empathize",    // 共情
  "ask_direct",   // 直接提问（必须有预算）
  "silent",       // 这轮不发
] as const;

export type ReplyMove = (typeof REPLY_MOVES)[number];

export interface ReplyPlan {
  /** 要发出去的正文（未清洗）。 */
  line: string;
  /** 模型声明的本轮动作。 */
  move?: string;
  /** 本轮是否允许直接提问（0/1）。 */
  askBudget?: number;
  /** 本轮想推进的信息点。 */
  slot?: string;
  /** 对话里已确认的事实。 */
  known: string[];
  /** 是否成功解析出结构化计划；false 表示模型只回了纯文本，按老路径处理。 */
  structured: boolean;
}

/** 从任意文本里抠出第一个平衡的 JSON 对象（模型常带说明文字或围栏）。 */
function firstJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}

/** 读取字符串字段并去空白。 */
function readText(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** 读取 0/1 预算（也接受 true/false / 0..1 的字符串）。 */
function readBudget(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return value >= 1 ? 1 : 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1") return 1;
    if (text === "false" || text === "0") return 0;
  }
  return undefined;
}

/** 读取字符串数组（最多 8 条，去空去重）。 */
function readFacts(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  const facts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text === "" || facts.includes(text)) continue;
    facts.push(text);
    if (facts.length >= 8) break;
  }
  return facts;
}

/**
 * 解析模型输出为回复计划。
 *
 * 容错策略：模型没按 JSON 回（或 JSON 坏了）就退回"整段当正文"，保证不会因为格式把回复弄没。
 *
 * @param raw - 模型原始输出。
 * @returns 计划对象；`structured=false` 表示走纯文本老路径。
 */
/** 从（可能被截断的）文本里抠出 `line` 字段；截断也能救回真正要发的那句。 */
function extractLineField(raw: string): string | undefined {
  const match = /"line"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(raw);
  if (match === null) return undefined;
  const value = match[1] ?? "";
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/**
 * 这段文本是不是「计划 JSON 的碎片」。
 *
 * 真实事故（2026-11-17 14:24，杨子杰会话）：模型输出被 max_tokens 截断，
 * JSON 不完整 → 走"纯文本回退" → **把 `{"known":[...` 原样发给了对方**。
 * 所以回退时必须识别这种碎片并**拒绝发送**（宁可不发，也不能把内部结构发出去）。
 *
 * @param text - 待判定文本。
 * @returns 是否像计划 JSON 或其残片。
 */
export function looksLikePlanFragment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  return /"known"\s*:/.test(trimmed)
    || /"line"\s*:/.test(trimmed)
    || /"ask_budget"\s*:/.test(trimmed)
    || /"slot"\s*:/.test(trimmed);
}

/**
 * 解析模型输出为回复计划。
 *
 * 容错顺序：
 *   1. 正常 JSON；
 *   2. JSON 被截断但 `line` 字段完整 → 救回那句；
 *   3. 仍是计划碎片（无可用 line）→ 返回空 line（**这一轮不发**，绝不把 JSON 发出去）；
 *   4. 完全不像计划（纯文本）→ 整段当正文。
 *
 * @param raw - 模型原始输出。
 * @returns 计划对象；`structured=false` 表示走纯文本老路径。
 */
export function parseReplyPlan(raw: string): ReplyPlan {
  const text = raw.trim();
  if (text === "") return { line: "", known: [], structured: false };
  const candidate = firstJsonObject(text);
  if (candidate !== undefined) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const line = readText(parsed, "line");
      if (line !== undefined) {
        const slot = readText(parsed, "slot");
        const move = readText(parsed, "move");
        const askBudget = readBudget(parsed, "ask_budget");
        return {
          line,
          known: readFacts(parsed, "known"),
          structured: true,
          ...(slot === undefined ? {} : { slot }),
          ...(move === undefined ? {} : { move }),
          ...(askBudget === undefined ? {} : { askBudget }),
        };
      }
    } catch {
      /* 落到截断救援 */
    }
  }
  const rescued = extractLineField(text);
  if (rescued !== undefined && rescued.trim() !== "") {
    return { line: rescued.trim(), known: [], structured: true };
  }
  if (looksLikePlanFragment(text)) {
    // 内部计划结构不能发给别人：宁可这一轮不发。
    return { line: "", known: [], structured: false };
  }
  return { line: text, known: [], structured: false };
}

/** 疑问词：中文聊天里"直接问"的标志（含无标点的「你昨晚去哪了」「你人呢」）。 */
const QUESTION_FORM = /[?？]|什么|哪|谁|几点|多久|多少|为什么|怎么|咋|是不是|有没有|要不要|行不行|对不对|(?:吗|呢)[。!！~～…]*$/;

/**
 * 判断一句话是不是"在提问"。
 *
 * 只用于执行提问预算，不追求语言学正确：问号、疑问词都算；"吗"结尾也算。
 *
 * @param text - 待判定正文。
 * @returns 是否疑问句。
 */
export function hasQuestionForm(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (/[?？]/.test(trimmed)) return true;
  if (/吗[。!！~～…]*$/.test(trimmed)) return true;
  return QUESTION_FORM.test(trimmed);
}

/**
 * 本轮是否允许直接提问。
 *
 * 规则：模型说 `ask_budget=1`，且上一句不是问句（不连续追问），且这个信息点从没问过；
 * 纯文本老路径（`structured=false`）没有计划可依，只保留"不连续追问"这一条。
 *
 * @param input - 判定依据。
 * @returns 是否允许提问。
 */
export function canAskNow(input: {
  structured: boolean;
  askBudget?: number;
  lastOwnWasQuestion: boolean;
  slotAskedBefore: boolean;
}): boolean {
  if (input.lastOwnWasQuestion) return false;
  if (!input.structured) return true;
  if (input.askBudget !== 1) return false;
  if (input.slotAskedBefore) return false;
  return true;
}
