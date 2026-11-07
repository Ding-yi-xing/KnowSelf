import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PII 守卫（DESIGN-11 §9.1 铁律 2/3）：fixture 必须全部合成。
 * 失败即阻塞——本工单的硬约束「不要把真实聊天内容写进测试 fixture」由本测试兜底。
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_FILES = [
  "fixtures.ts",
  "descriptor.test.ts",
  "normalize.test.ts",
  "reader.test.ts",
  "ingest.test.ts",
];
const PII_PATTERNS: readonly { name: string; regex: RegExp }[] = [
  { name: "手机号", regex: /1[3-9]\d{9}/ },
  { name: "身份证", regex: /\d{17}[\dXx]/ },
  { name: "邮箱", regex: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/ },
];
/** DESIGN-11 §9.1 铁律 3 的合成 wxid 形态。 */
const SYNTHETIC_WXIDS = new Set(["wxid_aaaaaaaaaaaa22", "wxid_bbbbbbbbbbbb22"]);

describe("fixture PII 守卫", () => {
  it("测试目录不含真实 PII，且 wxid 只用合成形态", () => {
    for (const file of FIXTURE_FILES) {
      const text = readFileSync(join(HERE, file), "utf8");
      for (const { name, regex } of PII_PATTERNS) {
        expect(text, `${file} 命中 ${name}`).not.toMatch(regex);
      }
      for (const wxid of text.match(/wxid_[a-z0-9]+/g) ?? []) {
        expect(SYNTHETIC_WXIDS.has(wxid), `${file} 出现非合成 wxid：${wxid}`).toBe(true);
      }
    }
  });
});
