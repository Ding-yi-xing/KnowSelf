/**
 * 知识图谱面板的**只读数据端口**（M3 波 3）。
 *
 * ## 为什么单独一个端口
 * 图谱数据来自 `@knowself/mining` 的 `getGraphSnapshot()`，它读的是**人物层**
 * （`personStore.metrics.listGraphSnapshots`）——与画像 / 日志（核心层，必有）
 * 的降级语义不同：人物层可缺 → 宿主回 `503 { layer:"person" }`。
 * 因此端口独立，错误语义仍与 `profile-port.ts` 完全一致（复用同一组错误类）：
 *   - `401` → {@link SessionExpiredError}：面板显示「会话已失效，请重新打开 dsh web」；
 *   - `503` → {@link DegradedError}：面板显示「数据层未就绪：<reason>」+ 重试按钮；
 *   - 其它非 2xx → 普通 `Error`（`GET <url> → <status>`）：通用错误态。
 *
 * ## 响应契约（宿主 `src/routes/graph.ts` 逐字对齐）
 * ```json
 * {
 *   "snapshot": { "generated_at": "...", "graph_version": "...", "node_count": 12,
 *                 "edge_count": 18, "community_count": 2, "modularity": 0.31 },
 *   "nodes": [{ "id": "p1", "label": "张三", "kind": "person", "size": 0.42,
 *               "degree": 3, "isolated": false, "community_key": "c:ab",
 *               "relation_type": "friend" }],
 *   "edges": [{ "id": "co_presence:a|b", "source": "a", "target": "b",
 *               "kind": "co_presence", "strength": 0.5, "directed": false }],
 *   "warnings": []
 * }
 * ```
 * **空快照（该 scope 尚无任何挖掘快照）是 200 而不是 404/503**：
 * `{ "snapshot": null, "nodes": [], "edges": [], "hint": "暂无图谱快照，…" }`
 * ——「还没挖过」是正常状态，面板据此显示 hint 而不是错误或空画布（不猜、不冒充）。
 *
 * 只依赖标准 Fetch API，零 npm 依赖；节点 / 边类型复用 `@knowself/contracts` 的
 * 字面量联合（`import type` 编译期擦除，浏览器 bundle 不引入领域库运行时）。
 */
import type { GraphEdgeKind, GraphNodeKind } from "@knowself/contracts";
import { DegradedError, SessionExpiredError, readDegradedPayload } from "./profile-port.js";
import { toQueryString } from "./query-string.js";

/**
 * 空快照的固定提示文案（宿主 `routes/graph.ts` 与本文件共用同一字符串，
 * 避免「后端说还没挖、前端说读取失败」的语义漂移）。
 */
export const GRAPH_EMPTY_HINT = "暂无图谱快照，需要先在对话里让助手做数据挖掘";

/**
 * 画布节点类型 = 领域类型 + 前端聚合出来的「社区超节点」+ 能力视图的「能力节点」。
 *
 * `community` **只存在于前端**（聚合视图），不写回快照、也不落库 —— 快照结构一个字没改。
 * `ability` 来自独立的能力快照（0.5.0），投影成画布节点后复用布局 / 配色 / canvas。
 */
export type GraphPanelNodeKind = GraphNodeKind | "community" | "ability";

/** 图谱节点的**画布投影**（只保留渲染需要的字段，不含 `attrs` 等审计字段）。 */
export interface GraphPanelNode {
  /** 节点主键（person_id / conversation_id / `topic:<sha1>`）。 */
  id: string;
  /** 展示名（宿主保证非空，画布上过长会截断）。 */
  label: string;
  /** 节点类型：人物 / 群会话 / 话题 / 社区超节点（前端聚合）。 */
  kind: GraphPanelNodeKind;
  /** `[0,1]` 归一化半径（由 mining 输出，前端不重算）。 */
  size: number;
  /** 度数（诱导子图重算后的值）。 */
  degree: number;
  /** 无可见边。 */
  isolated: boolean;
  /** 社区键；孤立节点为 `null`。 */
  community_key: string | null;
  /** person 节点与「我」的关系类型；其它为 `null`。 */
  relation_type: string | null;
  /** W29 A3：未识别 person 节点的完整 wxid（条件展开，未命中时字段不出现）。 */
  title?: string;
}

/** 图谱边的**画布投影**。 */
export interface GraphPanelEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** `[0,1]` 视觉强度（决定线条透明度 / 粗细）。 */
  strength: number;
  /** mention / my_group 为 `true`。 */
  directed: boolean;
}

/** 快照元信息（面板头部展示；不含 nodes / edges，避免与顶层字段重复传输）。 */
export interface GraphPanelSnapshotMeta {
  graph_version: string;
  generated_at: string;
  node_count: number;
  edge_count: number;
  community_count: number;
  modularity: number;
  /**
   * 裁剪**前**的候选边数（批次 A1）。缺省 = 未裁剪。
   * `edge_count` 顶到上限时靠它告诉用户"少显示了多少"。
   */
  edge_candidates?: number;
}

/** `GET /knowself-api/graph` 的响应体（`snapshot === null` 即「还没有快照」）。 */
export interface GraphPanelPayload {
  /** 元信息；`null` 表示该 scope 尚无挖掘快照（配 `hint` 使用）。 */
  snapshot: GraphPanelSnapshotMeta | null;
  /** 画布节点（`snapshot === null` 时为空数组）。 */
  nodes: GraphPanelNode[];
  /** 画布边（两端节点必定都在 `nodes` 里，`snapshot === null` 时为空数组）。 */
  edges: GraphPanelEdge[];
  /** 空快照时的可读提示（非空快照时缺省）。 */
  hint?: string;
  /** 取数告警（mining 目前恒为空数组；保留字段以便将来扩展）。 */
  warnings?: string[];
}

/**
 * 图谱查询（与工具 `knowself_network` 的同名参数对齐）。
 * 两个字段都可省略：省略即「不按该维度过滤」。
 */
export interface KnowselfGraphQuery {
  /** 按边的 `kind` 过滤（多值 AND 于同一条边 = 命中任一即可，由宿主处理）。 */
  edge_kinds?: readonly GraphEdgeKind[];
  /** 按节点 `size_raw` 阈值过滤（非负整数）。 */
  min_interaction?: number;
}

/** 图谱只读数据端口。 */
export interface KnowselfGraphPort {
  /** 读取最新共现图谱快照；无快照时返回 `snapshot: null`（不是错误）。 */
  getGraph(query?: KnowselfGraphQuery): Promise<GraphPanelPayload>;
}

/**
 * 构造 REST 图谱端口。
 * @param baseUrl REST 前缀，默认同 origin 相对路径 `/knowself-api`
 * @returns 只读的 {@link KnowselfGraphPort}
 */
export function createRestGraphPort(baseUrl = "/knowself-api"): KnowselfGraphPort {
  return {
    getGraph: async (query?: KnowselfGraphQuery): Promise<GraphPanelPayload> => {
      const url = `${baseUrl}/graph${toQueryString([
        ["edge_kinds", query?.edge_kinds?.join(",")],
        ["min_interaction", query?.min_interaction === undefined ? undefined : String(query.min_interaction)],
      ])}`;

      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 401) {
        throw new SessionExpiredError();
      }
      if (res.status === 503) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const degraded = readDegradedPayload(body);
        if (degraded !== undefined) {
          throw new DegradedError(degraded.reason, degraded.layer);
        }
      }
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      return (await res.json()) as GraphPanelPayload;
    },
  };
}
