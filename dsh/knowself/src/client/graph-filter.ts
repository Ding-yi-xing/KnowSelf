/**
 * 图谱**边类型过滤**（纯函数，零依赖）。
 *
 * ## 语义（与宿主 `GET /graph?edge_kinds=a,b` 对齐）
 *   - `selected` 为空数组 = **不过滤**（返回全部）。这条很重要：面板初始态是「全不勾」，
 *     若把它解释成「一条边都不要」，用户一进面板就只看到孤零零的点。
 *   - `selected` 非空 = 只保留这些 `kind` 的边，顺序保持输入顺序（保证布局与渲染稳定）。
 *
 * ## 为什么要客户端也过滤一遍
 * 正常路径是「改过滤 → 带 `edge_kinds` 重新取数 → 服务端过滤」。但：
 *   ① 服务端过滤后节点集合不变，仍会有「边没了但点还在」的中间态；
 *   ② 若用户选了某类型而后端因版本差异忽略了参数，客户端再过滤一次能兜住
 *      （宁可按用户选择显示，也不要显示他没选的东西）。
 *
 * ## 与「可用类型」的关系
 * 复选框选项**来自 payload 里实际出现的边类型**（不硬编码 `GraphEdgeKind` 全集）：
 * 后端将来新增/下线类型时，前端不需要改代码。见 {@link collectEdgeKinds}。
 */
import type { GraphEdgeKind } from "@knowself/contracts";

/** 过滤只看类型的边（结构型，便于测试传任意形状）。 */
export interface KindedEdge {
  kind: GraphEdgeKind;
}

/**
 * 收集当前数据里**实际出现**的边类型（去重 + 稳定排序）。
 *
 * @param edges 边集合
 * @returns 类型数组（按出现顺序去重；空输入返回空数组）
 */
export function collectEdgeKinds(edges: readonly KindedEdge[]): GraphEdgeKind[] {
  const seen = new Set<GraphEdgeKind>();
  const out: GraphEdgeKind[] = [];
  for (const edge of edges) {
    if (seen.has(edge.kind)) continue;
    seen.add(edge.kind);
    out.push(edge.kind);
  }
  return out;
}

/**
 * 按选中类型过滤边。
 *
 * @param edges 边集合
 * @param selected 选中的类型集合；**空 = 全部**
 * @returns 过滤后的边（新数组，不修改输入）
 */
export function filterEdges<T extends KindedEdge>(
  edges: readonly T[],
  selected: readonly GraphEdgeKind[],
): T[] {
  if (selected.length === 0) return [...edges];
  const allow = new Set<GraphEdgeKind>(selected);
  return edges.filter((edge) => allow.has(edge.kind));
}

/**
 * 把 URL 里的 `edge_kinds=a,b` 解析成类型数组。
 *
 * 容错：空串 / 只有逗号 / 有空白都当作「没有过滤」；未知值原样保留
 * （后端若已下线该类型，取数会自然少几条边，不需要前端维护白名单）。
 *
 * @param raw URL 参数原值（可能为 `null`）
 * @returns 类型数组（`[]` = 不过滤）
 */
export function parseEdgeKinds(raw: string | null | undefined): GraphEdgeKind[] {
  if (raw === null || raw === undefined) return [];
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return [...new Set(parts)] as GraphEdgeKind[];
}

/**
 * 把选中类型序列化成 URL 参数值（与 {@link parseEdgeKinds} 互逆）。
 *
 * @param selected 选中类型
 * @returns `"a,b"`；空选中返回 `""`（调用方据此**不写**该参数）
 */
export function encodeEdgeKinds(selected: readonly GraphEdgeKind[]): string {
  return selected.join(",");
}
