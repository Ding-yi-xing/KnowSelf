/**
 * W-2 图谱边类型过滤测试（纯函数）。
 *
 * 关键语义（写死在这里，避免以后被"顺手改"）：
 *   **空选中 = 全部**，不是「一条都不要」。面板初始态是全不勾，
 *   解释成「全不要」会让用户一进面板只看到孤零零的点。
 */
import { describe, it, expect } from "vitest";
import type { GraphEdgeKind } from "@knowself/contracts";
import {
  collectEdgeKinds,
  encodeEdgeKinds,
  filterEdges,
  parseEdgeKinds,
} from "../src/client/graph-filter.js";

/** 造一条最小边。 */
function edge(id: string, kind: GraphEdgeKind) {
  return { id, kind, source: "a", target: "b", strength: 0.5, directed: false };
}

const EDGES = [
  edge("e1", "co_presence"),
  edge("e2", "mention"),
  edge("e3", "co_presence"),
  edge("e4", "my_group"),
];

describe("filterEdges", () => {
  it("空选中 = 全部（不过滤）", () => {
    expect(filterEdges(EDGES, []).map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("单类型 → 只留该类型的边，顺序保持输入顺序", () => {
    expect(filterEdges(EDGES, ["co_presence"]).map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("多类型 → 并集", () => {
    expect(filterEdges(EDGES, ["mention", "my_group"]).map((e) => e.id)).toEqual(["e2", "e4"]);
  });

  it("选中的类型在数据里不存在 → 返回空数组（而不是回退成全部）", () => {
    expect(filterEdges(EDGES, ["topic"])).toEqual([]);
  });

  it("不修改输入数组（返回新数组）", () => {
    const input = [...EDGES];
    const out = filterEdges(input, ["co_presence"]);
    expect(input).toHaveLength(4);
    expect(out).not.toBe(input);
  });
});

describe("collectEdgeKinds", () => {
  it("按出现顺序去重（不硬编码枚举全集）", () => {
    expect(collectEdgeKinds(EDGES)).toEqual(["co_presence", "mention", "my_group"]);
  });

  it("空输入 → 空数组", () => {
    expect(collectEdgeKinds([])).toEqual([]);
  });
});

describe("URL 参数编解码", () => {
  it("parseEdgeKinds 解析逗号分隔、去空白、去重", () => {
    expect(parseEdgeKinds("co_presence,mention")).toEqual(["co_presence", "mention"]);
    expect(parseEdgeKinds(" co_presence , co_presence ")).toEqual(["co_presence"]);
  });

  it("空串 / 只有逗号 / null → 空数组（= 不过滤）", () => {
    expect(parseEdgeKinds("")).toEqual([]);
    expect(parseEdgeKinds(",,")).toEqual([]);
    expect(parseEdgeKinds(null)).toEqual([]);
    expect(parseEdgeKinds(undefined)).toEqual([]);
  });

  it("encodeEdgeKinds 与 parseEdgeKinds 互逆", () => {
    const kinds: GraphEdgeKind[] = ["mention", "my_group"];
    expect(parseEdgeKinds(encodeEdgeKinds(kinds))).toEqual(kinds);
    expect(encodeEdgeKinds([])).toBe("");
  });
});
