/**
 * W-9 真机实测的**空 label 兜底**测试。
 *
 * 坑的形状（真机取证）：`runMiningPipeline` 抛
 * `[{ code:"too_small", path:["nodes",4,"label"] }]` —— 第 5 个节点 label 为空。
 * persons 只占索引 0~3，所以 `nodes[4]` 是**群节点**：`groupLabels.get(id) ?? conversationId`
 * 里的 `??` **只挡 null/undefined，挡不住空串**，空会话标题直接放行 → schema `min(1)` 拒绝。
 *
 * 两条兜底都要测：人物（display_name 空）与群（标题空）。只测前者会漏掉真正的坑。
 */
import { describe, expect, it } from "vitest";
import { labelOf, nonEmptyLabel } from "../src/pipeline.js";

describe("labelOf（人物节点兜底）", () => {
  it("display_name 正常 → 原样返回（去掉首尾空白）", () => {
    expect(labelOf({ person_id: "p-abc123", display_name: " 李四 " })).toBe("李四");
  });

  it("display_name 为空串 / 纯空白 → 稳定兜底名（用 id 前 6 位，不用序号）", () => {
    expect(labelOf({ person_id: "p-abc123", display_name: "" })).toBe("未命名(p-abc1)");
    expect(labelOf({ person_id: "p-abc123", display_name: "   " })).toBe("未命名(p-abc1)");
    // 同一个 person 多次调用结果稳定（刷新不会改名）
    const a = labelOf({ person_id: "p-abc123", display_name: "" });
    const b = labelOf({ person_id: "p-abc123", display_name: "" });
    expect(a).toBe(b);
  });
});

describe("nonEmptyLabel（群节点兜底：真正踩到的那个）", () => {
  it("空串 / 纯空白 / undefined → null，让 `?? fallback` 生效", () => {
    expect(nonEmptyLabel("")).toBeNull();
    expect(nonEmptyLabel("   ")).toBeNull();
    expect(nonEmptyLabel(undefined)).toBeNull();
  });

  it("有内容的标题 → 去空白后返回", () => {
    expect(nonEmptyLabel(" 三人小组 ")).toBe("三人小组");
  });

  it("空标题 + `?? conversationId` 的组合能得到非空 label（复现修复点）", () => {
    const conversationId = "12345678901@chatroom";
    const label = nonEmptyLabel("") ?? conversationId;
    expect(label).toBe(conversationId);
    expect(label.length).toBeGreaterThanOrEqual(1); // schema min(1) 要求
  });
});
