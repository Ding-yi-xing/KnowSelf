// @vitest-environment node
/**
 * W-36：**社区下钻无效** 回归测试（先用真实形态数据复现 bug）。
 *
 * 复现：默认 `mode="group"` → `modeSubset` 只含群节点；社区按人物共现算出来，成员绝大多数是
 * person。旧实现「在当前模式子集里找社区成员」→ 找到 0 → 静默退回聚合 → 画面一动不动。
 *
 * 断言：
 *   1) 群模式 + 聚合 → 顶层出现 `community:` 超节点（旧/新都应绿）
 *   2) 下钻某社区 → **可见子图应包含该社区的 person 成员**、且**不含 `community:` 节点**（旧实现红）
 *   3) 下钻后「社区自己还挂在图上」不允许（`community:` 前缀节点必须 0 个）
 *   4) 下钻到无成员社区 → 可见为空（**不许静默退回**聚合视图）
 */
import { describe, expect, it } from "vitest";
import type { GraphPanelEdge, GraphPanelNode } from "../src/client/graph-port.js";
import { filterByMode, resolveVisibleSubset } from "../src/client/graph-subgraph.js";

/** 30 person（15 个 c:aaa / 15 个 c:bbb）+ 4 group（各挂社区键）+ 连边/成员边。 */
function makeGraph(): { nodes: GraphPanelNode[]; edges: GraphPanelEdge[] } {
  const nodes: GraphPanelNode[] = [];
  const edges: GraphPanelEdge[] = [];
  const person = (i: number, key: string): GraphPanelNode => ({
    id: `p${i}`,
    label: `人${i}`,
    kind: "person",
    size: 0.5,
    degree: 1,
    isolated: false,
    community_key: key,
    relation_type: null,
  });
  // c:aaa 15 人（p0..p14），c:bbb 15 人（p15..p29）
  for (let i = 0; i < 30; i += 1) nodes.push(person(i, i < 15 ? "c:aaa" : "c:bbb"));
  // person 链（同一社区内共现），保证下钻后是一个连通分量、不被 keepLargestComponent 丢
  for (let i = 0; i < 14; i += 1) {
    edges.push({ id: `aa-${i}`, source: `p${i}`, target: `p${i + 1}`, kind: "co_presence", strength: 0.5, directed: false });
  }
  for (let i = 15; i < 29; i += 1) {
    edges.push({ id: `bb-${i}`, source: `p${i}`, target: `p${i + 1}`, kind: "co_presence", strength: 0.5, directed: false });
  }
  // 群：g0/g1 属 c:aaa，g2/g3 属 c:bbb
  const groups: GraphPanelNode[] = [
    { id: "g0", label: "群A", kind: "group", size: 0.4, degree: 1, isolated: false, community_key: "c:aaa", relation_type: null },
    { id: "g1", label: "群B", kind: "group", size: 0.4, degree: 1, isolated: false, community_key: "c:aaa", relation_type: null },
    { id: "g2", label: "群C", kind: "group", size: 0.4, degree: 1, isolated: false, community_key: "c:bbb", relation_type: null },
    { id: "g3", label: "群D", kind: "group", size: 0.4, degree: 1, isolated: false, community_key: "c:bbb", relation_type: null },
  ];
  nodes.push(...groups);
  // 成员边（membership：群→人），让群模式能派生群-群边、下钻后群与人也连通
  edges.push(
    { id: "m-g0-p0", source: "g0", target: "p0", kind: "membership", strength: 0.5, directed: false },
    { id: "m-g1-p0", source: "g1", target: "p0", kind: "membership", strength: 0.5, directed: false },
    { id: "m-g2-p0", source: "g2", target: "p0", kind: "membership", strength: 0.5, directed: false },
    { id: "m-g3-p15", source: "g3", target: "p15", kind: "membership", strength: 0.5, directed: false },
  );
  return { nodes, edges };
}

const { nodes, edges } = makeGraph();
/** 群模式的成员级子图（只含群节点）——bug 的根源：它里面没有 person。 */
const groupModeSubset = filterByMode(nodes, edges, "group", 3);

/** 用同一个 base 输入，只改 drillCommunity。 */
function visibleWith(drillCommunity: string | null): { nodes: GraphPanelNode[]; edges: GraphPanelEdge[] } {
  return resolveVisibleSubset({
    payloadNodes: nodes,
    payloadEdges: edges,
    modeSubset: groupModeSubset,
    aggregateByCommunity: true,
    useCommunity: true,
    showOrphans: false,
    drillCommunity,
  });
}

describe("W-36 社区下钻", () => {
  it("1) 群模式 + 聚合 → 顶层出现 community: 超节点", () => {
    const visible = visibleWith(null);
    const ids = visible.nodes.map((n) => n.id);
    expect(ids).toContain("community:c:aaa");
    expect(ids).toContain("community:c:bbb");
    // 顶层聚合视图里不该有 person
    expect(visible.nodes.some((n) => n.kind === "person")).toBe(false);
  });

  it("2) 下钻 c:aaa → 可见子图包含该社区的 person 成员（旧实现此处红）", () => {
    const visible = visibleWith("c:aaa");
    const persons = visible.nodes.filter((n) => n.kind === "person");
    expect(persons.length).toBeGreaterThan(0);
    // 都是 c:aaa 的成员
    expect(persons.every((n) => n.community_key === "c:aaa")).toBe(true);
  });

  it("3) 下钻后不允许「社区自己还挂在图上」（community: 节点必须 0 个）", () => {
    const visible = visibleWith("c:aaa");
    expect(visible.nodes.filter((n) => n.id.startsWith("community:"))).toHaveLength(0);
  });

  it("4) 下钻到无成员社区 → 可见为空（不许静默退回聚合视图）", () => {
    const visible = visibleWith("c:does-not-exist");
    expect(visible.nodes).toHaveLength(0);
    expect(visible.edges).toHaveLength(0);
  });
});
