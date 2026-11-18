/**
 * 回复任务的事实层。
 *
 * 背景事故：我在 10-14 说过「我建阳税务局招三个人」（在说一条**招聘信息**），
 * 画像却总结成「用户报考建阳税务局」，回复时又说成「报过啊」和「又没考上 白报」。
 *
 * 根因不是模型爱编，而是事实存储是 `string[]`：既没有来源、也没有「这是我做过的事」
 * 还是「这是我看到的消息」的区别，模型只能自己猜。
 *
 * 这里把事实升级成带 `kind` / 原文引用 / 有效期的结构：
 *   - `did`   = 我亲口说过自己做过（我报了 / 我考了 / 我去了）
 *   - `saw`   = 我看到的**信息**（某单位招三个人），**不能**说成我的经历
 *   - `known` = 一般事实
 *
 * 冲突不靠覆盖，靠给旧事实打 `invalid_at`（参考 Zep 的双时间轴做法）。
 *
 * @module @knowself/dsh-plugin/reply-facts
 */

export type ReplyFactKind = "did" | "saw" | "known";

export interface ReplyFact {
  /** 事实正文，≤40 字。 */
  text: string;
  /** 原文引用：这句话是从聊天记录里哪句来的。 */
  source_quote?: string;
  /** 来源会话 id：只允许共享范围内的会话。 */
  source_conversation_id?: string;
  /** 从什么时候开始成立（ISO）。 */
  valid_from?: string;
  /** 被新事实取代的时间（ISO）；有值的不会进 prompt。 */
  invalid_at?: string;
  kind: ReplyFactKind;
}

/** 反极性对：只有这些明确的「做了 / 没做」才互相失效，避免模糊语义误杀。 */
const POLARITY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["装了", "没装"],
  ["报了", "没报"],
  ["考了", "没考"],
  ["去了", "没去"],
  ["看过", "没看过"],
  ["发了", "没发"],
];

const MAX_FACT_LENGTH = 40;

function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "");
}

function readKind(value: unknown): ReplyFactKind {
  return value === "did" || value === "saw" || value === "known" ? value : "known";
}

/**
 * 把持久化的 facts 读成结构体。
 *
 * 兼容旧数据：`["某事实"]` 这种字符串数组会被当成 `kind: "known"` 的 legacy 事实，
 * 一条都不丢。
 */
export function parseFacts(raw: unknown): ReplyFact[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const facts: ReplyFact[] = [];
  for (const item of source) {
    if (typeof item === "string") {
      const text = item.trim().slice(0, MAX_FACT_LENGTH);
      if (text !== "") facts.push({ text, kind: "known" });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim().slice(0, MAX_FACT_LENGTH) : "";
    if (text === "") continue;
    facts.push({
      text,
      kind: readKind(record.kind),
      ...(typeof record.source_quote === "string" && record.source_quote !== "" ? { source_quote: record.source_quote } : {}),
      ...(typeof record.source_conversation_id === "string" && record.source_conversation_id !== ""
        ? { source_conversation_id: record.source_conversation_id }
        : {}),
      ...(typeof record.valid_from === "string" && record.valid_from !== "" ? { valid_from: record.valid_from } : {}),
      ...(typeof record.invalid_at === "string" && record.invalid_at !== "" ? { invalid_at: record.invalid_at } : {}),
    });
  }
  return facts;
}

/** 序列化给 `facts_json` 用。 */
export function serializeFacts(facts: readonly ReplyFact[]): string {
  return JSON.stringify(facts);
}

/**
 * 合并新事实：去重 + 反极性失效旧事实。
 *
 * 不做模糊语义合并——只在「装了/没装」这类明确对立上失效旧的，
 * 其余情况一律并存（靠 `activeFacts` 的排序让新的先出现）。
 */
export function reconcileFacts(
  existing: readonly ReplyFact[],
  incoming: readonly ReplyFact[],
  now: string,
): ReplyFact[] {
  const result: ReplyFact[] = existing.map((fact) => ({ ...fact }));
  for (const raw of incoming) {
    const text = raw.text.trim().slice(0, MAX_FACT_LENGTH);
    if (text === "") continue;
    const candidate: ReplyFact = { ...raw, text, kind: readKind(raw.kind) };
    const key = normalize(text);
    if (result.some((fact) => normalize(fact.text) === key && fact.invalid_at === undefined)) continue;

    // 反极性：新事实成立时，旧的相反说法失效（不删除，只打时间戳）。
    for (const [yes, no] of POLARITY_PAIRS) {
      const candidateHasYes = text.includes(yes);
      const candidateHasNo = text.includes(no);
      for (const fact of result) {
        if (fact.invalid_at !== undefined) continue;
        const factHasYes = fact.text.includes(yes);
        const factHasNo = fact.text.includes(no);
        const opposite = (candidateHasYes && factHasNo) || (candidateHasNo && factHasYes);
        if (opposite) fact.invalid_at = now;
      }
    }
    result.push(candidate);
  }
  return result;
}

/**
 * 取当前有效的事实，按时间从新到旧，最多 `limit` 条。
 *
 * 没有 `valid_from` 的（含 legacy 数据）排在后面，但仍然保留。
 */
export function activeFacts(all: readonly ReplyFact[], limit: number): ReplyFact[] {
  const active = all.filter((fact) => fact.invalid_at === undefined);
  const withTime = active.filter((fact) => fact.valid_from !== undefined);
  const withoutTime = active.filter((fact) => fact.valid_from === undefined);
  withTime.sort((left, right) => (left.valid_from ?? "").localeCompare(right.valid_from ?? ""));
  const ordered = [...withTime, ...withoutTime];
  return ordered.slice(Math.max(0, ordered.length - limit));
}

/**
 * 渲染成 prompt 片段。
 *
 * 每条都带「类别」和「原话」，让模型能区分"我做过"和"我看到的消息"。
 */
export function formatFactsForPrompt(facts: readonly ReplyFact[]): string {
  if (facts.length === 0) return "";
  return facts
    .map((fact) => {
      const kindLabel = fact.kind === "did" ? "我做过的事" : fact.kind === "saw" ? "我看到的消息（不是我做过的事）" : "已知";
      const quote = fact.source_quote === undefined ? "" : `｜原话：「${fact.source_quote}」`;
      return `- ${fact.text}（${kindLabel}）${quote}`;
    })
    .join("\n");
}
