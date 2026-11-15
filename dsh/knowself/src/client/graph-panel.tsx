/**
 * 知识图谱面板 —— `main` keyed slot `knowself-graph` 的 occupant。
 *
 * ## 数据
 * 只经 `KnowselfGraphPort`（props 注入，默认同 origin `/knowself-api/graph`）取数；
 * 面板**不 import** `@knowself/mining` / `person-store` 运行时（浏览器直连不了 better-sqlite3）。
 *
 * ## 分工
 *   本文件只做**状态与编排**：取数 / 三态 / 交互装配 / 绘制。
 *   视图模式与子图 → `graph-subgraph.ts`；设置状态与力参数映射 → `graph-settings.ts`；
 *   坐标数学 → `graph-viewport.ts`；canvas 绘制 → `graph-canvas.ts`；
 *   交互状态机（滚轮 / 拖拽 / 悬停 / 点击 / 右键）→ `graph-interactions.ts`；
 *   设置浮层 → `graph-settings-panel.tsx`；右键菜单 → `graph-context-menu.tsx`。
 *
 * ## 视图模式（四选一，替换旧的边类型复选框 + 「仅看我的直接关系」）
 *   - 群（默认）：社区聚合视图（关系簇）；无社区数据时降级为全量成员；
 *   - 人：人物 / 单聊节点；
 *   - 仅与我直接关系：在「人」基础上只保留以「我」为中心 N 层邻居（深度取 ⚙ 滑块）。
 *   - 我的能力：独立能力快照；不使用能力分类、分组或社区投影驱动筛选、颜色、布局和详情展示。
 *
 * ## 观感
 *   默认**不画孤立节点**（诱导度数 0），并在布局里把它们排除，避免斥力把散点顶到画布边缘。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { PersonPanelDataPort } from "./data-port.js";
import type { GraphContextMenuActions } from "./graph-context-menu.js";
import type { GraphPanelEdge, GraphPanelNode, KnowselfGraphPort } from "./graph-port.js";
import { DegradedError, SessionExpiredError } from "./profile-port.js";
import { layoutGraph, type GraphLayoutResult } from "./graph-layout.js";
import { drawGraph } from "./graph-canvas.js";
import { layoutAbilityGraph } from "./ability-layout.js";
import { useGraphInteractions, BUTTON_ZOOM } from "./graph-interactions.js";
import { GraphEmptyView } from "./graph-empty-view.js";
import { GraphCanvasArea } from "./graph-canvas-area.js";
import { GraphPanelHeader, GraphToolbar } from "./graph-toolbar.js";
import { GraphSettingsPanel } from "./graph-settings-panel.js";
import { PanelShell } from "./ui-kit.js";
import {
  COMMUNITY_NODE_PREFIX,
  UNGROUPED_KEY,
  canUseCommunityView,
  communityLabel,
} from "./graph-community-view.js";
import { createRestMiningPort, type MiningPort } from "./mining-port.js";
import { GraphClaimPanel } from "./graph-claim-panel.js";
import type { PersonWritePort } from "./person-write-port.js";
import { useGraphPayload, useMiningRefreshSignal, useMiningStatus } from "./graph-data.js";
import {
  clampGraphSettings,
  DEFAULT_GRAPH_SETTINGS,
  edgeWidthScaleFactor,
  layoutOptionsFromSettings,
  type GraphSettings,
} from "./graph-settings.js";
import {
  applySearchFilter,
  filterByMode,
  resolveVisibleSubset,
  type GraphMode,
  type GraphSubset,
} from "./graph-subgraph.js";
import {
  resolveEmptyKind,
  summarize,
  type EmptyKind,
  type PanelFailure,
} from "./graph-panel-helpers.js";
import { fitViewport } from "./graph-viewport.js";
import {
  DegradedNotice,
  ErrorNotice,
  LoadingNotice,
  PANEL_COLORS,
  SessionExpiredNotice,
} from "./panel-states.js";
import type { AbilityEdge, AbilityNode } from "@knowself/contracts";
import {
  createRestAbilityPort,
  type AbilitySnapshotResponse,
  type KnowselfAbilityPort,
} from "./ability-graph-port.js";
import {
  DEFAULT_ABILITY_FILTERS,
  filterAbilities,
  type AbilityFilters,
} from "./ability-filter.js";
import { AbilityFilterBar } from "./ability-filter-bar.js";
import { AbilityNodeDetail } from "./ability-node-detail.js";
import { AbilityEmpty } from "./ability-empty.js";

export { truncateLabel } from "./graph-canvas.js";

/** 能力节点 → 画布节点（保留能力本身，不按抽取分组分类）。 */
export function abilityToPanelNode(node: AbilityNode): GraphPanelNode {
  return {
    id: node.id,
    label: node.label,
    kind: "ability",
    size: node.size,
    degree: node.degree,
    isolated: false,
    community_key: null,
    relation_type: null,
  };
}

/** 能力边 → 画布边（能力边类型不进 `GraphEdgeKind`，统一投影为 `co_presence` 以复用 canvas）。 */
export function abilityToPanelEdge(edge: AbilityEdge): GraphPanelEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: "co_presence",
    strength: edge.strength,
    directed: false,
  };
}

/** 组件 props。 */
export interface GraphPanelViewProps {
  /** 只读图谱数据端口（由 client 入口装配，默认走同 origin REST）。 */
  port: KnowselfGraphPort;
  /**
   * 点击人物节点时的回调（W-2）。缺省不崩：只做画布交互，不跳面板。
   * @param personId 被点击的人物 id（即节点 id）
   */
  onSelectPerson?: (personId: string) => void;
  /** 挖掘状态端口（W-9：空态判定用；缺省走同 origin REST）。 */
  miningPort?: MiningPort;
  /** W29 B2：认领写端口（可选；未注入时不显示认领面板与写动作）。 */
  claimPort?: PersonWritePort;
  /** 人物只读端口（右键「合并到…」搜索目标用；缺省不提供合并搜索）。 */
  personPort?: PersonPanelDataPort;
  /** 能力图谱只读端口（0.5.0；缺省走同 origin `/knowself-api/ability-graph`）。 */
  abilityPort?: KnowselfAbilityPort;
  /** 能力空态「去待整理」回调（跳到待整理面板；缺省时按钮无副作用）。 */
  onGoInbox?: () => void;
}

/** 面板内容区样式。 */
const BODY_STYLE = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "0 16px 16px",
} as const;

/**
 * 图谱面板主区视图。
 * @param props 见 {@link GraphPanelViewProps}
 * @returns 面板元素
 */
export function GraphPanelView({
  port,
  onSelectPerson,
  miningPort,
  claimPort,
  personPort,
  abilityPort,
  onGoInbox,
}: GraphPanelViewProps): ReactElement {
  const [reloadToken, setReloadToken] = useState<number>(0);
  /** W29 B2：被选中待认领的节点（`null` = 未选中）。 */
  const [selectedNode, setSelectedNode] = useState<GraphPanelNode | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [canvasUnsupported, setCanvasUnsupported] = useState<boolean>(false);
  /** 视图模式（默认「群」= 社区聚合视图）。 */
  const [mode, setMode] = useState<GraphMode>("group");
  /** 当前下钻的社区键（`null` = 顶层社区视图）。 */
  const [drillCommunity, setDrillCommunity] = useState<string | null>(null);
  /** 挖掘触发中（按钮 disabled）。 */
  const [miningBusy, setMiningBusy] = useState(false);
  /** 挖掘失败提示。 */
  const [miningError, setMiningError] = useState<string | null>(null);
  /** 图谱设置（四组 + 局部图深度）。 */
  const [settings, setSettings] = useState<GraphSettings>(DEFAULT_GRAPH_SETTINGS);
  /** 设置浮层是否展开。 */
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  // ── 能力视图（0.5.0）独立状态：与人物视图 mode/settings 各不相干，切走再切回不丢 ──
  const [abilityResp, setAbilityResp] = useState<AbilitySnapshotResponse | null>(null);
  const [abilityLoading, setAbilityLoading] = useState<boolean>(false);
  const [abilityFailure, setAbilityFailure] = useState<PanelFailure | null>(null);
  const [abilityFilters, setAbilityFilters] = useState<AbilityFilters>(DEFAULT_ABILITY_FILTERS);
  const [selectedAbilityId, setSelectedAbilityId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 挖掘端口：缺省走同 origin REST（与 graph 端口并行拉，不串行等待）
  const mining = useMemo<MiningPort>(() => miningPort ?? createRestMiningPort(), [miningPort]);
  // 能力端口：缺省走同 origin REST（惰性：切到能力视图才取数）
  const ability = useMemo<KnowselfAbilityPort>(
    () => abilityPort ?? createRestAbilityPort(),
    [abilityPort],
  );

  const toFailure = useCallback((err: unknown): PanelFailure => {
    if (err instanceof SessionExpiredError) return { kind: "session" };
    if (err instanceof DegradedError) return { kind: "degraded", reason: err.reason };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }, []);

  const reload = useCallback((): void => setReloadToken((n) => n + 1), []);
  const patchSettings = useCallback(
    (patch: Partial<GraphSettings>): void =>
      setSettings((prev) => clampGraphSettings({ ...prev, ...patch })),
    [],
  );

  // ① 取数 / ①b 挖掘状态 / ①c 刷新信号（边类型过滤已取消 → kindsKey 恒为空）
  const { payload, loading, failure } = useGraphPayload({
    port,
    kindsKey: "",
    reloadToken,
    toFailure,
  });
  const miningStatus = useMiningStatus({ mining, reloadToken });
  useMiningRefreshSignal(reload);

  // ── 能力视图（0.5.0）：惰性取数（切到能力视图才拉）+ 独立筛选 + 证据节点 ──
  const isAbility = mode === "ability";
  const abilityFetchStarted = useRef<boolean>(false);
  useEffect(() => {
    if (!isAbility) return;
    if (abilityResp !== null || abilityFailure !== null || abilityFetchStarted.current) return;
    abilityFetchStarted.current = true;
    setAbilityLoading(true);
    void (async () => {
      try {
        const resp = await ability.getSnapshot();
        setAbilityResp(resp);
      } catch (err) {
        setAbilityFailure(toFailure(err));
      } finally {
        setAbilityLoading(false);
        abilityFetchStarted.current = false;
      }
    })();
  }, [isAbility, abilityResp, abilityFailure, ability]);

  const abilityFiltered = useMemo(() => {
    if (abilityResp === null) return { nodes: [] as AbilityNode[], edges: [] as AbilityEdge[] };
    return filterAbilities(abilityResp.snapshot.nodes, abilityResp.snapshot.edges, abilityFilters);
  }, [abilityResp, abilityFilters]);
  const abilityPanelNodes = useMemo<GraphPanelNode[]>(
    () => abilityFiltered.nodes.map(abilityToPanelNode),
    [abilityFiltered],
  );
  const abilityPanelEdges = useMemo<GraphPanelEdge[]>(
    () => abilityFiltered.edges.map(abilityToPanelEdge),
    [abilityFiltered],
  );
  const selectedAbility = useMemo<AbilityNode | null>(
    () =>
      abilityResp !== null && selectedAbilityId !== null
        ? abilityResp.snapshot.nodes.find((node) => node.id === selectedAbilityId) ?? null
        : null,
    [abilityResp, selectedAbilityId],
  );

  /** 是否启用社区聚合视图（快照缺 community_key / 只有一个社区时自动降级）。 */
  const useCommunity = useMemo<boolean>(
    () => payload !== null && canUseCommunityView(payload.nodes),
    [payload],
  );

  /** 搜索过滤后的成员级子图（后续模式 / 社区聚合都基于它）。 */
  const searched = useMemo<GraphSubset>(() => {
    if (payload === null) return { nodes: [], edges: [] };
    return applySearchFilter(payload.nodes, payload.edges, settings.searchQuery);
  }, [payload, settings.searchQuery]);

  /** 当前模式的成员级子图（群=真实群聊+共同成员网络；人=person/direct；仅与我=me 的 N 层）。 */
  const modeSubset = useMemo<GraphSubset>(() => {
    if (payload === null) return { nodes: [], edges: [] };
    let subset = filterByMode(searched.nodes, searched.edges, mode, settings.localDepth);
    // 只显示已建档（人 / 仅与我模式）：去掉 direct
    if (settings.onlyProfiled && (mode === "person" || mode === "neighbors")) {
      const ids = new Set(subset.nodes.filter((node) => node.kind === "person").map((node) => node.id));
      subset = {
        nodes: subset.nodes.filter((node) => ids.has(node.id)),
        edges: subset.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
      };
    }
    return subset;
  }, [payload, searched, mode, settings.localDepth, settings.onlyProfiled]);

  /** 颜色分组（设置浮层里的社区色点列表；不再是底部标签栏）。 */
  const communities = useMemo<{ key: string | null; label: string }[]>(() => {
    if (payload === null) return [];
    const seen = new Map<string, string | null>();
    for (const node of payload.nodes) {
      const key = node.community_key ?? null;
      if (!seen.has(key ?? UNGROUPED_KEY)) seen.set(key ?? UNGROUPED_KEY, key);
    }
    return [...seen.entries()]
      .map(([, key]) => ({ key, label: key === null ? "未分组" : communityLabel(key) }))
      .sort((a, b) => {
        if (a.key === null) return 1;
        if (b.key === null) return -1;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
  }, [payload]);

  /**
   * 画布输入：
   *   ① 模式子图（群 / 人 / 仅与我）；
   *   ② 若开启「按社区聚合」→ 折叠成社区超节点（下钻则看成员）；
   *   ③ 默认去孤立 + **只保留最大连通分量**（主图之外不留游离簇）。
   */
  const visible = useMemo<GraphSubset>(() => {
    if (payload === null) return { nodes: [], edges: [] };
    // 聚合 / 下钻 / 去孤立统一走纯函数（下钻基于全量快照；空结果不静默退回 —— W-36）
    return resolveVisibleSubset({
      payloadNodes: payload.nodes,
      payloadEdges: payload.edges,
      modeSubset,
      aggregateByCommunity: settings.aggregateByCommunity,
      useCommunity,
      showOrphans: settings.showOrphans,
      drillCommunity,
    });
  }, [payload, modeSubset, settings.aggregateByCommunity, settings.showOrphans, useCommunity, drillCommunity]);

  const layout = useMemo<GraphLayoutResult | null>(() => {
    // 能力视图：无分组的世界坐标力导向布局；视口负责适配与平移。
    if (isAbility) {
      if (abilityPanelNodes.length === 0) return null;
      if (size.width < 1 || size.height < 1) return null;
      return layoutAbilityGraph(
        { nodes: abilityPanelNodes, edges: abilityPanelEdges, width: size.width, height: size.height },
        { nodeSizeScale: settings.nodeSizeScale / 5, minRadius: 6 },
      );
    }
    if (payload === null || payload.snapshot === null || visible.nodes.length === 0) return null;
    // 人物视图：通用力学布局（input 与 options 是两个参数）
    return layoutGraph(
      { nodes: visible.nodes, edges: visible.edges, width: size.width, height: size.height },
      {
        ...layoutOptionsFromSettings(settings),
        maxNodes: mode === "person" ? 200 : 999,
        ...(mode === "neighbors" ? { radialCenterId: "me" } : {}),
      },
    );
  }, [isAbility, abilityPanelNodes, abilityPanelEdges, visible, payload, size.width, size.height, settings, mode]);

  /** 是否按社区上色（有社区数据 + 设置开启时才用社区色，否则回退节点类型色）。 */
  const colorByCommunity = settings.colorByCommunity && useCommunity;

  // ④ 交互（滚轮 / 拖拽 / 悬停 / 点击 / 右键）
  const {
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
  } = useGraphInteractions({
    layout,
    size,
    // 能力视图：命中半径 max(绘制半径, 10px)，小节点也点得到
    minHitRadius: isAbility ? 10 : 0,
    onSelectPerson: (nodeId: string) => {
      // 能力视图：点节点 → 打开证据详情侧栏（不跳人物面板、不认领）
      if (isAbility) {
        setSelectedAbilityId(nodeId);
        return;
      }
      if (nodeId.startsWith(COMMUNITY_NODE_PREFIX)) {
        const key = nodeId.slice(COMMUNITY_NODE_PREFIX.length);
        setDrillCommunity(key === UNGROUPED_KEY ? UNGROUPED_KEY : key);
        return;
      }
      // W29 B2：反查完整 DTO；direct 或未识别 person → 打开认领面板（不跳人物面板）。
      const full = payload?.nodes.find((node) => node.id === nodeId);
      const needsClaim =
        full !== undefined &&
        claimPort !== undefined &&
        (full.kind === "direct" || (full.kind === "person" && full.label.startsWith("未识别·")));
      if (needsClaim) {
        setSelectedNode(full);
        return;
      }
      onSelectPerson?.(nodeId);
    },
  });

  // ⑤ 新布局完成后将世界坐标适配到当前画布。之后用户平移/缩放不受影响，
  // 因为 layout 不依赖 viewport。
  useEffect(() => {
    if (layout === null || size.width < 1 || size.height < 1) return;
    setViewport(fitViewport(layout.nodes, size));
  }, [layout, size.width, size.height, setViewport]);

  // ⑥ 跟随容器尺寸（ResizeObserver 不可用时退化为挂载时量一次）
  const stageMounted = layout !== null;
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.floor(rect.width));
      const height = Math.max(0, Math.floor(rect.height));
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [stageMounted, isAbility, abilityPanelNodes.length, containerRef]);

  // ⑦ 绘制
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || layout === null) return;
    if (size.width < 1 || size.height < 1) return;
    const drawn = drawGraph(
      canvas,
      layout,
      Math.max(1, Math.round(size.width)),
      Math.max(1, Math.round(size.height)),
      {
        viewport,
        hoveredId,
        // 能力视图统一按能力类型着色；人物视图仍可按社区着色。
        colorByCommunity: isAbility ? false : colorByCommunity,
        showLabels: settings.showLabels,
        edgeWidthScale: edgeWidthScaleFactor(settings),
      },
    );
    setCanvasUnsupported((prev) => (prev === !drawn ? prev : !drawn));
  }, [layout, size.width, size.height, viewport, hoveredId, colorByCommunity, settings, isAbility]);

  // ⑧ 右键菜单：把布局节点 / 完整 DTO 解析出来，接到写端口
  const contextMenuNode = useMemo(() => {
    if (contextMenu === null || layout === null) return null;
    return layout.nodes.find((node) => node.id === contextMenu.nodeId) ?? null;
  }, [contextMenu, layout]);

  const contextMenuActions = useMemo<GraphContextMenuActions | null>(() => {
    if (contextMenuNode === null) return null;
    const nodeId = contextMenuNode.id;
    const full = payload?.nodes.find((node) => node.id === nodeId);
    return {
      canWrite: claimPort !== undefined,
      onRename: async (name: string): Promise<void> => {
        if (claimPort === undefined) return;
        await claimPort.updatePerson(nodeId, { display_name: name });
        reload();
      },
      onMerge: async (targetPersonId: string): Promise<void> => {
        if (claimPort === undefined) return;
        await claimPort.mergePerson(nodeId, targetPersonId, "manual-merge");
        reload();
      },
      onDelete: async (): Promise<void> => {
        if (claimPort === undefined) return;
        await claimPort.archivePerson(nodeId);
        reload();
      },
      onClaim: (): void => {
        if (full !== undefined) setSelectedNode(full);
      },
      searchPersons: (keyword: string) =>
        personPort?.listPersons({ keyword, limit: 8 }) ?? [],
      onClose: closeContextMenu,
    };
  }, [contextMenuNode, payload, claimPort, personPort, closeContextMenu, reload]);

  /**
   * 触发挖掘。成功后**重新拉两个端点**再重渲染（不乐观更新——快照是服务端算的，
   * 前端猜出来的节点/边数没有意义）。
   */
  const onRunMining = useCallback((): void => {
    setMiningBusy(true);
    setMiningError(null);
    void (async () => {
      try {
        await mining.run();
        setReloadToken((n) => n + 1);
      } catch (err) {
        setMiningError(err instanceof Error ? err.message : String(err));
      } finally {
        setMiningBusy(false);
      }
    })();
  }, [mining]);

  const nodeCount = payload?.nodes.length ?? 0;
  const edgeCount = payload?.edges.length ?? 0;
  /** W29 A3：悬停节点的完整 wxid（交给 canvas 的原生 title 上屏）。 */
  // 悬停节点的完整标题：优先用当前视图节点（群占位节点会带 title=原群号；人物带 wxid）
  const hoveredVisibleNode = visible.nodes.find((node) => node.id === hoveredId);
  const canvasTitle =
    hoveredVisibleNode?.title ?? payload?.nodes.find((node) => node.id === hoveredId)?.title;
  const hasSnapshot = payload !== null && payload.snapshot !== null;
  /**
   * 空态判定树（W-9 主理人裁定，**顺序不可换**）：实现搬到 `graph-panel-helpers.ts`
   * 的 `resolveEmptyKind()`，那里有逐条说明；本文件只负责喂事实。
   */
  const emptyKind: EmptyKind | null = resolveEmptyKind({
    statusUnknown: miningStatus === null,
    chatMessageCount: miningStatus?.chat_message_count ?? 0,
    hasSnapshot,
    nodeCount,
    edgeCount,
  });
  // 只有边才构成「关系图」；只有一个孤点时不画（画了也没有信息量，还会误导）
  // 能力视图：有节点即画（能力节点哪怕无边也是「能力项」）；0 节点走 ability-empty。
  const hasGraph = isAbility ? abilityPanelNodes.length > 0 : emptyKind === null;
  // 开启「按社区聚合」时才有社区超节点 / 面包屑
  const communityMode = settings.aggregateByCommunity && useCommunity;
  // 下钻到「无成员社区」：visible 为空，但不许静默退回聚合 —— 面包屑旁给一行说明（W-36）
  const communityEmpty = communityMode && drillCommunity !== null && visible.nodes.length === 0;
  // 所有统计 / 诊断信息统一收进 ⚙「统计」小节（主界面不再出现整句批注）
  const statsLines = useMemo<string[]>(() => {
    // 能力视图：网络/边计数、快照信息、缓存命中、筛选后数量 —— 全部收进 ⚙「统计」
    if (isAbility) {
      const lines: string[] = [];
      if (abilityResp === null) {
        lines.push(abilityLoading ? "能力图谱加载中…" : "能力图谱未加载");
        return lines;
      }
      const snap = abilityResp.snapshot;
      const s = snap.stats;
      lines.push(`能力快照 ${snap.graph_version} · 生成于 ${snap.generated_at}`);
      lines.push(`共 ${s.node_count} 个能力 / ${s.edge_count} 条关联 · ${s.card_count} 张资料卡 / ${s.source_count} 个小节`);
      lines.push(`缓存：${abilityResp.cache === "hit" ? "本次复用（未重算）" : "本次重算"}`);
      lines.push(`筛选后显示 ${abilityPanelNodes.length} 个能力 / ${abilityPanelEdges.length} 条关联`);
      return lines;
    }
    const lines: string[] = [];
    lines.push(summarize(payload, loading, failure));
    if (layout !== null) {
      lines.push(`已绘制 ${layout.nodes.length} 个节点 / ${layout.edges.length} 条边`);
      if (layout.droppedNodes > 0) {
        lines.push(`另有 ${layout.droppedNodes} 个节点 / ${layout.droppedEdges} 条边超出渲染上限未绘制`);
      }
      const candidates = payload?.snapshot?.edge_candidates;
      if (candidates !== undefined && candidates > layout.edges.length) {
        lines.push(`候选 ${candidates} 条边（按强度截断后显示 ${layout.edges.length} 条）`);
      }
    } else if (drillCommunity !== null) {
      // 下钻空社区时 layout 为 null，但统计不能整段消失（W-36 产品要求）：显式给 0
      lines.push(`已绘制 ${visible.nodes.length} 个节点 / ${visible.edges.length} 条边`);
    }
    if (mode === "person" && visible.nodes.length > 200) {
      lines.push(`「人」已显示度数最高 200 人（共 ${visible.nodes.length} 人）`);
    }
    return lines;
  }, [
    isAbility,
    abilityResp,
    abilityLoading,
    abilityPanelNodes.length,
    abilityPanelEdges.length,
    payload,
    loading,
    failure,
    layout,
    mode,
    visible.nodes.length,
    visible.edges.length,
    drillCommunity,
  ]);

  return (
    <PanelShell
      testId="graph-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontFamily: "system-ui, sans-serif",
        color: PANEL_COLORS.text,
        background: PANEL_COLORS.surface,
      }}
    >
      <GraphPanelHeader />

      {selectedNode !== null && claimPort !== undefined && (
        <div style={{ padding: "0 16px 8px", flexShrink: 0 }}>
          <GraphClaimPanel
            claimPort={claimPort}
            nodeLabel={selectedNode.label}
            senderRef={
              selectedNode.kind === "direct"
                ? selectedNode.id
                : `wechat:${selectedNode.title ?? ""}`
            }
            onDone={() => {
              setSelectedNode(null);
              reload();
            }}
            onCancel={() => setSelectedNode(null)}
          />
        </div>
      )}

      <div style={BODY_STYLE}>
        {/* 人物视图三态通知 */}
        {!isAbility && failure !== null && failure.kind === "degraded" && (
          <DegradedNotice reason={failure.reason} onRetry={reload} testId="graph-panel-degraded" />
        )}
        {!isAbility && failure !== null && failure.kind === "session" && (
          <SessionExpiredNotice testId="graph-panel-session-expired" />
        )}
        {!isAbility && failure !== null && failure.kind === "error" && (
          <ErrorNotice message={failure.message} testId="graph-panel-error" />
        )}
        {!isAbility && loading && <LoadingNotice />}

        {/* 能力视图三态通知（独立于人物视图） */}
        {isAbility && abilityFailure !== null && abilityFailure.kind === "degraded" && (
          <DegradedNotice
            reason={abilityFailure.reason}
            onRetry={() => {
              setAbilityFailure(null);
              setAbilityResp(null);
            }}
            testId="ability-panel-degraded"
          />
        )}
        {isAbility && abilityFailure !== null && abilityFailure.kind === "session" && (
          <SessionExpiredNotice testId="ability-panel-session-expired" />
        )}
        {isAbility && abilityFailure !== null && abilityFailure.kind === "error" && (
          <ErrorNotice message={abilityFailure.message} testId="ability-panel-error" />
        )}
        {isAbility && abilityLoading && abilityResp === null && <LoadingNotice />}

        {/* 人物空态（能力视图不走这里） */}
        {!isAbility && !loading && failure === null && !hasGraph && (
          <GraphEmptyView
            kind={emptyKind ?? "no-nodes"}
            hint={payload?.hint}
            nodeCount={nodeCount}
            edgeCount={edgeCount}
            onRunMining={onRunMining}
            miningBusy={miningBusy}
            miningError={miningError}
            statusUnknown={miningStatus === null}
            onRetryStatus={reload}
            onRefresh={reload}
          />
        )}

        {/* 工具栏：人物有图时；能力视图**恒显示**（否则能力空态时切不回其它视图） */}
        {(hasGraph || isAbility) && (
          <GraphToolbar
            scale={viewport.scale}
            onZoomIn={() => zoomFromButton(BUTTON_ZOOM)}
            onZoomOut={() => zoomFromButton(1 / BUTTON_ZOOM)}
            onReset={resetViewport}
            mode={mode}
            onChangeMode={(next) => {
              setMode(next);
              setDrillCommunity(null);
            }}
            communityView={communityMode}
            communityDrill={drillCommunity}
            communityEmpty={communityEmpty}
            onCommunityBack={() => setDrillCommunity(null)}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((v) => !v)}
          />
        )}

        {/* 能力独立筛选栏（不塞进 ⚙） */}
        {isAbility && abilityResp !== null && (
          <AbilityFilterBar
            filters={abilityFilters}
            onChange={(patch) => setAbilityFilters((prev) => ({ ...prev, ...patch }))}
          />
        )}

        {/* 能力空态：快照 0 能力项 → 引导「去待整理」 */}
        {isAbility && abilityResp !== null && abilityResp.snapshot.nodes.length === 0 && (
          <AbilityEmpty {...(onGoInbox === undefined ? {} : { onGoInbox })} />
        )}
        {/* 能力视图：有数据但被筛到 0 条（区别于「还没蒸馏」） */}
        {isAbility &&
          abilityResp !== null &&
          abilityResp.snapshot.nodes.length > 0 &&
          abilityPanelNodes.length === 0 && (
            <div
              data-testid="ability-no-match"
              style={{ padding: "32px 16px", textAlign: "center", color: PANEL_COLORS.muted, flex: 1 }}
            >
              没有符合筛选条件的能力项，试试放宽筛选。
            </div>
          )}

        {hasGraph && (
          <div
            style={{
              position: "relative",
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <GraphCanvasArea
              containerRef={containerRef}
              canvasRef={canvasRef}
              layout={layout}
              canvasUnsupported={canvasUnsupported}
              hovering={hoveredId !== null}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerLeave}
              onClick={onClick}
              onDoubleClick={resetViewport}
              onContextMenu={onContextMenu}
              contextMenu={
                contextMenuNode !== null && contextMenu !== null
                  ? { node: contextMenuNode, position: { x: contextMenu.x, y: contextMenu.y } }
                  : null
              }
              contextMenuActions={contextMenuActions}
              legendColorByCommunity={isAbility ? false : colorByCommunity}
              legendCommunities={
                isAbility ? [] : communities
              }
              {...(canvasTitle === undefined ? {} : { canvasTitle })}
            />
            {isAbility && selectedAbility !== null && (
              <AbilityNodeDetail node={selectedAbility} onClose={() => setSelectedAbilityId(null)} />
            )}
            {settingsOpen && (
              <GraphSettingsPanel
                settings={settings}
                onChange={patchSettings}
                communities={
                  isAbility ? [] : communities
                }
                stats={statsLines}
                abilityMode={isAbility}
                onClose={() => setSettingsOpen(false)}
              />
            )}
          </div>
        )}
      </div>
    </PanelShell>
  );
}
