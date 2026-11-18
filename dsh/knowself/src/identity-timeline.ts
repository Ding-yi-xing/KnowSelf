/**
 * 从聊天里挖「我亲口说过的身份/状态变化」。
 *
 * 为什么需要：静态画像卡片只有一句「本科在读」，盖不住「上周还在投简历、这周入职了」这种时效变化。
 * 真实事故：代理先回「我早不读了」，22 秒后又回「在家待着呗 翻翻招聘信息 投简历」——
 * 两句都是编的，因为系统里既没有「在读」，也没有「最近在找工作」这样的当前状态。
 *
 * 挖掘口径从严：
 *   - 只收**我亲口说过的**、关于我自己的状态；
 *   - 每条必须带原文引用，没有引用的直接丢弃（宁可少挖，不要编）；
 *   - 对方说的事、我转述的信息（招聘公告、别人入职）一律不收。
 *
 * @module @knowself/dsh-plugin/identity-timeline
 */
import type { PersonaMessage } from "./wechat-persona.js";

export type IdentityStateCategory = "enrollment" | "work" | "other";

const CATEGORIES: readonly IdentityStateCategory[] = ["enrollment", "work", "other"];

export interface IdentityStateCandidate {
  category: IdentityStateCategory;
  /** ≤20 字，第一人称陈述，如「还在念书」「上周入职了」。 */
  text: string;
  /** 我的原话片段，必须来自聊天记录。 */
  source_quote: string;
}

const SCHEMA = `[
  {"category":"enrollment|work|other","text":"我的状态（≤20字）","source_quote":"我的原话片段"}
]`;

/** 构造挖掘 prompt。只给「我」说的话，减少误抓对方叙述。 */
export function buildIdentityExtractionPrompt(messages: readonly PersonaMessage[]): { system: string; user: string } {
  const mine = messages
    .filter((message) => message.role === "me")
    .map((message) => `- ${message.text.replace(/\s+/g, " ").slice(0, 80)}`)
    .join("\n");

  const system = [
    "你要从「我」说过的话里，找出关于**我自己身份/状态变化**的陈述。",
    "只收这四类：",
    "- enrollment：在读、毕业、休学、退学；",
    "- work：入职、实习、上班、辞职、被裁、待业、正在找工作/投简历；",
    "- other：其它明确的状态变化（如搬到某城市常住）。",
    "",
    "严格规则（违反任何一条就不要输出这条）：",
    "1. 必须是「我」亲口说的、主语是我自己；对方说「我毕业了」说的是对方，不要收。",
    "2. 必须能原样摘出一句我的原话放进 source_quote；摘不出来就不要这条。",
    "3. 招聘公告、别人入职、假设句（「如果我去上班」「以后想考公」）、玩笑话，都不收。",
    "4. text 用第一人称短句（≤20 字），不要写成「用户……」。",
    "5. 一条都没有就输出 []。",
    "",
    "输出严格 JSON 数组，不要解释、不要代码块：",
    SCHEMA,
  ].join("\n");

  const user = [
    "我说过的话（越靠后越新）：",
    mine === "" ? "（无）" : mine,
  ].join("\n");

  return { system, user };
}

function readCategory(value: unknown): IdentityStateCategory {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value)
    ? (value as IdentityStateCategory)
    : "other";
}

/**
 * 解析挖掘结果。
 *
 * 没有 `source_quote` 的条目一律丢弃——这是防编造的最后一道闸。
 */
export function parseIdentityStates(raw: string): IdentityStateCandidate[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: IdentityStateCandidate[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim().slice(0, 20) : "";
    const quote = typeof record.source_quote === "string" ? record.source_quote.trim().slice(0, 120) : "";
    if (text === "" || quote === "") continue;
    const candidate: IdentityStateCandidate = { category: readCategory(record.category), text, source_quote: quote };
    // 同一句重复出现只留一条。
    if (out.some((existing) => existing.category === candidate.category && existing.text === candidate.text)) continue;
    out.push(candidate);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 把当前有效身份状态压成一句，供 prompt 注入。
 *
 * 例：「在读（原话「还在念书」）；正在找工作（原话「翻翻招聘信息 投简历」）」
 */
export function formatIdentityStatesForPrompt(
  states: ReadonlyArray<{ category: string; text: string; source_quote?: string }>,
): string {
  if (states.length === 0) return "";
  const ordered = [...states].sort((left, right) => {
    const priority = (category: string): number => (category === "enrollment" ? 0 : category === "work" ? 1 : 2);
    return priority(left.category) - priority(right.category);
  });
  return ordered
    .map((state) => (state.source_quote === undefined || state.source_quote === "" ? state.text : `${state.text}（原话「${state.source_quote}」）`))
    .join("；");
}
