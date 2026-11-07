/**
 * chunker.ts — 文档切片（父子 chunk）
 *
 * 纯函数：输入文档文本，输出 ChunkRecord[]。
 * 父级按 H2 标题切，子级按空行 / 句号切 + 重叠窗口。
 */

import type { ChunkRecord, DocSourceType } from "@knowself/contracts";

// ─── 入参 ───────────────────────────────────────────────────────────

interface ChunkInput {
  doc: {
    id: string;
    source: DocSourceType;
    path: string;
    updatedAt: string;
  };
  body: string;
  parentMaxTokens: number;
  childTargetTokens: number;
  childOverlapTokens: number;
  countTokens: (s: string) => number;
}

// ─── 工具函数 ────────────────────────────────────────────────────────

/** 按 H2 标题拆分父级 sections；无 H2 时整文作为一个 parent。 */
function splitByH2(body: string): string[] {
  const parts = body.split(/^## /m);
  if (parts.length <= 1) return [body];
  // parts[0] 是第一个 H2 之前的内容（可能为空）
  const sections: string[] = [];
  const lead = parts[0]!.trim();
  if (lead) sections.push(lead);
  for (let i = 1; i < parts.length; i++) {
    sections.push("## " + parts[i]!);
  }
  return sections;
}

/** 将文本截断到 maxTokens 以内。 */
function truncateToTokens(
  text: string,
  maxTokens: number,
  countTokens: (s: string) => number,
): string {
  if (countTokens(text) <= maxTokens) return text;
  // 二分逼近截断点
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

/** 按空行拆分段落，超长段落再按句号切。 */
function splitParagraphs(text: string): string[] {
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const result: string[] = [];
  for (const para of paras) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    // 对超长段落按句子拆分
    const sentences = splitSentences(trimmed);
    for (const s of sentences) {
      result.push(s);
    }
  }
  return result;
}

/** 按中文句号 / 英文句号拆分句子。 */
function splitSentences(text: string): string[] {
  // 在句号、问号、感叹号后加分割点，保留标点在前一句末尾
  const raw = text.split(/(?<=[。！？.!?])\s*/);
  return raw.filter((s) => s.trim().length > 0).map((s) => s.trim());
}

// ─── 主函数 ──────────────────────────────────────────────────────────

export function chunkDocument(input: ChunkInput): ChunkRecord[] {
  const { doc, body, parentMaxTokens, childTargetTokens, childOverlapTokens, countTokens } = input;
  const now = new Date().toISOString();
  const chunks: ChunkRecord[] = [];

  const parentSections = splitByH2(body);
  let chunkIdCounter = 0;

  for (let pi = 0; pi < parentSections.length; pi++) {
    const rawParent = parentSections[pi]!;
    const parentText = truncateToTokens(rawParent, parentMaxTokens, countTokens);
    const childTexts = buildChildChunks(
      parentText,
      childTargetTokens,
      childOverlapTokens,
      countTokens,
    );

    for (let ci = 0; ci < childTexts.length; ci++) {
      const childText = childTexts[ci]!;
      if (!childText.trim()) continue;

      chunks.push({
        id: String(chunkIdCounter++),
        doc_id: doc.id,
        doc_source: doc.source,
        doc_path: doc.path,
        parent_index: pi,
        child_index: ci,
        parent_text: parentText,
        child_text: childText,
        tokens: countTokens(childText),
        tags: [],
        updated_at: doc.updatedAt,
        indexed_at: now,
      });
    }
  }

  return chunks;
}

// ─── 子级 chunk 构建 ─────────────────────────────────────────────────

function buildChildChunks(
  parentText: string,
  targetTokens: number,
  overlapTokens: number,
  countTokens: (s: string) => number,
): string[] {
  const parts = splitParagraphs(parentText);
  if (parts.length === 0) return [];

  const children: string[] = [];
  let current = "";
  let currentTokens = 0;

  for (const part of parts) {
    const partTokens = countTokens(part);

    // 单段已超目标：直接作为独立 child
    if (partTokens > targetTokens && current.length === 0) {
      children.push(part);
      continue;
    }

    // 加入后不超：追加到当前 child
    if (currentTokens + partTokens <= targetTokens) {
      current = current ? current + "\n\n" + part : part;
      currentTokens = countTokens(current);
      continue;
    }

    // 当前 child 已满：提交，开启新 child（带重叠）
    children.push(current);

    if (overlapTokens > 0 && current.length > 0) {
      const overlapText = extractOverlap(current, overlapTokens, countTokens);
      current = overlapText ? overlapText + "\n\n" + part : part;
    } else {
      current = part;
    }
    currentTokens = countTokens(current);
  }

  // 提交最后一个 child
  if (current.trim()) {
    children.push(current);
  }

  return children;
}

/** 从文本末尾抽取约 overlapTokens 的内容。 */
function extractOverlap(
  text: string,
  overlapTokens: number,
  countTokens: (s: string) => number,
): string {
  // 从句号边界截取末尾
  const sentences = splitSentences(text);
  let result = "";
  for (let i = sentences.length - 1; i >= 0; i--) {
    const candidate = sentences[i]! + (result ? " " : "") + result;
    if (countTokens(candidate) > overlapTokens) break;
    result = sentences[i]! + (result ? " " + result : "");
  }
  return result;
}
