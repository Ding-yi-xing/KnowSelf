// @vitest-environment node
/**
 * 能力图谱世界坐标布局与命中半径测试。
 *
 * 能力的分类/分组仅保留在抽取数据中；布局强制投影为无社区节点，交由视口负责适配、缩放和拖拽。
 */
import { describe, expect, it } from "vitest";
import type { GraphPanelEdge, GraphPanelNode } from "../src/client/graph-port.js";
import { layoutAbilityGraph } from "../src/client/ability-layout.js";
import { hitTestNodes } from "../src/client/graph-viewport.js";

function makeNodes(): GraphPanelNode[] {
  const groups = ["AI与智能", "后端", "数据库", "前端协作", "工程工具", "技能标签", "团队领导力", "学习能力", "社团管理"];
  const sizes = [7, 5, 3, 3, 3, 3, 1, 1, 1];
  const labels = [
    "Agent工作流", "Claude Code", "Cursor", "LLM应用开发", "Prompt Engineering", "PyTorch", "YOLO",
    "Java", "Spring Boot", "MyBatis/MyBatis-Plus", "RESTful API", "MQTT",
    "MySQL", "Redis", "PostgreSQL", "Vue3", "UniApp", "HarmonyOS", "Node.js", "Docker", "Git",
    "Python", "Go", "TypeScript", "团队领导力", "学习能力", "社团管理",
  ];
  const nodes: GraphPanelNode[] = [];
  let id = 0;
  groups.forEach((group, groupIndex) => {
    for (let i = 0; i < sizes[groupIndex]!; i += 1) {
      nodes.push({
        id: `n${id}`,
        label: labels[id] ?? `能力${id}`,
        kind: "ability",
        size: 0.5,
        degree: 1 + (sizes[groupIndex]! - i),
        isolated: false,
        community_key: group,
        relation_type: null,
      });
      id += 1;
    }
  });
  return nodes;
}

const EDGES: GraphPanelEdge[] = [
  { id: "e01", source: "n0", target: "n1", kind: "co_presence", strength: 0.9, directed: false },
  { id: "e12", source: "n1", target: "n2", kind: "co_presence", strength: 0.7, directed: false },
  { id: "e23", source: "n2", target: "n3", kind: "co_presence", strength: 0.5, directed: false },
];

describe("layoutAbilityGraph", () => {
  const layout = layoutAbilityGraph(
    { nodes: makeNodes(), edges: EDGES, width: 1000, height: 600 },
    { nodeSizeScale: 1, minRadius: 6 },
  );

  it("保留每个输入节点与有效边", () => {
    expect(layout.nodes).toHaveLength(27);
    expect(layout.edges.map((edge) => edge.id)).toEqual(EDGES.map((edge) => edge.id));
  });

  it("忽略输入中的抽取分组，全部投影为无社区能力节点", () => {
    expect(layout.nodes.every((node) => node.communityKey === null)).toBe(true);
  });

  it("输出的是有限且非塌缩的世界坐标，不要求被限制在当前画布内", () => {
    const xs = layout.nodes.map((node) => node.x);
    const ys = layout.nodes.map((node) => node.y);
    expect(xs.every(Number.isFinite)).toBe(true);
    expect(ys.every(Number.isFinite)).toBe(true);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(20);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);
  });

  it("最小绘制半径受到保障", () => {
    expect(layout.nodes.every((node) => node.radius >= 6)).toBe(true);
    const enlarged = layoutAbilityGraph(
      { nodes: makeNodes().slice(0, 2), edges: [], width: 640, height: 420 },
      { minRadius: 10 },
    );
    expect(enlarged.nodes.every((node) => node.radius >= 10)).toBe(true);
  });
});

describe("hitTestNodes", () => {
  const nodes = [
    { id: "a", x: 100, y: 100, radius: 6 },
    { id: "b", x: 300, y: 300, radius: 6 },
    { id: "c", x: 500, y: 200, radius: 6 },
  ];

  it("小能力节点在最小命中半径内可以被点到", () => {
    expect(hitTestNodes(nodes, { x: 102, y: 101 }, 0, 10)?.id).toBe("a");
    expect(hitTestNodes(nodes, { x: 298, y: 302 }, 0, 10)?.id).toBe("b");
    expect(hitTestNodes(nodes, { x: 502, y: 198 }, 0, 10)?.id).toBe("c");
  });

  it("最小命中半径外的点不会误命中", () => {
    expect(hitTestNodes(nodes, { x: 109, y: 100 }, 0, 10)?.id).toBe("a");
    expect(hitTestNodes(nodes, { x: 100, y: 139 }, 0, 10)).toBeNull();
  });
});
