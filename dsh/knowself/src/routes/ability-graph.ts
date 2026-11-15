/**
 * 能力图谱只读路由（T04）：`GET /knowself-api/ability-graph`
 *
 *   GET /ability-graph
 *     → 200 + `AbilitySnapshot`（`fingerprint` / `stats` / `nodes` / `edges` 四者齐）
 *     → 200 + 空 nodes/edges（**0 张卡也合法**，fingerprint 照常计算）
 *     → 503 + `{ status:"degraded", reason, layer:"profile" }`（核心层 profileStore 缺失）
 *
 * ## 为什么「0 张卡」是 200 而不是 404 / 503
 * 新用户第一次打开能力面板时，`cards` 表就是空的（还没蒸馏过任何资料）。
 *   404 = 路径不存在（本端点存在）；
 *   503 = 数据层不可用（profileStore 没装配，属装配故障）；
 *   而「还没抽过卡」是**正常业务状态**——面板据此显示「先去导入/蒸馏资料」的引导，
 * 与 `routes/graph.ts` 的「暂无快照 → 200 + hint」同一口径（不猜、不冒充、不误导重试）。
 *
 * ## 缓存
 * 复用 `AbilitySnapshotCache`（T03）：指纹 = `sha1(cards.key|updated_at + sections.id|title|body)`。
 * 命中与重算的差别通过响应头 `X-Ability-Cache: hit|miss` 暴露 —— 真机验收靠它证明
 * 「第二次请求没有重算」，不用去数 CPU 时间。
 *
 * ## 只读
 * 纯 GET，**不接收** `x-knowself-write`（能力图是派生视图，没有任何写操作）。
 * 与 `routes/graph.ts` 一样：注册期不取 store，**每次请求惰性读取**，缺失才 503。
 */
import { abilitySnapshotCache, type AbilitySnapshotCache } from "../ability/cache.js";
import type { KnowselfServices } from "../services.js";
import { degradedBody, type DispatchResult, type RouteContext } from "./http.js";

/** 路径（去掉 `/knowself-api` 前缀后的形态，与其它路由模块一致）。 */
export const ABILITY_GRAPH_PATH = "/ability-graph";

/** 缓存响应头名（真机验收读取）。 */
export const ABILITY_CACHE_HEADER = "X-Ability-Cache";

/** 资料层未装配时的 503 文案（与 `graph.ts` 的 `personDegradedReason` 同一风格）。 */
export const ABILITY_PROFILE_DEGRADED_REASON =
  "资料层未就绪（profileStore 未装配）：能力图谱需要读取 cards / card_sections";

/** 路由可注入依赖（测试用：给独立 cache 以免全局单例串味）。 */
export interface AbilityGraphRouteDeps {
  /** 快照缓存；缺省用进程级单例。 */
  cache?: AbilitySnapshotCache;
}

/**
 * 判断该请求是否归本路由管。
 *
 * @param path 去掉前缀后的路径（如 `"/ability-graph"`）
 * @returns 是否匹配
 */
export function matchesAbilityGraphPath(path: string): boolean {
  return path === ABILITY_GRAPH_PATH || path === `${ABILITY_GRAPH_PATH}/`;
}

/**
 * 处理 `GET /ability-graph`。
 *
 * @param ctx 路由上下文（`services` 为装配后的领域服务）
 * @param deps 可注入依赖（缓存）
 * @returns `DispatchResult`；非本路由路径返回 `undefined`
 */
export function handleAbilityGraphRoute(
  ctx: RouteContext,
  deps: AbilityGraphRouteDeps = {},
): DispatchResult | undefined {
  if (!matchesAbilityGraphPath(ctx.path)) return undefined;

  // 只读：非 GET 不认领（交给别的模块 / 最终 404），与既有只读路由一致。
  if (ctx.method !== "GET") return undefined;

  const services: KnowselfServices = ctx.services;
  const profileStore = services.profileStore;
  if (profileStore === undefined) {
    // 核心层理论上必有（assembleServices 第 1 层），这里防御性降级而非 500：
    // 与 graph.ts 一致，让面板显示「数据层未就绪」而不是「服务器错误」。
    return degradedBody(ABILITY_PROFILE_DEGRADED_REASON, "profile");
  }

  const cache = deps.cache ?? abilitySnapshotCache;
  const { snapshot, cache: cacheState } = cache.resolve(profileStore);

  return {
    status: 200,
    body: snapshot,
    headers: {
      [ABILITY_CACHE_HEADER]: cacheState,
      // 派生视图、随资料变动，禁止中间层缓存（指纹变化靠下次请求发现）。
      "cache-control": "no-store",
    },
  };
}
