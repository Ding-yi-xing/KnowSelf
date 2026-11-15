/**
 * 图谱面板的**纯辅助函数**（W-2 从 `graph-panel.tsx` 抽出，压行数 + 可单测）。
 *
 * 放在这里的都是「不碰 React、不碰 DOM 事件对象」的纯逻辑：
 *   - URL 过滤参数的读 / 写（刷新复原）；
 *   - 边类型集合合并（过滤后取数不会让复选框项消失）；
 *   - 指针坐标 → 容器局部坐标；
 *   - 头部摘要文案。
 *
 * 依赖 DOM 的部分（`window.location` / `getBoundingClientRect`）都做了
 * 「非浏览器环境」兜底，因此本模块在 node 里可直接 import。
 */
import type { GraphEdgeKind } from "@knowself/contracts";
import type { GraphPanelPayload } from "./graph-port.js";
import { encodeEdgeKinds, parseEdgeKinds } from "./graph-filter.js";

/** URL 里过滤参数的键名。 */
export const EDGE_KINDS_PARAM = "edge_kinds";

/** 面板失败态（与「数据」互斥）。 */
export type PanelFailure =
  | { kind: "degraded"; reason: string }
  | { kind: "session" }
  | { kind: "error"; message: string };

/**
 * 从当前 URL 读取初始过滤（刷新可复原）。
 * @param search 可选的 query string（缺省读 `window.location.search`，便于单测注入）
 * @returns 选中的边类型；无参数或非浏览器环境返回 `[]`
 */
export function readEdgeKindsFromUrl(search?: string): GraphEdgeKind[] {
  if (search === undefined && typeof window === "undefined") return [];
  const raw = search ?? window.location.search;
  return parseEdgeKinds(new URLSearchParams(raw).get(EDGE_KINDS_PARAM));
}

/**
 * 把过滤状态写回 URL（`replaceState`，不产生历史记录）。
 * @param kinds 选中的边类型（空 = 移除该参数）
 */
export function writeEdgeKindsToUrl(kinds: readonly GraphEdgeKind[]): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    const value = encodeEdgeKinds(kinds);
    if (value === "") url.searchParams.delete(EDGE_KINDS_PARAM);
    else url.searchParams.set(EDGE_KINDS_PARAM, value);
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* 无 history 权限 / file:// 等环境：过滤仍生效，只是不写 URL */
  }
}

/**
 * 合并边类型集合（保持出现顺序、去重）。
 * @param prev 已有集合
 * @param next 本次 payload 里出现的类型
 * @returns 合并结果；无变化时返回原引用，避免多余渲染
 */
export function mergeKinds(
  prev: readonly GraphEdgeKind[],
  next: readonly GraphEdgeKind[],
): GraphEdgeKind[] {
  if (next.every((kind) => prev.includes(kind))) return prev as GraphEdgeKind[];
  const merged = [...prev];
  for (const kind of next) if (!merged.includes(kind)) merged.push(kind);
  return merged;
}

/**
 * 指针位置换算成容器内的局部坐标（CSS 像素）。
 * @param element 容器（canvas 与它左上角对齐）
 * @param clientX 视口坐标
 * @param clientY 视口坐标
 * @returns 局部坐标；矩形不可用时退化为原点
 */
export function localPoint(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/**
 * 头部一行摘要文案（四种态各一句，便于人工与 Playwright 断言）。
 * @param payload 取数结果（可能为 null）
 * @param loading 是否加载中
 * @param failure 失败态（可能为 null）
 * @returns 一行中文摘要
 */
export function summarize(
  payload: GraphPanelPayload | null,
  loading: boolean,
  failure: PanelFailure | null,
): string {
  if (loading) return "加载中…";
  if (failure !== null) return "图谱数据不可用（详见下方提示）";
  if (payload === null) return "尚未取到图谱数据";
  if (payload.snapshot === null) return "还没有图谱快照";
  const { snapshot } = payload;
  return (
    `共 ${snapshot.node_count} 个节点 / ${snapshot.edge_count} 条边 · ` +
    `${snapshot.community_count} 个社区 · 生成于 ${snapshot.generated_at}`
  );
}

/** 空态分支（与 `graph-stage.tsx` 的 `GraphEmptyKind` 同值域，这里用字面量避免循环 import）。 */
export type EmptyKind = "no-data" | "not-mined" | "no-nodes" | "no-relations";

/**
 * 空态判定树（W-9 主理人裁定，**顺序不可换**）。搬到这里是为了让面板主文件只剩编排。
 *
 * 先判「有没有数据」，再判「挖没挖过」，最后才判「图里有什么」。
 * 判反了就会出现最糟的引导：让用户去导入数据，其实数据早就有了只是没挖。
 *
 *   1) chat_message_count === 0      → no-data（还没导过聊天）
 *   2) 无快照 且 有消息               → not-mined（给「开始挖掘」按钮）
 *   3) 有快照 且 node_count === 0     → no-nodes
 *   4) 有快照 且 edge_count === 0     → no-relations（数据里没有第三方）
 *   5) 其余                          → null（画图）
 *
 * 状态端点不可用（`statusUnknown`）时**不猜**：只因「有没有快照」与「图里有什么」判定，
 * 因为这两项数据来自 graph 端点本身，不依赖 mining 状态。
 *
 * @param input 判定所需的四个事实
 * @returns 命中的分支；`null` 表示该画图
 */
export function resolveEmptyKind(input: {
  /** mining 状态是否可用（false = 端点挂了） */
  statusUnknown: boolean;
  /** 聊天消息条数（状态未知时不参与判定） */
  chatMessageCount: number;
  /** 是否有快照 */
  hasSnapshot: boolean;
  /** 节点数 */
  nodeCount: number;
  /** 边数 */
  edgeCount: number;
}): EmptyKind | null {
  if (input.statusUnknown) {
    if (!input.hasSnapshot) return "no-data";
    if (input.nodeCount === 0) return "no-nodes";
    return input.edgeCount === 0 ? "no-relations" : null;
  }
  if (input.chatMessageCount === 0) return "no-data";
  if (!input.hasSnapshot) return "not-mined";
  if (input.nodeCount === 0) return "no-nodes";
  return input.edgeCount === 0 ? "no-relations" : null;
}
