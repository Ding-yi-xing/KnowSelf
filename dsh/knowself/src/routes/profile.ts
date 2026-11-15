/**
 * 画像（L1 core / L2 cards）只读路由（M3/T08 新增）。
 *
 *   GET /profile/core   → 200 + CoreProfileStored（display_name / locale / section_tags / body / updated_at）
 *   GET /cards?layer=   → 200 + CardSummary[]（`layer` 省略或 `L2` = 全部卡片）
 *                        400 + `{error:"unsupported_layer", hint:"L1 由 /profile/core 提供"}`（`layer=L1`）
 *   GET /cards/:key     → 200 + CardWithSections（不存在 → 404 `{error:"not_found"}`）
 *
 * **降级语义**：本模块依赖的是**核心层**（`profileStore` 在 `assembleServices` 第 1 层，
 * 装配失败即整体失败），因此这里**不造 503**——核心层真缺失只会是装配 bug 或领域异常，
 * 由 bridge 统一转 500（05 §14「不得返回空数组冒充没有数据」）。人物层那种
 * 「可缺层」才用 503，见 `routes/persons.ts`。
 *
 * ## `layer` 语义（M3 波 2 修正技术债）
 * 领域库 `cards.list()` 返回的 `CardSummary` **没有** layer 字段——`profile.sqlite` 里
 * L1 是 `core_profile` 单行、L2 才是 `cards` 表。旧实现把 `layer=L1` 解释成
 * 「`section_tags` 含 L1 标记的卡片」，实际上常规库里没有这种卡片，于是恒返回 `[]`，
 * 既像「没有数据」又像「参数无效」，语义含糊（客户端无法区分）。
 * 现在改为**显式拒绝**：
 *   - `layer=L1` → **400** `{error:"unsupported_layer", hint:"L1 由 /profile/core 提供"}`；
 *   - `layer=L2` 或省略 → 全部卡片（两者等价，语义不变）；
 *   - 其它取值（如 `L9`）→ **400** `{error:<message>}`（沿用既有 `BadRequestError` 风格）。
 * 这样「L1 在哪里」有唯一答案（`/profile/core`），客户端不会把「层不存在」误读成「空画像」。
 */
import type { CardSummary } from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { KnowselfServices } from "../services.js";
import {
  BadRequestError,
  decodePathSegment,
  type DispatchResult,
  type RouteContext,
} from "./http.js";

/** 卡片层标识（query `layer` 的合法取值）。 */
export type CardLayer = "L1" | "L2";

/**
 * 取核心层（必有）。
 * @param services 已装配的领域服务
 * @returns profileStore
 * @throws Error 核心层缺失（属装配异常，由 bridge 转 500，不是 503）
 */
function requireProfileStore(services: KnowselfServices): ProfileStore {
  const store = services.profileStore;
  if (store === undefined) {
    throw new Error("核心层 profileStore 未装配（assembleServices 第 1 层应保证其必有）");
  }
  return store;
}

/**
 * 解析 `layer` query 参数。
 * @param raw 原始参数值（未提供为 null）
 * @returns 合法层标识；未提供 → undefined
 * @throws BadRequestError 非法取值 → 400
 */
function parseCardLayer(raw: string | null): CardLayer | undefined {
  if (raw === null) return undefined;
  const normalized = raw.trim().toUpperCase();
  if (normalized === "L1") return "L1";
  if (normalized === "L2") return "L2";
  throw new BadRequestError(`参数 layer 非法：${raw}（只接受 L1 / L2）`);
}

/** `layer=L1` 的固定 400 体：L1 不是卡片层，由 `/profile/core` 提供。 */
const UNSUPPORTED_LAYER: DispatchResult = {
  status: 400,
  body: { error: "unsupported_layer", hint: "L1 由 /profile/core 提供" },
};

/**
 * 处理画像三个只读端点。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 前缀）
 * @returns 命中的 `{ status, body }`；非画像路径 / 非 GET → `undefined`（交由 404）
 */
export function handleProfileRoute(ctx: RouteContext): DispatchResult | undefined {
  const { path, url, services, method } = ctx;
  const isGet = method === "GET";

  if (path === "/profile/core" && isGet) {
    const store = requireProfileStore(services);
    return { status: 200, body: store.core.get() };
  }

  if (path === "/cards" && isGet) {
    // 参数校验（400）先于取数。
    const layer = parseCardLayer(url.searchParams.get("layer"));
    // L1 不落在 cards 表：显式 400，而不是返回空数组冒充「没有数据」。
    if (layer === "L1") return UNSUPPORTED_LAYER;
    const store = requireProfileStore(services);
    // 省略与 L2 等价：全部卡片（`cards` 表即 L2 层）。
    const cards: CardSummary[] = store.cards.list();
    return { status: 200, body: cards };
  }

  const mCard = /^\/cards\/([^/]+)$/.exec(path);
  if (mCard !== null && isGet) {
    const key = decodePathSegment(mCard[1], "卡片 key");
    const store = requireProfileStore(services);
    // 用摘要列表判存在，避免把「领域异常」与「未找到」混为一谈：
    // 只有摘要里确实没有这个 key 才是 404；其余异常一律上抛 → 500。
    const exists = store.cards.list().some((card) => card.key === key);
    if (!exists) return { status: 404, body: { error: "not_found" } };
    return { status: 200, body: store.cards.get(key) };
  }

  return undefined;
}
