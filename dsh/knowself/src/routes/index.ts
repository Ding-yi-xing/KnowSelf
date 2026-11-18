/**
 * knowSelf REST 路由分发器（M3/T08 拆分产物）——**只管「路径 → 数据/错误」**。
 *
 * ## 为什么单独成模块
 * 拆分前所有端点都内联在 `src/web-bridge.ts` 的 `resource` 回调里，鉴权、路由、参数校验、
 * 降级混在一处，新增面板端点会持续放大这个回调。拆分后职责边界是：
 *   - `src/web-bridge.ts`：注册 prefix 路由 + **鉴权闸门**（`connection.requestRejection`
 *     必须是第一行）+ 把 `DispatchResult` 转 `Response` + 异常收敛（400/500 与日志）；
 *   - 本模块与 `routes/{persons,profile,journal,proposals,sources,graph}.ts`：纯函数式分发，
 *     **完全不认识鉴权**，也不产生 `Response`。
 *
 * ## 处理顺序（不可换，05 §13.4 / §13.8）
 *   **鉴权 → 路由(404) → 参数(400) → 降级(503) → 数据(200)**
 * 本模块负责后四步中的「路由 → 参数 → 降级 → 数据」：先认路径（不认领的模块返回
 * `undefined`，全部不认领 → 404），再在模块内先校验参数（400）后解析层（503）最后取数。
 * 鉴权在调用本模块**之前**已完成，因此未认证调用方永远看不到 404 的路径语义与 503 的 reason。
 *
 * ## 用法
 * ```ts
 * const result = await dispatch(new URL(request.url), services, request.method);
 * return json(result.body, result.status);
 * ```
 * `BadRequestError` 会从本模块抛出（参数校验失败），由 bridge 统一转 400——这样
 * 路由模块不必各自拼状态码，也不会把「参数错」误写成「降级」。
 */
import type { KnowselfServices } from "../services.js";
import {
  type DispatchResult,
  type RouteContext,
  type RouteHandler,
} from "./http.js";
import { handlePersonsRoute } from "./persons.js";
import { handleProfileRoute } from "./profile.js";
import { handleJournalRoute } from "./journal.js";
import { handleProposalsRoute } from "./proposals.js";
import { handleSourcesRoute } from "./sources.js";
import { handleGraphRoute } from "./graph.js";
import { handleMiningStatusRoute } from "./mining-status.js";
import { handlePersonClaimRoute } from "./person-claim.js";
import { handleAbilityGraphRoute } from "./ability-graph.js";
import { handleWechatAssistRoute } from "./wechat-assist.js";
import { handleGroupsRoute } from "./groups.js";

/** REST 端点统一前缀（真实 prefix 匹配：`pathname === prefix` 或 `startsWith(prefix+'/')`）。 */
export const KNOWSELF_API_BASE = "/knowself-api";

/** 前缀长度常量缓存（避免每次请求重复求长）。 */
const KNOWSELF_API_BASE_LENGTH = KNOWSELF_API_BASE.length;

/**
 * 路由表（有序）。**顺序不代表优先级**——各模块匹配的是互不重叠的路径；
 * 之所以用「依次尝试」而不是 map，是为了让路径解析（含 `/person/:id/timeline`
 * 这类带动态段的正则）留在各自模块里，新增面板只需在表尾追加一行。
 */
const ROUTE_HANDLERS: readonly RouteHandler[] = [
  handlePersonsRoute,
  handleProfileRoute,
  handleJournalRoute,
  handleProposalsRoute,
  handleSourcesRoute,
  // M3 波 3：图谱（表尾追加，既有路径匹配顺序零变更）。
  handleGraphRoute,
  // W-9 A4：挖掘/数据现状（只读，图谱空态判定用；表尾追加）。
  handleMiningStatusRoute,
  // W29 B1：认领（写通道专属，表尾追加；不带 /write 的直调仍 404）。
  handlePersonClaimRoute,
  // 0.5.0 T04：能力图谱（只读，表尾追加；既有路径匹配顺序零变更）。
  handleAbilityGraphRoute,
  handleWechatAssistRoute,
  // 2026-11-16：群聊单列（只读，表尾追加）。
  handleGroupsRoute,
];

/**
 * 分发一次请求。
 *
 * @param url 完整请求 URL（用其 `pathname` 去前缀、`searchParams` 取参数）
 * @param services 已装配的领域服务（人物层可能降级，核心层必有）
 * @param method HTTP 方法（默认 GET；非 GET 一律 404，与拆分前行为一致）
 * @returns `{ status, body }`：404 未知路径 / 400 参数错 / 503 层降级 / 200 数据
 * @throws BadRequestError 参数校验失败（由 bridge 转 400）
 * @throws Error 领域异常（由 bridge 转 500 并脱敏）
 */
export async function dispatch(
  url: URL,
  services: KnowselfServices,
  method = "GET",
  body?: unknown,
): Promise<DispatchResult> {
  // 去掉前缀后得到 '' / '/persons' / '/person/:id' / '/profile/core' / '/cards/:key' ...
  // W-1：写端点走 `/knowself-api/write/*`，这里剥掉 `/write` 段，使 routes/*.ts
  // 看到的 path 与逻辑路径一致（POST /sources 而非 /write/sources）。
  const rawPath = url.pathname.slice(KNOWSELF_API_BASE_LENGTH);
  const isWriteChannel = rawPath === "/write" || rawPath.startsWith("/write/");
  const path = isWriteChannel
    ? rawPath.slice("/write".length) // '/write/sources' → '/sources'；'/write' → ''
    : rawPath;
  // exactOptionalPropertyTypes：可选字段用条件展开，不显式赋 undefined。
  const ctx: RouteContext = {
    path,
    url,
    services,
    method,
    ...(body === undefined ? {} : { body }),
    ...(isWriteChannel ? { writeChannel: true } : {}),
  };

  for (const handler of ROUTE_HANDLERS) {
    const result = await handler(ctx);
    if (result !== undefined) return result;
  }

  // 404 仅表示「未知路径 / 非 GET」，与任何层的状态无关（§13.4）。
  return { status: 404, body: { error: "not_found" } };
}
