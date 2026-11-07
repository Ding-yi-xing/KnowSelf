/**
 * `IntentRuleEngine`（DESIGN-12 §5.2 L0 规则层，P1 必做，无 LLM）。
 * 判定管线：结构硬规则 → 词典加权计分 + 正则加分 → 上下文 tie-break（并列时）→
 * 置信度公式（§5.2 逐字）：
 *   score(top1)==0                       → 'other', confidence=0
 *   score(top1)-score(top2) >= DELTA     → top1, confidence=min(1, score/3)
 *   否则                                  → top1, confidence=0.5, ambiguous=true
 * 类间冲突按优先级裁决（§5.1）：finance > after_sales > business > work > family >
 * notice > consult > social > other——实现为「同分时取优先级高者」。
 */
import { INTENT_DELTA, INTENT_PRODUCED_BY } from "./constants";
import { INTENT_LEXICON, type IntentLexicon } from "./intent-lexicon";
import type { IntentKind, IntentUpsert, MiningMessageRow } from "@knowself/person-store";

const PRIORITY: readonly IntentKind[] = [
  "finance",
  "after_sales",
  "business",
  "work",
  "family",
  "notice",
  "consult",
  "social",
  "other",
];

const REGEX_RULES: readonly { name: string; intent: IntentKind; pattern: RegExp; weight: number }[] = [
  { name: "order_no", intent: "after_sales", pattern: /\b\d{10,}\b/, weight: 1 },
  { name: "amount", intent: "finance", pattern: /[¥￥]\s?\d+(\.\d+)?/, weight: 1.5 },
  { name: "phone", intent: "consult", pattern: /(?:1[3-9]\d{9})|\d{3,4}-\d{7,8}/, weight: 1 },
];

function initialScores(): Record<IntentKind, number> {
  return {
    consult: 0,
    after_sales: 0,
    business: 0,
    work: 0,
    social: 0,
    family: 0,
    finance: 0,
    notice: 0,
    other: 0,
  };
}

export interface ClassifiedIntent {
  intent: IntentKind;
  confidence: number;
  ambiguous: boolean;
  matchedRules: string[];
  /** 并列候选（分差 < DELTA 时与 top1 同分/近分的类），供上下文 tie-break。 */
  rivals: readonly IntentKind[];
}

/** 单条消息 L0 判定（不含上下文 tie-break）；`null` = 不参与打标（如撤回消息）。 */
export function classifyMessage(
  message: MiningMessageRow,
  lexicon: IntentLexicon = INTENT_LEXICON,
): ClassifiedIntent | null {
  // 结构硬规则（§5.2）：content_type='system' 直接 notice；撤回消息不打标
  if (message.content_type === "system") {
    return { intent: "notice", confidence: 1, ambiguous: false, matchedRules: ["content_type_system"], rivals: [] };
  }
  try {
    const meta = JSON.parse(message.meta || "{}") as { recalled?: boolean };
    if (meta.recalled === true) return null; // 不参与打标
  } catch {
    // meta 非法 JSON → 忽略结构特征，继续规则打分（§5.2 不因元数据异常而失败）
  }

  const text = message.content ?? "";
  const scores = initialScores();
  const matched: string[] = [];

  for (const kind of PRIORITY) {
    if (kind === "other") continue;
    const entry = lexicon[kind];
    let negated = false;
    for (const negation of entry.negations) {
      if (text.includes(negation)) {
        negated = true;
        break;
      }
    }
    if (negated) continue; // 该类清零（保持 0）
    for (const word of entry.words) {
      if (text.includes(word.w)) {
        scores[kind] += word.weight;
        matched.push(`lexicon:${kind}:${word.w}`);
      }
    }
  }
  for (const rule of REGEX_RULES) {
    if (rule.pattern.test(text)) {
      scores[rule.intent] += rule.weight;
      matched.push(`regex:${rule.name}`);
    }
  }

  const ranked = PRIORITY.map((kind) => ({ kind, score: scores[kind] }))
    .sort((a, b) => b.score - a.score || PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  const top1 = ranked[0];
  const top2 = ranked[1];
  if (top1 === undefined || top2 === undefined) return null;
  if (top1.score === 0) {
    return { intent: "other", confidence: 0, ambiguous: false, matchedRules: [], rivals: [] };
  }
  if (top1.score - top2.score >= INTENT_DELTA) {
    return {
      intent: top1.kind,
      confidence: Math.min(1, top1.score / 3),
      ambiguous: false,
      matchedRules: matched,
      rivals: [],
    };
  }
  const rivals = ranked.filter((r) => top1.score - r.score < INTENT_DELTA && r.kind !== top1.kind)
    .map((r) => r.kind);
  return { intent: top1.kind, confidence: 0.5, ambiguous: true, matchedRules: matched, rivals };
}

/** 批量打标：上下文 tie-break（§5.2 弱信号，仅并列时），产出 `IntentUpsert` 行。 */
export function classifyMessages(
  messages: readonly MiningMessageRow[],
  lexicon: IntentLexicon = INTENT_LEXICON,
  now: string = new Date().toISOString(),
): IntentUpsert[] {
  const decided = new Map<string, IntentKind>();
  const rows: IntentUpsert[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message === undefined) continue;
    const result = classifyMessage(message, lexicon);
    if (result === null) continue;
    if (result.ambiguous && result.intent !== "other") {
      // 上下文 tie-break：前后各 2 条已判定消息命中并列集合（top1 + rivals）之一 → 命中者胜出
      const neighbors: IntentKind[] = [];
      for (let j = Math.max(0, i - 2); j < Math.min(messages.length, i + 3); j += 1) {
        if (j === i) continue;
        const decidedKind = decided.get(messages[j]?.message_id ?? "");
        if (decidedKind !== undefined) neighbors.push(decidedKind);
      }
      const winner = [result.intent, ...result.rivals].find((kind) => neighbors.includes(kind));
      if (winner !== undefined) {
        rows.push({
          message_id: message.message_id,
          intent: winner,
          confidence: Math.max(result.confidence, 0.6),
          ambiguous: false,
          matched_rules: JSON.stringify([...result.matchedRules, "context_tiebreak"]),
          produced_by: INTENT_PRODUCED_BY,
          computed_at: now,
        });
        decided.set(message.message_id, winner);
        continue;
      }
    }
    rows.push({
      message_id: message.message_id,
      intent: result.intent,
      confidence: result.confidence,
      ambiguous: result.ambiguous,
      matched_rules: JSON.stringify(result.matchedRules),
      produced_by: INTENT_PRODUCED_BY,
      computed_at: now,
    });
    decided.set(message.message_id, result.intent);
  }
  return rows;
}

export const IntentRuleEngine = { classifyMessage, classifyMessages };
