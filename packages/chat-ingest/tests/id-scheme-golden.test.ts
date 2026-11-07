/**
 * id-scheme-golden.test.ts — 派生 ID 公式的单一真相（批 2 / 1B′）
 *
 * 背景：`lines.ts` 与 `readers/json.ts` 各有一份 sha1 派生公式，而 DESIGN-11 §4.1
 * 原文漏写了 `ordinal`（且把空格拼接写成 `+`）。三处各自成立、组合却不一致，
 * 改一处忘另一处会静默改变所有 message_id ⇒ 老会话全量重复。
 *
 * 本文件用三类断言钉死：
 *   ① 硬编码金色向量（公式变 → 红，不许「同步改期望值」）；
 *   ② 两处实现的 `.update()` 模板逐字一致（防两处拷贝漂移）；
 *   ③ 设计文档必须写出 ordinal（防文档再次漏写）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** `sha1("1700000000000 张三 你好 0")` —— 由 node crypto 预先算出，写死不许改。 */
const GOLDEN_SHA1 = "678f5e4134003bcf43bd5b33cfdfe6f92067f573";

const root = process.cwd();
const formulaIn = (relative: string): string => {
  const source = readFileSync(join(root, relative), "utf8");
  const match = /\.update\(\s*`([^`]+)`\s*\)/.exec(source);
  return match?.[1] ?? "";
};

describe("派生 ID 公式金色向量（DESIGN-11 §4.1）", () => {
  it("金色向量：ts_ms / sender_name / content / ordinal 以单空格拼接", () => {
    const digest = createHash("sha1")
      .update(`${1700000000000} 张三 你好 ${0}`)
      .digest("hex");
    expect(digest).toBe(GOLDEN_SHA1);
    expect(digest).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ordinal 参与派生：同一条消息重复出现时 digest 必须不同", () => {
    const base = `${1700000000000} 张三 你好`;
    const first = createHash("sha1").update(`${base} 0`).digest("hex");
    const second = createHash("sha1").update(`${base} 1`).digest("hex");
    expect(first).toBe(GOLDEN_SHA1);
    expect(second).not.toBe(first);
  });

  it("lines.ts 与 readers/json.ts 的公式模板逐字一致（防两处拷贝漂移）", () => {
    const lines = formulaIn("packages/chat-ingest/src/lines.ts");
    const json = formulaIn("packages/chat-ingest/src/readers/json.ts");
    expect(lines).not.toBe("");
    expect(json).not.toBe("");

    // 变量名不同（pending.ts_ms / ts_ms），但字段个数、顺序、分隔符必须一致。
    const shape = (template: string) => template.replace(/\$\{[^}]+\}/g, "{}");
    expect(shape(lines)).toBe("{} {} {} {}");
    expect(shape(json)).toBe(shape(lines));
    expect(lines).toContain("ordinal");
    expect(json).toContain("ordinal");
  });

  it("设计文档 §4.1 明确写出 ordinal 与空格拼接（防文档再次漏写）", () => {
    const design = readFileSync(
      join(root, "docs/process/004-DESIGN-11-聊天记录摄入管线.md"),
      "utf8",
    );
    const line = design.split("\n").find((row) => row.includes("平台消息 ID 缺失时"));
    expect(line).toBeDefined();
    expect(line).toContain("ordinal");
    expect(line).toContain("单个空格");
  });
});
