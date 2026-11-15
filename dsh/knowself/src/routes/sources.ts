/**
 * 资料（sources）路由（M3 波 2 只读 + W-1 写端点）。
 *
 *   GET /sources?limit=&offset=&status=
 *     → 200 + SourceStored[]（按 `created_at DESC`，分页由 limit/offset 控制）
 *     → 400 + `{ error: "bad_request" }`（limit/offset 非非负整数；status 非法）
 *   POST /sources             （W-1，仅 `/knowself-api/write/*` handler 型通道可达）
 *     → 201 + `{ source: SourceStored, duplicate: false }`；重复 → 200 + `duplicate:true`
 *     → 400 参数错 / 503 摄入层降级
 *   POST /sources/:id/distill  （W-1）
 *     → 200 + `{ source_id, proposal_count }`；未知 id → 404 / 降级 → 503
 *
 * ## 数据源与字段
 * 唯一数据源是核心层 `profileStore.sources.list(query)`（领域库
 * `packages/profile-store/src/repository/sources.ts:54`），返回
 * `ListSourcesResponse = { items: SourceStored[]; total: number }`。
 * 本端点按波次规格**只返回数组**（`items`），因此 `total` 不出现在响应体里；
 * 需要总数时客户端可读 `limit`/`offset` 自行翻页（当前面板只取首页 200 条）。
 *
 * `SourceStored` 的真实字段（`packages/contracts/src/source.ts:136`）：
 *   `id / kind / original_name / mime_type / file_path / url / extracted_text / truncated /
 *    char_count / user_note / user_tags / status / metadata / created_at /
 *    last_ingested_at / last_error`
 * ——其中**没有**「条目数 / 卡片数」这类聚合列，故本端点不做任何臆造字段。
 *
 * ## 参数校验
 *   - `limit` / `offset`：复用 `parseNonNegativeInt`（非负整数；空串/小数/负数 → 400）。
 *     领域库契约 `ListSourcesQuerySchema` 的缺省值是 `limit=50 / offset=0`，这里保持一致。
 *   - `status`：只接受 `SourceStatusSchema` 的六个字面量，其余 → 400（不静默退化为「全部」）。
 *
 * ## 降级语义
 * `sources` 属**核心层**（必有）→ 不造 503；领域异常上抛由 bridge 转 500（脱敏）。
 *
 * ## 读写分工
 * W-1 起「添加资料 / 重新蒸馏」由本模块的两条 POST 承担，业务实现在
 * `sources-write.ts`（单独成文件以守住 ≤350 行、并让只读 GET 逐字不变）。
 * 但这两条 POST **只能**经 `/knowself-api/write/*` 的 handler 型通道到达：
 * 官方 resource 型对非 GET 直接 405（真机实测，见 `ISS-004`）。
 * 直接打 `POST /knowself-api/sources` 不会进 dispatch，仍由宿主 405 —— 这是
 * 宿主行为，不是本模块返回 404；测试桩直调 `resource` 时才是 404。
 */
import type { ListSourcesQuery, SourceStatus } from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { KnowselfServices } from "../services.js";
import { createSource, deleteSource, renameSource, runDistill } from "./sources-write.js";
import { acceptOneProposal, rejectOneProposal } from "./proposals-single.js";
import { importChat, runMining } from "./chat-import.js";
import { acceptProposalsBatch } from "./proposals-batch.js";
import {
  BadRequestError,
  decodePathSegment,
  parseNonNegativeInt,
  type DispatchResult,
  type RouteContext,
} from "./http.js";

/** `status` query 的合法取值（与领域库 `SourceStatusSchema` 逐字一致）。 */
const SOURCE_STATUSES: readonly SourceStatus[] = [
  "raw",
  "distilling",
  "pending_review",
  "completed",
  "rejected",
  "distill_failed",
];

/** 领域库缺省分页（`ListSourcesQuerySchema` 的 default，保持一致以免行为漂移）。 */
const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;

/** 参数错误的固定响应体（机器可读，不含内部细节）。 */
const BAD_REQUEST: DispatchResult = { status: 400, body: { error: "bad_request" } };

/**
 * 类型守卫：把字符串收窄成领域库的 `SourceStatus`。
 * @param value 原始 query 值
 * @returns 是否为合法资料状态
 */
function isSourceStatus(value: string): value is SourceStatus {
  return SOURCE_STATUSES.some((status) => status === value);
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
 * 处理资料只读端点。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 前缀）
 * @returns 命中的 `{ status, body }`；非 `/sources` 路径 / 非 GET → `undefined`（交由 404）
 */
export async function handleSourcesRoute(
  ctx: RouteContext,
): Promise<DispatchResult | undefined> {
  const { path, url, services, method, body, writeChannel } = ctx;

  // W-1 写端点：只在 handler 型写通道上认领，测试桩直调 POST /sources 仍落到
  // 下方「非 GET → undefined → 404」，既有断言零回退。
  if (writeChannel === true && method === "POST") {
    if (path === "/sources") return createSource(services, body);

    // W-9：聊天记录导入（复用 chat-ingest）+ 只跑挖掘
    if (path === "/chat-import") return importChat(services, body);
    if (path === "/mining-run") return runMining(services);
    // W-9：批量采纳本批 pending（导入默认不自动采纳，没有它功能不可用）
    if (path === "/proposals-accept-batch") return acceptProposalsBatch(services, body);

    const distill = /^\/sources\/([^/]+)\/distill$/.exec(path);
    if (distill !== null) {
      const id = decodePathSegment(distill[1], "资料 id");
      // W-6/E：body 里可带 { force: true } 强制重蒸；缺省幂等
      return runDistill(services, id, body);
    }
    // ── W-3 单条提案决策 ──
    const acceptOne = /^\/proposal\/([^/]+)\/accept$/.exec(path);
    if (acceptOne !== null) {
      const id = decodePathSegment(acceptOne[1], "提案 id");
      return await acceptOneProposal(services, id, body);
    }
    const rejectOne = /^\/proposal\/([^/]+)\/reject$/.exec(path);
    if (rejectOne !== null) {
      const id = decodePathSegment(rejectOne[1], "提案 id");
      return await rejectOneProposal(services, id, body);
    }
    return undefined; // 写通道上的其它路径仍 404
  }

  // ── W-3 资料改名 / 删除（PATCH / DELETE 只走写通道）──
  if (writeChannel === true) {
    const mSource = /^\/source\/([^/]+)$/.exec(path);
    if (mSource !== null && method === "PATCH") {
      const id = decodePathSegment(mSource[1], "资料 id");
      return renameSource(services, id, body);
    }
    if (mSource !== null && method === "DELETE") {
      const id = decodePathSegment(mSource[1], "资料 id");
      const force = url.searchParams.get("force") === "1";
      return deleteSource(services, id, force);
    }
  }

  const isGet = method === "GET";
  if (path !== "/sources" || !isGet) return undefined;

  const q = url.searchParams;

  // ① 参数校验（全部先于取数）：limit / offset 用公共原语，status 用本模块的白名单。
  let limit: number | undefined;
  let offset: number | undefined;
  try {
    limit = parseNonNegativeInt(q.get("limit"), "limit");
    offset = parseNonNegativeInt(q.get("offset"), "offset");
  } catch (err) {
    // 新端点统一用固定机器码（与 status 非法同体），细节不进入响应。
    if (err instanceof BadRequestError) return BAD_REQUEST;
    throw err;
  }

  const rawStatus = q.get("status");
  let status: SourceStatus | undefined;
  if (rawStatus !== null) {
    if (!isSourceStatus(rawStatus)) return BAD_REQUEST;
    status = rawStatus;
  }

  // exactOptionalPropertyTypes：可选字段用条件展开，不显式赋 undefined。
  const query: ListSourcesQuery = {
    limit: limit ?? DEFAULT_LIMIT,
    offset: offset ?? DEFAULT_OFFSET,
    ...(status === undefined ? {} : { status }),
  };

  // ② 取数：领域库返回 { items, total }，本端点只暴露数组（见模块头注）。
  const store = requireProfileStore(services);
  return { status: 200, body: store.sources.list(query).items };
}
