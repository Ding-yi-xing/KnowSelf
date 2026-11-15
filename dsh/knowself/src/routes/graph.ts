/**
 * 知识图谱只读路由（M3 波 3 新增）。
 *
 *   GET /graph[?edge_kinds=a,b&min_interaction=N]
 *     → 200 + `{ snapshot, nodes, edges, warnings }`（有快照）
 *     → 200 + `{ snapshot:null, nodes:[], edges:[], hint }`（**尚无快照**，不是 404 / 503）
 *     → 400 + `{ error: "<原因>" }`（min_interaction 非非负整数 / edge_kinds 非法）
 *     → 503 + `{ status:"degraded", reason, layer:"person" }`（人物层缺失）
 *
 * ## 数据源
 * `@knowself/mining` 的 `getGraphSnapshot(store, query)`（`packages/mining/src/read.ts:99`），
 * 与 agent 工具 `knowself_network`（`src/tools.ts:296`）**同一个函数、同一组参数名**，
 * 保证「面板看到的图」与「助手看到的图」口径一致（不新增第二套过滤逻辑）。
 * 该函数读的是人物层 `personStore.metrics.listGraphSnapshots()`，因此本端点依赖人物层。
 *
 * ## 为什么「无快照」是 200 而不是 404 / 503
 *   404 = 路径不存在（本端点存在）；
 *   503 = 人物层降级（数据层不可用）；
 *   而「还没做过数据挖掘」是**正常业务状态**——用户看到的是可执行的指引
 *   （去对话里让助手挖掘），不是错误。把它写成 404 会让客户端误以为「界面不存在」，
 *   写成 503 会让面板显示「数据层未就绪 + 重试」（重试永远不会成功，属于误导）。
 *
 * ## 参数校验（先校验、后解析人物层——参数错必须是 400 而不是 503）
 *   - `edge_kinds`：逗号分隔；每个值必须是 `GraphEdgeKindSchema` 的六个字面量之一，
 *     否则 400（不静默丢参数、不猜）。空串 / 全空白 → 400。
 *   - `min_interaction`：复用 `parseNonNegativeInt`（非负整数；空串 / 小数 / 负数 → 400）。
 *
 * ## 降级语义
 * 注册期不取 `personStore`，**每次请求惰性读取**；缺失时复用 `personDegradedReason`
 * 给出与其它人物层端点**完全一致**的 503 文案（`routes/persons.ts`）。
 * 领域异常（如快照 `payload_json` 非法）上抛，由 bridge 转 500（脱敏）。
 *
 * ## 只读
 * 无写端点（快照由挖掘流水线产出，不在 HTTP 层触发）。
 */
import type { GraphEdgeKind } from "@knowself/contracts";
import { getGraphSnapshot, type GetGraphSnapshotQuery } from "@knowself/mining";
import type {
  GraphPanelEdge,
  GraphPanelNode,
  GraphPanelPayload,
} from "../client/graph-port.js";
import { GRAPH_EMPTY_HINT } from "../client/graph-port.js";
import type { KnowselfServices } from "../services.js";
import {
  BadRequestError,
  degradedBody,
  parseNonNegativeInt,
  type DispatchResult,
  type RouteContext,
} from "./http.js";
import { personDegradedReason } from "./persons.js";

/** `edge_kinds` 的合法取值（与 `GraphEdgeKindSchema` 逐字一致，6 值，不得自创）。 */
const EDGE_KINDS: readonly GraphEdgeKind[] = [
  "co_presence",
  "direct_reply",
  "mention",
  "membership",
  "my_group",
  "topic_affinity",
];

/**
 * 类型守卫：把 query 里的字符串收窄成领域库的 `GraphEdgeKind`。
 * @param value 原始（已 trim 的）query 值
 * @returns 是否为合法边类型
 */
function isGraphEdgeKind(value: string): value is GraphEdgeKind {
  return EDGE_KINDS.some((kind) => kind === value);
}

/**
 * 解析 `edge_kinds`（逗号分隔多值）。
 * @param raw 原始 query 值（`null` = 未提供）
 * @returns 合法边类型数组；未提供 → `undefined`
 * @throws BadRequestError 空串 / 含非法取值
 */
function parseEdgeKinds(raw: string | null): GraphEdgeKind[] | undefined {
  if (raw === null) return undefined;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) throw new BadRequestError("参数 edge_kinds 不能为空");
  const kinds: GraphEdgeKind[] = [];
  for (const part of parts) {
    if (!isGraphEdgeKind(part)) {
      throw new BadRequestError(`参数 edge_kinds 非法：${part}`);
    }
    kinds.push(part);
  }
  return kinds;
}

/**
 * 从 URLSearchParams 构造 `GetGraphSnapshotQuery`（显式赋值以配合 exactOptionalPropertyTypes）。
 * @param q 请求 query
 * @returns mining 读层的查询对象（字段名与工具 `knowself_network` 同名）
 * @throws BadRequestError 参数非法（由 bridge 转 400）
 */
function buildGraphQuery(q: URLSearchParams): GetGraphSnapshotQuery {
  const edgeKinds = parseEdgeKinds(q.get("edge_kinds"));
  const minInteraction = parseNonNegativeInt(q.get("min_interaction"), "min_interaction");

  // `GetGraphSnapshotQuery` 的字段是 `readonly`，因此用条件展开一次构造，再赋值不合法。
  return {
    ...(edgeKinds === undefined ? {} : { edge_kinds: edgeKinds }),
    ...(minInteraction === undefined ? {} : { min_interaction: minInteraction }),
  };
}

/**
 * 把 mining 的节点投影成画布 DTO（只保留渲染字段，丢弃 `attrs` 等审计字段）。
 * @param node 领域库节点
 * @returns 画布节点
 */
function toPanelNode(node: {
  id: string;
  label: string;
  kind: GraphPanelNode["kind"];
  size: number;
  degree: number;
  isolated: boolean;
  community_key: string | null;
  relation_type: string | null;
}): GraphPanelNode {
  // W29 A3：label 来自 persons.display_name；display_name 本身是 wxid_xxx 的 person 节点
  // 即「未识别」，投影层改写标签并条件展开完整 wxid 到 title（不改数据库、不改 id/ref_id）。
  const unidentified = node.kind === "person" && /^wxid_/.test(node.label);
  return {
    id: node.id,
    label: unidentified ? `未识别·${node.label.slice(-4)}` : node.label,
    kind: node.kind,
    size: node.size,
    degree: node.degree,
    isolated: node.isolated,
    community_key: node.community_key,
    relation_type: node.relation_type,
    ...(unidentified ? { title: node.label } : {}),
  };
}

/**
 * W29 真机③：direct 节点的「认领覆盖」。
 *
 * claim 写入的 alias 恰好等于 `wechat:<uid>` 里的 uid，所以用 aliases.findByUid 反查
 * person_id → persons.display_name；查到就覆盖 label 为真名，查不到 / 人物层降级
 * 时保持原 label、不报错。只碰 alias 表 + persons 表，与 chat_messages.sender_id 无关。
 */
function directLabelOf(store: NonNullable<KnowselfServices["personStore"]>, nodeId: string): string | undefined {
  const uid = nodeId.slice(nodeId.indexOf(":") + 1);
  if (uid === "") return undefined;
  const alias = store.aliases.findByUid("wechat", uid);
  if (alias === null) return undefined;
  const displayName = store.getPerson(alias.person_id)?.display_name?.trim() ?? "";
  return displayName === "" ? undefined : displayName;
}

/**
 * 把 mining 的边投影成画布 DTO。
 * @param edge 领域库边
 * @returns 画布边
 */
function toPanelEdge(edge: {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  strength: number;
  directed: boolean;
}): GraphPanelEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    strength: edge.strength,
    directed: edge.directed,
  };
}

/** 空快照响应体（`snapshot:null` + 可执行指引，语义见模块头注）。 */
const EMPTY_GRAPH_PAYLOAD: GraphPanelPayload = {
  snapshot: null,
  nodes: [],
  edges: [],
  hint: GRAPH_EMPTY_HINT,
};

/**
 * 处理图谱只读端点。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 前缀）
 * @returns 命中的 `{ status, body }`；非 `/graph` 路径 / 非 GET → `undefined`（交由 404）
 * @throws BadRequestError 参数非法（400）
 */
export function handleGraphRoute(ctx: RouteContext): DispatchResult | undefined {
  const { path, url, services, method } = ctx;

  if (path !== "/graph" || method !== "GET") return undefined;

  // ① 参数校验（400）先于 ② 人物层解析（503）——参数错不得被误报成降级。
  const query = buildGraphQuery(url.searchParams);

  // ② 人物层惰性解析：缺失 → 与 /persons 完全一致的 503 文案。
  const store = services.personStore;
  if (store === undefined) {
    return degradedBody(personDegradedReason(services), "person");
  }

  // ③ 取数：无快照 → 200 + hint（不是错误，见模块头注）；有快照 → 200 + 投影。
  const result = getGraphSnapshot(store, query);
  if (result === null) {
    return { status: 200, body: EMPTY_GRAPH_PAYLOAD };
  }

  const payload: GraphPanelPayload = {
    snapshot: {
      graph_version: result.snapshot.graph_version,
      generated_at: result.snapshot.generated_at,
      node_count: result.snapshot.stats.node_count,
      edge_count: result.snapshot.stats.edge_count,
      community_count: result.snapshot.stats.community_count,
      modularity: result.snapshot.stats.modularity,
      ...(result.snapshot.stats.edge_candidates === undefined
        ? {}
        : { edge_candidates: result.snapshot.stats.edge_candidates }),
    },
    nodes: result.snapshot.nodes.map((node) => {
      const projected = toPanelNode(node);
      if (projected.kind !== "direct") return projected;
      const name = directLabelOf(store, projected.id);
      return name === undefined ? projected : { ...projected, label: name };
    }),
    edges: result.snapshot.edges.map(toPanelEdge),
    warnings: [...result.warnings],
  };

  return { status: 200, body: payload };
}
