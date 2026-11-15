/**
 * 图谱面板的**空态视图**（C3 从 `graph-panel.tsx` 搬出，纯搬家）。
 *
 * 空态本身（文案、testid、五分支判定）仍在 `graph-stage.tsx` 的 `GraphEmptyState`；
 * 这里只负责把面板的回调与状态**装配**进去，让面板主文件不再被这段接线占篇幅。
 *
 * 五分支顺序的权威解释在 `graph-panel-helpers.ts` 的 `resolveEmptyKind()`
 * （顺序不可换：先判「有没有数据」，再判「挖没挖过」，最后判「图里有什么」）。
 */
import type { ReactElement } from "react";
import { GraphEmptyState, type GraphEmptyKind } from "./graph-stage.js";

/** 空态视图 props。 */
export interface GraphEmptyViewProps {
  /** 命中的分支（面板用 `resolveEmptyKind()` 算好）。 */
  kind: GraphEmptyKind;
  /** 宿主给的兜底提示（仅「状态未知」分支会用到）。 */
  hint?: string | undefined;
  /** 节点数（展示事实）。 */
  nodeCount: number;
  /** 边数（展示事实）。 */
  edgeCount: number;
  /** 触发挖掘。 */
  onRunMining: () => void;
  /** 挖掘进行中。 */
  miningBusy: boolean;
  /** 挖掘失败提示。 */
  miningError: string | null;
  /** 状态端点不可用（无法区分"没数据"与"没挖过"）。 */
  statusUnknown: boolean;
  /** 重试状态端点。 */
  onRetryStatus: () => void;
  /** 重新取数。 */
  onRefresh: () => void;
}

/**
 * 渲染空态块。
 * @param props 见 {@link GraphEmptyViewProps}
 * @returns 空态元素
 */
export function GraphEmptyView(props: GraphEmptyViewProps): ReactElement {
  return (
    <GraphEmptyState
      kind={props.kind}
      hint={props.hint}
      nodeCount={props.nodeCount}
      edgeCount={props.edgeCount}
      onRunMining={props.onRunMining}
      miningBusy={props.miningBusy}
      miningError={props.miningError}
      statusUnknown={props.statusUnknown}
      onRetryStatus={props.onRetryStatus}
      onRefresh={props.onRefresh}
    />
  );
}
