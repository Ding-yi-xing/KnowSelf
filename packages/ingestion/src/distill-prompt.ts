/**
 * distill-prompt.ts — 蒸馏 prompt 构造 + structured output schema
 *
 * DistillOutputSchema 定义 LLM 返回的 proposal 数组形状。
 * buildDistillPrompt 拼接 system + user messages 传入 provider-adapter。
 */

import { z } from "zod";
import type { SourceStored, ProposalTarget, ProviderMessage } from "@knowself/contracts";

// ──────────────────────────────────────────────────────────────
//  Structured output schema（蒸馏小模型返回的 JSON 形状）
// ──────────────────────────────────────────────────────────────

/** 单条 proposal write 目标。 */
const ProposalTargetCoreSchema = z.object({
  targetKind: z.literal("core"),
});

const ProposalTargetCardSchema = z.object({
  targetKind: z.literal("card_section"),
  cardKey: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .min(1)
    .max(48),
  section: z.string().min(1).max(80),
});

const ProposalTargetJournalSchema = z.object({
  targetKind: z.literal("journal"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** 单条 write 建议。 */
const DistillWriteSchema = z.object({
  target: z.discriminatedUnion("targetKind", [
    ProposalTargetCoreSchema,
    ProposalTargetCardSchema,
    ProposalTargetJournalSchema,
  ]),
  body: z.string().min(1).max(8000),
  reasoning: z.string().max(2000),
  excerpts: z
    .array(
      z.object({
        start: z.number().int().min(0).max(2_000_000),
        end: z.number().int().min(0).max(2_000_000),
      }),
    )
    .max(8),
});

/** 蒸馏 LLM 返回的顶层对象。接受 { writes: [...] } 或直接 [...] */
export const DistillOutputSchema = z.union([
  z.object({
    writes: z.array(DistillWriteSchema).max(20),
  }),
  z.array(DistillWriteSchema).max(20),
]);

export type DistillOutput = z.infer<typeof DistillOutputSchema>;
type DistillWriteItem = z.infer<typeof DistillWriteSchema>;

// ──────────────────────────────────────────────────────────────
//  Prompt 构造
// ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个"个人画像资料蒸馏器"。你的任务是从用户提供的资料中提取对个人画像有价值的信息，并生成写入档案的建议。

## 档案结构
- core: L1 整体描述（个人画像全文）
- card_section: L2 卡片某 section（某一方面：工作/健康/人际关系...）
- journal: L3 日记一条记录

## 规则
1. body 是建议写入的正文，精炼、准确、基于原文
2. reasoning 是建议理由（简短）
3. excerpts 是原文引用位置（空数组即可，不必精确到行号）
4. 只输出与个人画像相关的信息，跳过纯技术/通用内容
5. 每条建议不超过 8000 字符
6. 最多输出 maxWrites 条建议

## 输出格式
你必须输出严格合法的 JSON，格式如下（不得添加任何额外文字或 markdown 围栏）：
{
  "writes": [
    {
      "target": { "targetKind": "core" },
      "body": "正文",
      "reasoning": "理由",
      "excerpts": []
    },
    {
      "target": { "targetKind": "card_section", "cardKey": "卡片key", "section": "section名" },
      "body": "正文",
      "reasoning": "理由",
      "excerpts": [{ "start": 0, "end": 10 }]
    },
    {
      "target": { "targetKind": "journal", "date": "2024-01-01" },
      "body": "正文",
      "reasoning": "理由",
      "excerpts": []
    }
  ]
}`;

/**
 * 构造蒸馏 LLM 调用的 messages 数组。
 *
 * @param source       待蒸馏的 Source
 * @param candidates   当前 profile 中已有的卡片摘要 / 日记日期（供 LLM 参考）
 * @param hints        用户指定的关注角度（focus_hints）
 * @param maxN         单次最多产出几条 proposals
 */
export function buildDistillPrompt(
  source: SourceStored,
  candidates: {
    cards: { key: string; title: string; summary: string }[];
    journalDates: string[];
  },
  hints: string[],
  maxN: number,
): ProviderMessage[] {
  const userContent = buildUserContent(source, candidates, hints, maxN);

  return [
    {
      role: "system",
      content: [{ kind: "text", text: SYSTEM_PROMPT }],
    },
    {
      role: "user",
      content: [{ kind: "text", text: userContent }],
    },
  ];
}

function buildUserContent(
  source: SourceStored,
  candidates: { cards: { key: string; title: string; summary: string }[]; journalDates: string[] },
  hints: string[],
  maxN: number,
): string {
  const lines: string[] = [];

  lines.push("## 资料信息");
  lines.push(`- 来源类型: ${source.kind}`);
  lines.push(`- 文件名: ${source.original_name}`);
  lines.push(`- MIME: ${source.mime_type}`);
  if (source.user_note.trim()) {
    lines.push(`- 用户备注: ${source.user_note.trim()}`);
  }
  lines.push("");

  lines.push("## 资料正文");
  // 如果超长，只取前 200000 字符送入 LLM
  const text = source.extracted_text.slice(0, 200_000);
  lines.push(text);
  lines.push("");

  if (candidates.cards.length > 0) {
    lines.push("## 当前已有卡片（供参考，不必重复已存在的内容）");
    for (const c of candidates.cards) {
      lines.push(`- [${c.key}] ${c.title}: ${c.summary}`);
    }
    lines.push("");
  }

  if (candidates.journalDates.length > 0) {
    lines.push("## 当前日记日期（供参考，建议关联到已有日期）");
    lines.push(candidates.journalDates.join(", "));
    lines.push("");
  }

  if (hints.length > 0) {
    lines.push("## 用户指定的关注角度");
    for (const h of hints) {
      lines.push(`- ${h}`);
    }
    lines.push("");
  }

  lines.push(`请生成最多 ${maxN} 条写入建议。`);

  return lines.join("\n");
}

/** 将 DistillOutput.writes 一条转成 ProposalTarget。 */
export function writeToProposalTarget(w: DistillWriteItem): ProposalTarget {
  if (w.target.targetKind === "core") {
    return { kind: "core" };
  }
  if (w.target.targetKind === "card_section") {
    return {
      kind: "card_section",
      card_key: w.target.cardKey,
      section: w.target.section,
    };
  }
  return {
    kind: "journal",
    date: w.target.date,
  };
}
