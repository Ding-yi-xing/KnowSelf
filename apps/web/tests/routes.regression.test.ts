// @vitest-environment jsdom
/**
 * 路由回归 —— Chat 页迁移后 9 条 URL 契约逐条不变。
 * 不修改 smoke.test.tsx 中既有的路由用例，这里做更完整的独立回归。
 */
import { describe, expect, it } from "vitest";
import {
  NAV_ITEMS,
  labelForPage,
  pageFromLocation,
  pathForPage,
  type PageId,
} from "../src/routes";

const EXPECTED: readonly (readonly [PageId, string, string])[] = [
  ["chat", "/", "对话"],
  ["inbox", "/inbox", "待整理"],
  ["profile", "/profile", "画像"],
  ["cards", "/cards", "卡片"],
  ["journal", "/journal", "日志"],
  ["settings", "/settings", "设置"],
  ["system", "/system", "系统"],
  ["sources", "/sources", "资料"],
  ["templates", "/templates", "模板"],
];

describe("9 条 URL 契约回归", () => {
  it("导航项恰好 9 条，id 与 path 均唯一", () => {
    expect(NAV_ITEMS).toHaveLength(9);
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(9);
    expect(new Set(NAV_ITEMS.map((item) => item.path)).size).toBe(9);
  });

  it("每条 URL ↔ PageId 双向可逆，标签不变", () => {
    for (const [page, path, label] of EXPECTED) {
      expect(pageFromLocation(path)).toBe(page);
      expect(pathForPage(page)).toBe(path);
      expect(labelForPage(page)).toBe(label);
    }
  });

  it("历史别名 /chat 与未知路径回落保持", () => {
    expect(pageFromLocation("/chat")).toBe("chat");
    expect(pageFromLocation("/unknown")).toBe("chat");
    expect(pageFromLocation("/profile/nested")).toBe("chat");
  });
});
