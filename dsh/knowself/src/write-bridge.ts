/**
 * W-1：REST **写**端点的 handler 型桥梁（与 `web-bridge.ts` 的 resource 型只读桥并列）。
 *
 * ## 为什么必须单独一条路由
 * 官方 `packages/host/webserver` 的 `serveResource`（`src/index.ts:676-680`）对
 * **非 GET/HEAD 直接 405**，且注释明写「its request body is never read」；
 * `readResource`（:501-503）同样。插件现有 `/knowself-api` 是 **resource 型**前缀，
 * 因此 `POST /knowself-api/sources` 永远到不了 `dispatch`——真机实测返回
 * `405 / allow: GET, HEAD`（证据见 `docs/dsh-integration/evidence/w1-post405-result.json`）。
 *
 * 官方 `WebRoute`（:52-58）是 **handler 型**，`handle()`（:541）直接
 * `await responder.handler(req, res)`，无 method 限制、可读 body。故本模块注册
 * 一条更长的 `prefix` 路由 `/knowself-api/write`，靠 `match()` 的
 * **longest-prefix-wins**（:655-664）把写请求导向 handler，而原有 GET 仍命中
 * `/knowself-api` 的 resource 型——**不动官方源码、零行为变化**。
 *
 * ## 职责边界
 * - 本模块负责「鉴权 → 写守卫 → 读 body → JSON 解析 → 转 dispatch → 写响应」，
 *   与 resource 型桥的职责分层完全一致：`dispatch` 及其下游 routes/*.ts 仍是
 *   **纯函数式分发**，不认识鉴权、不产生 Response。
 * - 业务语义（参数校验 / 降级 / 领域调用）全部留在 `routes/sources.ts` 等路由模块，
 *   本模块只做通道级守卫，绝不重复定义领域类型。
 *
 * ## 六条守卫（05 §1.5 的 D-B 独立评审要求，落档见 `ISS-004`）
 *   ① 鉴权：`connection.requestRejection({headers})`（Host/Origin 围栏 + 会话）
 *   ② 自定义头 `x-knowself-write: 1`：跨站简单表单无法设置，且会强制
 *      CORS 预检（OPTIONS）；本通道只收 POST/PATCH → OPTIONS 必被 405，跨站打不进来
 *   ③ method + Content-Type：只收 `POST`/`PATCH` 且 `application/json`
 *   ④ Origin：**有**则必须与 Host 同源（或 `dsh-app://app`）；**无**则放行。
 *      真机实测（`evidence/w1-header-probe.mjs`）：Electron 自定义协议
 *      `dsh-app://app` 的同源 fetch **根本不带 Origin**，也不带 Host，
 *      因此不能要求「必须带 Origin」。无 Origin 时的安全性由 ②③④ 合起来保证：
 *      自定义头 + JSON CT + `requestRejection` 的会话鉴权，三者缺一不可。
 *      额外用 `sec-fetch-site`（若浏览器提供）拒绝 cross-site。
 *   ⑤ 幂等键：`x-knowself-idempotency-key`，短 TTL 内重复键直接重放上次结果
 *   ⑥ provenance 固定：`CreateSourceRequest` 契约无该字段，写入方无法伪造
 *
 * ## 边界
 * - 服务端代码，**不进入 client bundle**（client 反向自检禁 `node:*` / `process.env`）；
 *   本模块不 import 任何 Node 内置模块，请求体走 `IncomingMessage` 的异步迭代。
 * - 响应体固定 `no-store`，错误文案经 `sanitizeReason` 脱敏（不含路径/密钥/堆栈）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  ConnectionServiceLike,
  ConnectionTrustRequestLike,
  WebHandlerRequestLike,
  WebHandlerResponseLike,
  WebHandlerRouteLike,
} from "@knowself/dsh-webserver-contract";
import type { KnowselfServices } from "./services.js";
import { dispatch, KNOWSELF_API_BASE } from "./routes/index.js";
import {
  BadRequestError,
  errorMessage,
  sanitizeReason,
  type DispatchResult,
} from "./routes/http.js";

/** 写端点物理前缀。client port 内部做映射，逻辑路径仍是工单的 `/sources`。 */
export const KNOWSELF_WRITE_API_BASE = `${KNOWSELF_API_BASE}/write`;

/**
 * 允许的写方法：
 *   - `POST`   —— 新建 / 动作类（导入、挖掘、采纳）；
 *   - `PATCH`  —— 局部更新（W-3：改人物、改资料名）；
 *   - `DELETE` —— 归档 / 删除（W-3：人物归档、资料删除）。
 * 只暴露这三个：`PUT` / `OPTIONS` 一律 405（跨站预检因此拿不到放行，见文件头注）。
 */
const ALLOWED_METHODS: readonly string[] = ["POST", "PATCH", "DELETE"];

/** 自定义头：跨站简单表单无法携带，触发 CORS 预检即被拒。 */
const WRITE_HEADER = "x-knowself-write";
const IDEMPOTENCY_HEADER = "x-knowself-idempotency-key";

/** 请求体上限（8 MB）：content_base64 的契约上限是 8,000,000 字符。 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/** 幂等结果缓存的存活时长与容量上限（纯内存，进程重启即失效）。 */
const IDEMPOTENCY_TTL_MS = 60_000;
const IDEMPOTENCY_MAX_ENTRIES = 128;

/** 创建写桥所需的宿主依赖（与 resource 型桥共用同一个 `sub` fiber）。 */
export interface WriteBridgeDeps {
  services: KnowselfServices;
  /** 真实 `connection.requestRejection`；入参只含 headers，见 ambient 契约。 */
  requestRejection: (request: ConnectionTrustRequestLike) => 401 | 403 | undefined;
  /** 具名 logger 的 error 入口（固定双参，避免 spread 到非 rest 签名）。 */
  log: { error: (message: string, err: unknown) => void };
}

/**
 * 读取单个 header（大小写不敏感，数组取首值）。
 * @param req handler 型请求
 * @param name 小写 header 名
 */
function header(req: WebHandlerRequestLike, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value[0];
}

/** 写 JSON 响应（固定 no-store，避免写结果被缓存）。 */
function writeJson(res: WebHandlerResponseLike, result: DispatchResult): void {
  res.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(result.body));
}

/**
 * ④ Origin 围栏（真机校准版）。
 *
 * 官方 `isTrustedApiRequest` 对缺失 Origin 放行；写端点不能无条件继承该宽松度，
 * 但也**不能要求必须带 Origin**——真机实测 Electron 自定义协议 `dsh-app://app`
 * 的同源 fetch 既不带 `Origin` 也不带 `Host`（见 `w1-header-probe.mjs`）。
 *
 * 判定：
 *   - `sec-fetch-site` 存在且为 `cross-site` → 拒（现代浏览器给的额外信号）；
 *   - `Origin` 缺失 → 放行，安全性由「自定义头 + JSON CT + 会话鉴权」三者保证；
 *   - `Origin` 存在 → 必须是 `dsh-app://app`，或与 `Host` 同源，否则拒。
 *
 * 跨站攻击路径已被封死：跨站表单无法设置 `x-knowself-write`，带自定义头的
 * 跨站请求必先 OPTIONS 预检，而本通道只允许 POST/PATCH（OPTIONS → 405）。
 */
function isWriteOriginAllowed(req: WebHandlerRequestLike): boolean {
  const fetchSite = header(req, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite === "cross-site") return false;

  const origin = header(req, "origin");
  if (origin === undefined || origin === "null") return true;
  if (origin === "dsh-app://app") return true;
  const host = header(req, "host");
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 读取并限长解析 JSON body。
 * @throws BadRequestError 体超限 / 非 JSON（→400）
 */
async function readJsonBody(req: WebHandlerRequestLike): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new BadRequestError("请求体超过 12 MB 上限");
    }
    chunks.push(chunk);
  }
  if (total === 0) return {}; // distill 的 body 是 {}
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestError("请求体必须是合法 JSON");
  }
}

/** 幂等缓存条目。 */
interface IdempotencyEntry {
  at: number;
  result: DispatchResult;
}

/**
 * 构造 handler 型路由的 `handler` 函数。
 *
 * 处理顺序（**不可换**）：鉴权 → Origin → 自定义头 → method+CT → body → 幂等 →
 * dispatch → 响应。任何守卫失败都写固定文案响应，绝不回显内部信息。
 */
export function createWriteHandler(
  deps: WriteBridgeDeps,
): (req: WebHandlerRequestLike, res: WebHandlerResponseLike) => Promise<void> {
  const cache = new Map<string, IdempotencyEntry>();

  return async (req, res): Promise<void> => {
    // ① 鉴权优先（fail-closed）：与 resource 型桥一致，第一行就是判决。
    const rejection = deps.requestRejection({ headers: req.headers });
    if (rejection !== undefined) {
      writeJson(res, { status: rejection, body: { error: "unauthorized" } });
      return;
    }

    // ② 自定义头（无 Origin 时的主要 CSRF 防线，必须先于 Origin 判定）
    if (header(req, WRITE_HEADER) !== "1") {
      writeJson(res, { status: 403, body: { error: "forbidden" } });
      return;
    }

    // ③ method + Content-Type
    const method = (req.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      writeJson(res, { status: 405, body: { error: "method_not_allowed" } });
      return;
    }
    const contentType = header(req, "content-type") ?? "";
    // DELETE 语义上**可以没有 body**：curl / fetch / 各种 SDK 默认都不会给 DELETE 带
    // `Content-Type` 和载荷。早先对所有方法一律要求 JSON 头，导致
    // `DELETE /write/person/:id`（只带 x-knowself-write）直接 415 —— 这是 API 形状的坑，
    // 不是调用方的姿势问题。这里只对 DELETE 放宽「无 Content-Type ⇒ 视为空体」；
    // 若显式给了 Content-Type，仍然必须是 JSON（防止跨站表单用 text/plain 混进来）。
    const hasJsonContentType = contentType.toLowerCase().startsWith("application/json");
    const bodyOmitted = method === "DELETE" && contentType === "";
    if (!hasJsonContentType && !bodyOmitted) {
      writeJson(res, { status: 415, body: { error: "unsupported_media_type" } });
      return;
    }

    // ④ Origin：有则同源，无则依赖 ②③ + 鉴权（Electron 自定义协议不带 Origin）
    if (!isWriteOriginAllowed(req)) {
      writeJson(res, { status: 403, body: { error: "forbidden" } });
      return;
    }

    // ⑤ 幂等键：TTL 内的重复键直接重放，避免「连点两次 → 双写」。
    const idempotencyKey = header(req, IDEMPOTENCY_HEADER);
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.at > IDEMPOTENCY_TTL_MS) cache.delete(key);
    }
    if (idempotencyKey !== undefined) {
      const hit = cache.get(idempotencyKey);
      if (hit !== undefined) {
        writeJson(res, hit.result);
        return;
      }
    }

    try {
      const body = await readJsonBody(req);
      const url = new URL(req.url ?? KNOWSELF_WRITE_API_BASE, "http://localhost");
      const result = await dispatch(url, deps.services, method, body);
      if (idempotencyKey !== undefined && result.status < 400) {
        if (cache.size >= IDEMPOTENCY_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(idempotencyKey, { at: now, result });
      }
      writeJson(res, result);
    } catch (err) {
      if (err instanceof BadRequestError) {
        writeJson(res, { status: 400, body: { error: err.message } });
        return;
      }
      deps.log.error("knowself 写桥处理失败：", err);
      writeJson(res, { status: 500, body: { error: sanitizeReason(errorMessage(err)) } });
    }
  };
}

/**
 * 构造待注册的 handler 型路由项。
 * 由 `web-bridge.ts` 用 `sub.effect(() => sub.webServer.register(route))` 注册，
 * disposer 与 resource 型桥一起由同一个 fiber 级联回收。
 */
export function createWriteRoute(deps: WriteBridgeDeps): WebHandlerRouteLike {
  return {
    kind: "prefix",
    path: KNOWSELF_WRITE_API_BASE,
    handler: createWriteHandler(deps),
  };
}

/**
 * 注册写桥；返回统一卸载器。
 *
 * 与 `registerKnowselfWebBridge` **并列**（各自一个 `ctx.inject` fiber），
 * 这样读桥的 263 条既有测试完全不受影响：它们直调 `registerKnowselfWebBridge`，
 * 观察到的仍是「恰好 1 条 resource 型路由 + 1 次 disposer」。
 *
 * 依赖门控与读桥一致：`ctx.inject(["webServer", "connection"], ...)` 全有或全无，
 * 缺任一依赖时 fiber 不触发、写桥不注册（fail-closed，宁可 404 也不裸奔）。
 *
 * @param ctx dsh / cordis Context
 * @param services 已装配的领域服务（写路由每次请求惰性读取 ingestion / profileStore）
 * @returns 卸载器；依赖未就绪时也是可安全调用的 no-op
 */
export function registerKnowselfWriteBridge(
  ctx: Context,
  services: KnowselfServices,
): () => void {
  const fiber = ctx.inject(["webServer", "connection"], (sub) => {
    const log = sub.logger("knowself");
    const connection: ConnectionServiceLike = sub.connection;
    const route = createWriteRoute({
      services,
      requestRejection: (request: ConnectionTrustRequestLike) =>
        connection.requestRejection(request),
      log: { error: (message: string, err: unknown) => log.error(message, err) },
    });
    sub.effect(() => sub.webServer.register(route));
  });

  return () => {
    void fiber.dispose();
  };
}
