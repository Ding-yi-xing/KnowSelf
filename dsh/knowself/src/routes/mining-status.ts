/**
 * `GET /knowself-api/mining/status`（W-9 A4）——图谱空态判定的**唯一数据来源**。
 *
 * ## 为什么单独一个端点
 * 空态要分三种，而 `GraphPanelPayload` 里只有「图长什么样」：
 *   ① 无快照且**从未导入过聊天** → 该引导「去导入含他人的聊天记录」
 *   ② 有消息但**从未挖掘** → 该给一个「开始挖掘」按钮
 *   ③ 已挖掘但 0 边 → 该如实说「数据里没有第三方参与者」
 * 区分 ①② 需要「库里有几条消息 / 有没有快照」，这两项与图的形状无关。
 * 把它们塞进 `GraphPanelPayload` 会让那个契约变成「什么都装」，
 * 所以按主理人裁定单开一个只读端点；`graph` 保持纯粹。
 *
 * ## 契约（纯加法，不影响既有调用方）
 * ```json
 * { "has_snapshot": true, "snapshot_id": "…", "node_count": 1, "edge_count": 0,
 *   "chat_message_count": 69, "chat_conversation_count": 6, "person_count": 1,
 *   "unattributed_message_count": 0 }
 * ```
 * `unattributed_message_count` 是 W-9 收口新增的**全库**口径（`sender_person_id IS NULL`
 * 且 `role <> 'system'`），用于「修 self alias 前 20 → 修后 0」这类可测的前后对比；
 * 它不影响任何既有字段语义，老调用方忽略即可。
 *
 * 人物层降级时回 `503 { status:"degraded", layer:"person", reason }`（与其它面板同语义）。
 */
import { getGraphSnapshot } from "@knowself/mining";
import type { KnowselfServices } from "../services.js";
import { degradedBody, type DispatchResult, type RouteContext } from "./http.js";

/**
 * 处理 `GET /mining/status`。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 前缀）
 * @returns 状态体；非本路径 / 非 GET → `undefined`（交由 404）
 */
export function handleMiningStatusRoute(ctx: RouteContext): DispatchResult | undefined {
  const { path, method, services } = ctx;
  if (path !== "/mining/status" || method !== "GET") return undefined;

  const personStore = services.personStore;
  if (personStore === undefined) {
    return degradedBody("关系图谱需要人物层，当前未就绪", "person");
  }

  // 快照：null = 从未挖掘过（或该 scope 无快照）
  const snapshotResult = getGraphSnapshot(personStore);
  const snapshot = snapshotResult?.snapshot ?? null;

  return {
    status: 200,
    body: {
      has_snapshot: snapshot !== null,
      snapshot_id: snapshotResult === null ? null : readSnapshotId(snapshotResult),
      node_count: snapshot === null ? 0 : snapshot.nodes.length,
      edge_count: snapshot === null ? 0 : snapshot.edges.length,
      chat_message_count: personStore.messages.count(),
      chat_conversation_count: personStore.conversations.list().length,
      person_count: personStore.listPersons().length,
      // 全库口径：已落库但归属不到人的消息（排除 system）。
      // 这是「self alias 修好了没」最直接的可测证据（修前非 0 → 修后 0）。
      unattributed_message_count: personStore.messages.countUnattributed(),
    },
  };
}

/**
 * 取快照 id。
 *
 * `getGraphSnapshot` 的返回体只保证 `{ snapshot, warnings }`，快照 id 由
 * `graph_version + generated_at` 之外的元信息承载；这里做防御式读取
 * （拿不到就返回 null，绝不因为字段缺失让整个状态端点 500）。
 *
 * @param result mining 读层返回
 * @returns 快照 id 或 null
 */
function readSnapshotId(result: { snapshot: unknown }): string | null {
  const raw = result.snapshot as { snapshot_id?: unknown; id?: unknown };
  if (typeof raw.snapshot_id === "string") return raw.snapshot_id;
  if (typeof raw.id === "string") return raw.id;
  return null;
}
