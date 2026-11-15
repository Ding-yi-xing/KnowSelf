/**
 * 图谱画布的**交互 hook**（W-2 从 `graph-panel.tsx` 抽出）。
 *
 * 面板拆分前 483 行（超 350 行上限）。缩放 / 平移 / 悬停 / 点击这一组状态与事件
 * 彼此耦合（拖拽阈值、命中换算、锚点缩放），集中到一个 hook 里比散在组件里更清楚，
 * 也让面板只剩「取数 → 三态 → 组装」。
 *
 * ## 事件模型
 *   - **滚轮**：原生 `wheel` + `{ passive:false }`。React 的 `onWheel` 是 passive，
 *     在里面 `preventDefault()` 会被浏览器忽略（控制台告警），必须原生绑定。
 *   - **拖拽**：pointer 事件（触屏/手写笔同样可用）；位移 ≤ {@link DRAG_THRESHOLD}
 *     仍算「点击」，避免手抖导致点了没反应。
 *   - **命中**：先用 `toGraph` 把屏幕坐标换回图坐标，再 `hitTestNodes`；
 *     容差 `HIT_PAD_SCREEN / scale` 保证屏幕上始终是 4px 手感。
 *
 * ## 与「取数」的分工
 * 本 hook **不认识** payload：它只接受已算好的 `layout` 与画布 `size`，
 * 因此可以在没有网络、没有 React 生命周期的场景里被理解。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from "react";
import type { GraphLayoutResult } from "./graph-layout.js";
import { localPoint } from "./graph-panel-helpers.js";
import {
  fitViewport,
  hitTestNodes,
  IDENTITY_VIEWPORT,
  toGraph,
  zoomAt,
  type Viewport,
} from "./graph-viewport.js";

/** 滚轮每一格的缩放因子。 */
export const ZOOM_STEP = 1.12;
/** 按钮缩放的固定因子。 */
export const BUTTON_ZOOM = 1.25;
/** 判定「拖拽」而非「点击」的位移阈值（CSS 像素）。 */
const DRAG_THRESHOLD = 3;
/** 命中容差（屏幕像素；换算到图坐标时除以 scale）。 */
const HIT_PAD_SCREEN = 4;

/** hook 入参。 */
export interface GraphInteractionsOptions {
  /** 当前布局（`null` = 还没画，交互一律空转）。 */
  layout: GraphLayoutResult | null;
  /** 画布尺寸（CSS 像素）。 */
  size: { width: number; height: number };
  /** 点击人物节点回调（可选；缺省不崩）。 */
  onSelectPerson?: ((personId: string) => void) | undefined;
  /**
   * 最小命中半径（屏幕 px，缺省 0 = 只按绘制半径 + 4px 容差）。
   * 能力视图传 10：小节点也能点开证据详情（`max(绘制半径, 10px)`）。
   */
  minHitRadius?: number;
}

/** hook 返回值。 */
export interface GraphInteractions {
  containerRef: RefObject<HTMLDivElement | null>;
  viewport: Viewport;
  setViewport: Dispatch<SetStateAction<Viewport>>;
  hoveredId: string | null;
  /** 当前打开的右键菜单（`nodeId` + 相对舞台坐标）。 */
  contextMenu: { nodeId: string; x: number; y: number } | null;
  resetViewport: () => void;
  zoomFromButton: (factor: number) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  closeContextMenu: () => void;
  onClick: (event: { clientX: number; clientY: number }) => void;
}

/**
 * 图谱画布交互状态机。
 * @param options 见 {@link GraphInteractionsOptions}
 * @returns 状态 + 事件处理器（直接铺到画布舞台上）
 */
export function useGraphInteractions({
  layout,
  size,
  onSelectPerson,
  minHitRadius = 0,
}: GraphInteractionsOptions): GraphInteractions {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);
  /**
   * 「这次 pointerup 之后紧跟的 click 要吞掉」标记。
   *
   * 为什么需要它：浏览器在**拖拽结束后仍会派发一次 click**，而 `onPointerUp`
   * 已经把 `dragRef` 置空——只靠 `dragRef.current.moved` 判不出来，结果
   * 「拖完松手」会被当成点击、把用户莫名其妙地带进某个人物档案。
   * 因此把「刚拖过」这件事记在独立 ref 上，由紧随其后的 click 消费一次。
   */
  const suppressClickRef = useRef(false);

  /** 屏幕坐标 → 命中节点（无布局时恒 null）。 */
  const hitAt = useCallback(
    (clientX: number, clientY: number) => {
      const element = containerRef.current;
      if (element === null || layout === null) return null;
      const point = localPoint(element, clientX, clientY);
      return hitTestNodes(
        layout.nodes,
        toGraph(point, viewport),
        HIT_PAD_SCREEN / viewport.scale,
        minHitRadius / viewport.scale,
      );
    },
    [layout, viewport, minHitRadius],
  );

  // 原生 wheel（passive:false 才能 preventDefault）
  useEffect(() => {
    const element = containerRef.current;
    if (element === null || layout === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const point = localPoint(element, event.clientX, event.clientY);
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setViewport((prev) => zoomAt(prev, point, factor));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [layout]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    setContextMenu(null);
    if (layout === null) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      offsetX: viewport.offsetX,
      offsetY: viewport.offsetY,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* jsdom / 老浏览器没有 pointer capture：不影响拖拽 */
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (layout === null) return;
    const drag = dragRef.current;
    if (drag !== null) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
      if (drag.moved) {
        // 标记「刚拖过」，让紧随 pointerup 的 click 被吞掉
        suppressClickRef.current = true;
        setViewport((prev) => ({ ...prev, offsetX: drag.offsetX + dx, offsetY: drag.offsetY + dy }));
        return;
      }
    }
    const hit = hitAt(event.clientX, event.clientY);
    const nextId = hit?.id ?? null;
    setHoveredId((prev) => (prev === nextId ? prev : nextId));
  };

  const onPointerUp = (): void => {
    dragRef.current = null;
  };

  const onPointerLeave = (): void => {
    dragRef.current = null;
    setHoveredId(null);
  };

  const onClick = (event: { clientX: number; clientY: number }): void => {
    setContextMenu(null);
    // 拖拽后浏览器仍会补一次 click：吞掉它（见 suppressClickRef 注释）
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      dragRef.current = null;
      return;
    }
    if (dragRef.current?.moved === true) {
      dragRef.current = null;
      return;
    }
    dragRef.current = null;
    const hit = hitAt(event.clientX, event.clientY);
    if (hit === null) return;
    // 社区超节点也要能点：面板侧 `onSelectPerson` 会按 `community:` 前缀分流（下钻到成员）。
    // 能力节点（0.5.0）：点它打开证据详情侧栏（面板侧按 isAbility 分流）。
    if (hit.kind !== "person" && hit.kind !== "direct" && hit.kind !== "community" && hit.kind !== "ability") return;
    onSelectPerson?.(hit.id);
  };

  const closeContextMenu = useCallback((): void => setContextMenu(null), []);

  /** 右键：命中节点 → 在舞台局部坐标处打开上下文菜单；空白处 → 关闭。 */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const element = containerRef.current;
    if (element === null || layout === null) return;
    const point = localPoint(element, event.clientX, event.clientY);
    const hit = hitTestNodes(layout.nodes, toGraph(point, viewport), HIT_PAD_SCREEN / viewport.scale);
    // 右键菜单只对 person / direct 节点提供（改名 / 合并 / 删除 / 认领）；其余不弹。
    if (hit === null || (hit.kind !== "person" && hit.kind !== "direct")) {
      setContextMenu(null);
      return;
    }
    setContextMenu({ nodeId: hit.id, x: point.x, y: point.y });
  };

  const resetViewport = useCallback((): void => {
    if (layout === null || size.width < 1 || size.height < 1) {
      setViewport(IDENTITY_VIEWPORT);
      return;
    }
    setViewport(fitViewport(layout.nodes, { width: size.width, height: size.height }));
  }, [layout, size.width, size.height]);

  /** 以画布中心为锚点做按钮缩放。 */
  const zoomFromButton = useCallback(
    (factor: number): void => {
      setViewport((prev) => zoomAt(prev, { x: size.width / 2, y: size.height / 2 }, factor));
    },
    [size.width, size.height],
  );

  return {
    containerRef,
    viewport,
    setViewport,
    hoveredId,
    contextMenu,
    resetViewport,
    zoomFromButton,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onContextMenu,
    closeContextMenu,
    onClick,
  };
}
