/**
 * 待整理（inbox）只读路由（M3 波 2 新增）。
 *
 *   GET /proposals?status=pending|processing|accepted|edited|rejected
 *     → 200 + IngestionProposal[]（**缺省 status=pending**，即「待整理」收件箱）
 *     → 400 + `{ error: "bad_request" }`（status 不在上述字面量内）
 *
 * ## 数据源与字段
 * 唯一数据源是核心层 `profileStore.proposals.listByStatus(status, limit)`（领域库
 * `packages/profile-store/src/repository/proposals.ts:89`），签名与返回类型只认实际实现：
 *   - 参数 `status: ProposalStatus | "all"`（缺省 `"pending"`）、`limit = 100`；
 *   - 返回 `IngestionProposal[]`（`id / source_id / target / proposed_body / reasoning /
 *     source_excerpts / produced_by_provider / status / user_edited_body / created_at /
 *     decided_at`），SQL 已 `ORDER BY created_at DESC`。
 * 因此本模块**原样返回领域库对象**：不增字段、不改名、不做二级投影（投影会与现实字段漂移）。
 *
 * ## 为什么 400 用固定体 `{error:"bad_request"}`
 * 参数错误是**协议面**信息，用稳定机器可读码（客户端可按码分支），而不必解析自然语言。
 * 与既有路由（`BadRequestError` → `{error: <message>}`）风格并存：新模块内部自带更明确的
 * 机器码，不改动既有端点的响应体（零回退）。
 *
 * ## 降级语义
 * `proposals` 属**核心层**（`assembleServices` 第 1 层，必有）。核心层缺失只会是装配
 * 异常 → 上抛由 bridge 转 500（脱敏），**不造 503**（05 §13.4 / §14）。领域异常同样上抛。
 *
 * ## 只读
 * 没有 POST / PATCH / DELETE：接受、拒绝、编辑一律由 agent 工具承担（客户端面板无按钮）。
 */
import type { ProposalStatus } from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { KnowselfServices } from "../services.js";
import type { DispatchResult, RouteContext } from "./http.js";

/** `status` query 的合法取值（与领域库 `ProposalStatusSchema` 逐字一致）。 */
const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "pending",
  "processing",
  "accepted",
  "edited",
  "rejected",
];

/** 「待整理」缺省状态：用户没指定时看的就是待审提案。 */
const DEFAULT_STATUS: ProposalStatus = "pending";

/** 参数错误的固定响应体（机器可读，不含内部细节）。 */
const BAD_REQUEST: DispatchResult = { status: 400, body: { error: "bad_request" } };

/**
 * 类型守卫：把字符串收窄成领域库的 `ProposalStatus`。
 * @param value 原始 query 值
 * @returns 是否为合法 proposal 状态
 */
function isProposalStatus(value: string): value is ProposalStatus {
  return PROPOSAL_STATUSES.some((status) => status === value);
}

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
 * 处理待整理（inbox）只读端点。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 前缀）
 * @returns 命中的 `{ status, body }`；非 `/proposals` 路径 / 非 GET → `undefined`（交由 404）
 */
export function handleProposalsRoute(ctx: RouteContext): DispatchResult | undefined {
  const { path, url, services, method } = ctx;
  const isGet = method === "GET";

  if (path !== "/proposals" || !isGet) return undefined;

  // ① 参数校验（400）先于取数：非法 status 不得被当作「空收件箱」。
  const raw = url.searchParams.get("status");
  let status: ProposalStatus = DEFAULT_STATUS;
  if (raw !== null) {
    if (!isProposalStatus(raw)) return BAD_REQUEST;
    status = raw;
  }

  // ② 取数（核心层必有；异常上抛 → bridge 转 500）。
  const store = requireProfileStore(services);
  return { status: 200, body: store.proposals.listByStatus(status) };
}
