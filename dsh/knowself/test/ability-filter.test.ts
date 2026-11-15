// @vitest-environment node
/**
 * 能力视图独立筛选（纯函数 `filterAbilities`）单测。
 *
 * 分类与抽取分组只是来源元数据，不能驱动“我的能力”视图的筛选、颜色或布局。
 * 本文件只覆盖仍面向用户的筛选：强度、关键词和置信度。
 */
import { describe, expect, it } from "vitest";
import type { AbilityEdge, AbilityNode } from "@knowself/contracts";
import {
  DEFAULT_ABILITY_FILTERS,
  filterAbilities,
  type AbilityFilters,
} from "../src/client/ability-filter.js";

const NODES: AbilityNode[] = [
  { id: "a1", label: "Python", category: "tech", size: 1, degree: 2, community_key: null, confidence: 0.9, attrs: { card_keys: ["skills"], group: "后端", evidence_ref: ["skills#1 《技能清单》: Python"] } },
  { id: "a2", label: "Java", category: "tech", size: 0.6, degree: 1, community_key: null, confidence: 0.7, attrs: { card_keys: ["skills"], group: "后端", evidence_ref: [] } },
  { id: "a3", label: "沟通", category: "soft", size: 0.3, degree: 1, community_key: null, confidence: 0.9, attrs: { card_keys: ["profile"], group: "软技能", evidence_ref: [] } },
  { id: "a4", label: "Redis", category: "tech", size: 0.3, degree: 1, community_key: null, confidence: 0.9, attrs: { card_keys: ["skills"], group: "数据库", evidence_ref: [] } },
];
const EDGES: AbilityEdge[] = [
  { id: "e12", source: "a1", target: "a2", kind: "co_section", weight_raw: 5, strength: 0.9, directed: false, attrs: { evidence_ref: [] } },
  { id: "e14", source: "a1", target: "a4", kind: "co_section", weight_raw: 2, strength: 0.3, directed: false, attrs: { evidence_ref: [] } },
  { id: "e23", source: "a2", target: "a3", kind: "co_section", weight_raw: 1, strength: 0.1, directed: false, attrs: { evidence_ref: [] } },
];

const ids = (nodes: readonly AbilityNode[]): string[] => nodes.map((node) => node.id).sort();
const edgeIds = (edges: readonly AbilityEdge[]): string[] => edges.map((edge) => edge.id).sort();
const f = (patch: Partial<AbilityFilters>): AbilityFilters => ({ ...DEFAULT_ABILITY_FILTERS, ...patch });

function assertNoDangling(nodes: readonly AbilityNode[], edges: readonly AbilityEdge[]): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    expect(nodeIds.has(edge.source), `悬空边 ${edge.id}: source`).toBe(true);
    expect(nodeIds.has(edge.target), `悬空边 ${edge.id}: target`).toBe(true);
  }
}

describe("filterAbilities", () => {
  it("默认不按分类或抽取分组过滤节点", () => {
    const out = filterAbilities(NODES, EDGES, f({}));
    expect(ids(out.nodes)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(edgeIds(out.edges)).toEqual(["e12", "e14", "e23"]);
  });

  it("强度阈值只筛边，不删除已展示节点", () => {
    const out = filterAbilities(NODES, EDGES, f({ minStrength: 0.5 }));
    expect(ids(out.nodes)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(edgeIds(out.edges)).toEqual(["e12"]);
    assertNoDangling(out.nodes, out.edges);
  });

  it("关键词匹配不区分大小写，且不会留下悬空边", () => {
    const out = filterAbilities(NODES, EDGES, f({ search: "PYTHON" }));
    expect(ids(out.nodes)).toEqual(["a1"]);
    expect(out.edges).toEqual([]);
    assertNoDangling(out.nodes, out.edges);
  });

  it("仅看高置信会删除低置信节点及关联边", () => {
    const out = filterAbilities(NODES, EDGES, f({ highConfidenceOnly: true }));
    expect(ids(out.nodes)).toEqual(["a1", "a3", "a4"]);
    expect(edgeIds(out.edges)).toEqual(["e14"]);
    assertNoDangling(out.nodes, out.edges);
  });

  it("组合节点筛选后只保留两端仍存在且强度达标的边", () => {
    const out = filterAbilities(NODES, EDGES, f({ minStrength: 0.5 }));
    expect(ids(out.nodes)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(edgeIds(out.edges)).toEqual(["e12"]);
    assertNoDangling(out.nodes, out.edges);
  });
});
