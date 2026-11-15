/**
 * 人物层只读路由（M3/T08 从 `web-bridge.ts` 逐字迁移，语义零变更）。
 *
 *   GET /persons             → 200 + PersonRow[]
 *   GET /person/:id          → 200 + PersonRow|null（未找到按契约返回 200 + null）
 *   GET /person/:id/timeline → 200 + EventRow[]
 *
 * 降级语义（05 §13.4）：注册期不取 `personStore`，**每次请求惰性解析**；缺失时返回
 * `503 + { status:"degraded", reason, layer:"person" }`，让客户端区分
 * 404（桥没注册）/ 503（人物层降级）/ 500（领域异常）。`degraded` 缺失（W1/W2/W3 的
 * 测试桩）视为人物层可用。
 *
 * 顺序约定由 `web-bridge.ts` 保证：**鉴权 → 路由(404) → 参数(400) → 降级(503) → 数据(200)**。
 * 本模块内部的顺序同样是「先校验参数、后解析端口」——参数错必须报 400 而不是 503。
 */
import type {
  PersonListQuery,
  PersonStatus,
  SubjectKind,
} from "@knowself/person-store";
import type { PersonTimelineQuery } from "../client/data-port.js";
import { createPersonStoreDataPort } from "../person-store-data-port.js";
import type { KnowselfServices } from "../services.js";
import {
  BadRequestError,
  decodePathSegment,
  degradedBody,
  parseNonNegativeInt,
  sanitizeReason,
  type DispatchResult,
  type RouteContext,
} from "./http.js";
import {
  archivePerson,
  createPerson,
  mergePerson,
  updatePerson,
} from "./persons-write.js";

/** 人物层只读端口形状（`createPersonStoreDataPort` 的返回类型）。 */
type PersonPort = ReturnType<typeof createPersonStoreDataPort>;

/** 类型守卫：subject_kind 只接受领域库字面量联合里的值，避免 `as never` 全逃逸。 */
function isSubjectKind(value: string): value is SubjectKind {
  return value === "self" || value === "contact";
}

/** 类型守卫：status 只接受领域库字面量联合里的值。 */
function isPersonStatus(value: string): value is PersonStatus {
  return value === "active" || value === "archived" || value === "merged";
}

/** 从降级状态里取人物层那条原因；degraded 缺失（测试桩）时给通用可读原因。 */
export function personDegradedReason(services: KnowselfServices): string {
  const reasons = services.degraded?.reasons ?? [];
  const hit = reasons.find((reason) =>
    /人物层|createPersonStore|personStore/i.test(reason),
  );
  return sanitizeReason(hit ?? "人物层未就绪（personStore 不可用）", "人物层未就绪");
}

/** 每次请求时解析人物端口；人物层降级返回 undefined。注册期不触碰 personStore。 */
function resolvePersonPort(services: KnowselfServices): PersonPort | undefined {
  const store = services.personStore;
  if (store === undefined) return undefined;
  return createPersonStoreDataPort(store);
}

/**
 * 从 URLSearchParams 构造 `PersonListQuery`（显式赋值，配合 exactOptionalPropertyTypes）。
 * subject_kind / status 用类型守卫收窄，数值参数用 parseNonNegativeInt 校验，零 `as never`。
 */
function buildPersonListQuery(q: URLSearchParams): PersonListQuery {
  const query: PersonListQuery = {};

  const subjectKind = q.get("subject_kind");
  if (subjectKind !== null) {
    if (!isSubjectKind(subjectKind)) {
      throw new BadRequestError(`参数 subject_kind 非法：${subjectKind}`);
    }
    query.subject_kind = subjectKind;
  }

  const status = q.get("status");
  if (status !== null) {
    if (!isPersonStatus(status)) {
      throw new BadRequestError(`参数 status 非法：${status}`);
    }
    query.status = status;
  }

  const keyword = q.get("keyword");
  if (keyword !== null) query.keyword = keyword;

  const limit = parseNonNegativeInt(q.get("limit"), "limit");
  if (limit !== undefined) query.limit = limit;

  const offset = parseNonNegativeInt(q.get("offset"), "offset");
  if (offset !== undefined) query.offset = offset;

  return query;
}

/** 从 URLSearchParams 构造 timeline 第二参（复用 data-port.ts 推导的 PersonTimelineQuery）。 */
function buildTimelineQuery(q: URLSearchParams): PersonTimelineQuery {
  const query: PersonTimelineQuery = {};

  const fromDate = q.get("from_date");
  if (fromDate !== null) query.from_date = fromDate;
  const toDate = q.get("to_date");
  if (toDate !== null) query.to_date = toDate;

  const minImportance = parseNonNegativeInt(q.get("min_importance"), "min_importance");
  if (minImportance !== undefined) query.min_importance = minImportance;
  const limit = parseNonNegativeInt(q.get("limit"), "limit");
  if (limit !== undefined) query.limit = limit;
  const offset = parseNonNegativeInt(q.get("offset"), "offset");
  if (offset !== undefined) query.offset = offset;

  return query;
}

/**
 * 处理人物层三个只读端点。
 *
 * 声明为 async 是因为 `PersonPanelDataPort` 的方法签名是 `T | Promise<T>`（本地适配器同步、
 * 未来的 bridge 实现异步），统一 `await Promise.resolve(...)` 两种形态都安全。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 前缀）
 * @returns 命中的 `{ status, body }`；非人物路径 / 非 GET → `undefined`（交由 404）
 */
export async function handlePersonsRoute(
  ctx: RouteContext,
): Promise<DispatchResult | undefined> {
  const { path, url, services, method, body, writeChannel } = ctx;
  // 真实 WebResource 只回答 GET / HEAD；插件层仍显式判 GET，让契约在单测直调时也自洽。
  const isGet = method === "GET";
  const mPerson = /^\/person\/([^/]+)$/.exec(path);
  const mTimeline = /^\/person\/([^/]+)\/timeline$/.exec(path);
  const mMerge = /^\/person\/([^/]+)\/merge$/.exec(path);
  const q = url.searchParams;

  // ── W-3 写端点（只认 handler 型写通道：测试桩直调 POST /persons 仍 404，既有断言零回退）──
  if (writeChannel === true) {
    if (path === "/persons" && method === "POST") return createPerson(services, body);
    if (mMerge !== null && method === "POST") {
      const id = decodePathSegment(mMerge[1], "人物 id");
      return mergePerson(services, id, body);
    }
    if (mPerson !== null && method === "PATCH") {
      const id = decodePathSegment(mPerson[1], "人物 id");
      return updatePerson(services, id, body);
    }
    if (mPerson !== null && method === "DELETE") {
      const id = decodePathSegment(mPerson[1], "人物 id");
      return archivePerson(services, id);
    }
    // 写通道上的其它人物路径：不认领 → 404（与写桥的「其它路径仍 404」一致）
    if (path === "/persons" || mPerson !== null || mTimeline !== null || mMerge !== null) {
      return undefined;
    }
  }

  if (path === "/persons" && isGet) {
    // 参数校验（400）优先 → 人物层解析（503）→ 取数（200/500）。
    const query = buildPersonListQuery(q);
    const port = resolvePersonPort(services);
    if (port === undefined) return degradedBody(personDegradedReason(services), "person");
    return { status: 200, body: await Promise.resolve(port.listPersons(query)) };
  }

  if (mPerson !== null && isGet) {
    const id = decodePathSegment(mPerson[1], "人物 id");
    const port = resolvePersonPort(services);
    if (port === undefined) return degradedBody(personDegradedReason(services), "person");
    // 未找到按契约返回 200 + null（与 client getPerson 的 PersonRow|null 天然对齐）。
    return { status: 200, body: await Promise.resolve(port.getPerson(id)) };
  }

  if (mTimeline !== null && isGet) {
    const id = decodePathSegment(mTimeline[1], "人物 id");
    const query = buildTimelineQuery(q);
    const port = resolvePersonPort(services);
    if (port === undefined) return degradedBody(personDegradedReason(services), "person");
    return { status: 200, body: await Promise.resolve(port.timeline(id, query)) };
  }

  return undefined;
}
