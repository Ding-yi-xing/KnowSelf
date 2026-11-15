/**
 * P3 方案 B：社区聚合视图的**纯函数**测试（渲染层只吃这些结果）。
 *
 * 真实数据依据（`wx-real-root` 1,206 节点）：折叠成 83 个社区后布局 16 ms，
 * 而现状只画 200 个点（丢 1,006 个）、全量布局 1,935 ms。
 */
import { describe, expect, it } from "vitest";
import {
  UNGROUPED_KEY,
  buildCommunityDetail,
  buildCommunityView,
  canUseCommunityView,
  communityLabel,
} from "../src/client/graph-community-view.js";
import type { GraphPanelEdge, GraphPanelNode } from "../src/client/graph-port.js";

/** 造节点。 */
function node(id: string, community: string | null, degree = 1): GraphPanelNode {
  return {
    id,
    label: id,
    kind: "person",
    size: 0.5,
    degree,
    isolated: false,
    relation_type: null,
    community_key: community,
  };
}

/** 造边。 */
function edge(source: string, target: string, strength = 1): GraphPanelEdge {
  return { id: `${source}-${target}`, source, target, kind: "co_presence", strength, directed: false };
}

describe("canUseCommunityView（降级判据）", () => {
  it("多个社区 → 可用", () => {
    expect(canUseCommunityView([node("a", "c:1"), node("b", "c:2")])).toBe(true);
  });

  it("只有一个社区 → 不可用（聚合等于不聚合，反而看不到细节）", () => {
    expect(canUseCommunityView([node("a", "c:1"), node("b", "c:1")])).toBe(false);
  });

  it("完全没有 community_key → 不可用（后端没算社区）", () => {
    expect(canUseCommunityView([node("a", null), node("b", null)])).toBe(false);
  });

  it("空图 → 不可用", () => {
    expect(canUseCommunityView([])).toBe(false);
  });
});

describe("buildCommunityView（折叠）", () => {
  const nodes = [node("a1", "c:aaa"), node("a2", "c:aaa"), node("a3", "c:aaa"), node("b1", "c:bbb"), node("u1", null)];
  const edges = [
    edge("a1", "a2", 1), // 社区内 → 不产生社区间边
    edge("a1", "b1", 2), // 跨社区
    edge("a2", "b1", 3), // 跨社区，与上一条同向 → 合并
    edge("u1", "a1", 5), // 未分组 ↔ 社区
  ];

  it("社区数 = 2 个真实社区 + 1 个未分组", () => {
    const view = buildCommunityView({ nodes, edges });
    expect(view.nodes).toHaveLength(3);
    expect(view.member_count.get("c:aaa")).toBe(3);
    expect(view.member_count.get(UNGROUPED_KEY)).toBe(1);
  });

  it("超节点尺寸 ∝ 成员数（社区 a 最大）", () => {
    const view = buildCommunityView({ nodes, edges });
    const a = view.nodes.find((n) => n.id.endsWith("c:aaa"));
    const b = view.nodes.find((n) => n.id.endsWith("c:bbb"));
    expect(a?.size).toBeGreaterThan(b?.size as number);
    expect(a?.kind).toBe("community");
  });

  it("跨社区边按 strength 求和，社区内边不外显", () => {
    const view = buildCommunityView({ nodes, edges });
    const ab = view.edges.find(
      (e) => e.source.endsWith("c:aaa") && e.target.endsWith("c:bbb"),
    );
    expect(ab?.strength).toBe(5); // 2 + 3
    expect(view.edges).toHaveLength(2); // aaa-bbb 与 ungrouped-aaa
  });

  it("未分组桶有名字，且不会出现「community:undefined」", () => {
    const view = buildCommunityView({ nodes, edges });
    const ungrouped = view.nodes.find((n) => n.id.endsWith(UNGROUPED_KEY));
    expect(ungrouped?.label).toBe("未分组");
    expect(view.nodes.every((n) => !n.id.includes("undefined"))).toBe(true);
  });

  it("communityLabel：真实键 → 社区前 6 位", () => {
    expect(communityLabel("c:fe21ab34cd")).toBe("社区 fe21ab");
  });
});

describe("buildCommunityDetail（下钻）", () => {
  it("只返回该社区成员与其内部边", () => {
    const nodes = [node("a1", "c:aaa"), node("a2", "c:aaa"), node("b1", "c:bbb")];
    const edges = [edge("a1", "a2"), edge("a1", "b1")];
    const detail = buildCommunityDetail({ nodes, edges }, "c:aaa");
    expect(detail.nodes.map((n) => n.id).sort()).toEqual(["a1", "a2"]);
    expect(detail.edges).toHaveLength(1);
  });

  it("未知社区 → 空结果（调用方据此退回顶层，绝不出现空白画布）", () => {
    const detail = buildCommunityDetail({ nodes: [node("a1", "c:aaa")], edges: [] }, "c:nope");
    expect(detail.nodes).toHaveLength(0);
  });
});
