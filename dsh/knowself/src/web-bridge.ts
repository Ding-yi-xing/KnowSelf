/**
 * knowSelf Web 数据桥（B2 方案 A / M3-T08 路由拆分后）—— 运行在 dsh 宿主 / Node 进程。
 *
 * 职责（薄桥接，符合技术红线）：把领域层的只读能力暴露为同 origin 的只读 REST 端点，
 * 供浏览器面板（`src/client/*-port.ts`）取数。**不写业务、不重复定义领域类型、
 * 不引入 HTTP 框架、零写端点**。
 *
 * ## 本文件只负责四件事
 *   ① 依赖门控：`ctx.inject(["webServer", "connection"], ...)` 子 fiber（cordis 全有或全无）；
 *   ② **鉴权闸门**：`connection.requestRejection(request)` 必须是 `resource` 的**第一行**
 *      （F3 修复，05 §13.8）。`/knowself-api/*` 不受 dsh 会话鉴权保护，必须桥自行施加；
 *   ③ 路由分发：委托 `src/routes/index.ts` 的 `dispatch(url, services, method, body?)`；
 *   ④ 异常收敛：`BadRequestError` → 400，其它 → 500（脱敏）+ 日志。
 *
 * W-1 起 `dispatch` 增加可选第 4 参 `body` 与 `RouteContext.writeChannel`，本桥仍只传
 * 前三参（只读 GET 无 body），既有行为逐字不变。写端点**不在本文件注册**：官方
 * resource 型对非 GET/HEAD 直接 405，必须由 `write-bridge.ts` 的 handler 型独立
 * fiber 挂载（见 `registerKnowselfWriteBridge` / `src/index.ts`）。
 *
 * ## 端点契约（05 §13.4 / §14）
 *   GET /knowself-api/persons               → 200 + PersonRow[]          / 503 人物层降级
 *   GET /knowself-api/person/:id            → 200 + PersonRow|null       / 503 人物层降级
 *   GET /knowself-api/person/:id/timeline   → 200 + EventRow[]           / 503 人物层降级
 *   GET /knowself-api/profile/core          → 200 + CoreProfileStored    （核心层必有）
 *   GET /knowself-api/cards?layer=L2        → 200 + CardSummary[]        （layer 省略 = 全部；
 *                                             layer=L1 → 400 unsupported_layer，L1 走 /profile/core）
 *   GET /knowself-api/cards/:key            → 200 + CardWithSections     / 404 不存在
 *   GET /knowself-api/journal               → 200 + JournalDateSummary[]
 *   GET /knowself-api/journal/:date         → 200 + { date, records }
 *   GET /knowself-api/proposals?status=     → 200 + IngestionProposal[]（缺省 pending = 待整理）
 *   GET /knowself-api/sources?limit=&offset=&status=
 *                                          → 200 + SourceStored[]        （核心层必有）
 *   400 参数错误 | 404 未知路径/非 GET | 500 服务端异常 | 503 人物层降级
 *
 * ## 处理顺序（**不可改变**）
 *   **鉴权 → 路由(404) → 参数(400) → 降级(503) → 数据(200)**
 * 未认证调用方不得看到 `degraded.reason`（可能含路径等内部信息），也不得通过 404/400
 * 探知路径语义；因此鉴权判决必须在 `dispatch` 之前，且 `dispatch` 完全不认识鉴权。
 *
 * ## 降级语义（§13.4）
 * 注册期只捕获 `services` 引用、**不取 `personStore`**；人物端口每次请求惰性解析。
 * 人物层缺失 → `503 + { status:"degraded", reason, layer:"person" }`（见 `routes/persons.ts`）。
 * 核心层（`profileStore`）属装配第 1 层「必有」，缺失视为装配异常 → 500，**不造 503**。
 * `degraded` 字段缺失（W1/W2/W3 的测试桩）视为人物层可用。
 *
 * ## fail-closed
 * `ctx.inject(["webServer","connection"], ...)` 缺任一依赖时 cordis 不触发回调、
 * 桥不注册（宁可 404 也不裸奔）；绝不做「connection 不存在就放行」的降级。
 *
 * 类型来源：`types/dsh-webserver-contract.d.ts` 本地 ambient 契约 + `types/cordis-webserver.d.ts`
 * 的 cordis 增强（提供 `sub.webServer` 强类型）。**不 import `@deepseek-ai/dsh-host-webserver`**。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  ConnectionServiceLike,
  WebResourceRouteLike,
} from "@knowself/dsh-webserver-contract";
import { dispatch, KNOWSELF_API_BASE } from "./routes/index.js";
import {
  BadRequestError,
  errorMessage,
  json,
  sanitizeReason,
} from "./routes/http.js";
import type { KnowselfServices } from "./services.js";

/** Minimal read-only provider for runtime automation state. */
export interface AutomationStatusProvider {
  getStatus(): unknown;
}

/**
 * F3 鉴权闸门响应：把 dsh `connection.requestRejection(request)` 的判决转成 HTTP 响应。
 *
 * - `403` → Host/Origin 围栏拒绝（DNS rebinding / 跨站请求）；
 * - `401` → 会话无效或浏览器凭据缺失；
 *
 * 响应体是**固定文案**、`cache-control: no-store`，绝不回显任何内部信息
 * （路径 / `degraded.reason` / 堆栈 / 密钥），避免未认证调用方探测宿主。
 */
function rejectionResponse(status: 401 | 403): Response {
  return new Response(
    status === 403
      ? "forbidden\n"
      : "dsh web authentication required; reopen the URL printed by dsh web.\n",
    {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * 注册 knowSelf REST 数据桥；返回统一卸载器（dispose 子 fiber）。
 *
 * 依赖 `webServer`（注册路由）与 `connection`（dsh 鉴权入口）**两者齐备**才注册；
 * cordis 的 `inject` 是「全有或全无」，缺任一依赖时回调不执行 → 桥不注册（fail-closed）。
 *
 * @param ctx dsh / cordis Context（webServer / connection 未就绪时子 fiber 不触发）
 * @param services 已装配的领域服务（**每次请求时**惰性读取其 personStore / profileStore）
 * @returns 卸载器；依赖未就绪也是可安全调用的 no-op（dispose 空 fiber）
 */
export function registerKnowselfWebBridge(
  ctx: Context,
  services: KnowselfServices,
  automationStatus?: AutomationStatusProvider,
): () => void {
  const fiber = ctx.inject(["webServer", "connection"], (sub) => {
    // 具名 logger 由子 fiber 的 Context 提供（F7：ctx.logger(name) 存在）。
    const log = sub.logger("knowself");
    // F3：dsh `connection` 服务的最小面（Host/Origin 围栏 + 会话校验）。
    const connection: ConnectionServiceLike = sub.connection;

    const route: WebResourceRouteLike = {
      kind: "prefix",
      path: KNOWSELF_API_BASE,
      resource: async (request: Request): Promise<Response> => {
        // ① 鉴权优先（fail-closed）：先于路径解析、参数校验、降级判断与任何业务调用。
        //    未认证调用方拿不到 503 的 reason，也拿不到 404 的路径语义。
        const rejection = connection.requestRejection(request);
        if (rejection !== undefined) {
          return rejectionResponse(rejection);
        }

        const url = new URL(request.url);
        if (
          automationStatus !== undefined &&
          request.method === "GET" &&
          url.pathname === `${KNOWSELF_API_BASE}/automation/wechat-import-status`
        ) {
          return json(automationStatus.getStatus());
        }

        // ②~⑤ 路由(404) → 参数(400) → 降级(503) → 数据(200) 全部在 routes/ 内完成。
        try {
          const result = await dispatch(
            url,
            services,
            request.method,
          );
          return json(result.body, result.status, result.headers);
        } catch (err) {
          if (err instanceof BadRequestError) {
            return json({ error: err.message }, 400);
          }
          log.error("knowself REST 数据桥处理失败：", errorMessage(err));
          return json({ error: sanitizeReason(errorMessage(err)) }, 500);
        }
      },
    };

    // effect 内注册，disposer 由 fiber 管理；卸载时 sub.effect 的 disposer 级联回收。
    // W-1 的写端点**不在这里注册**：官方 resource 型对非 GET/HEAD 直接 405，
    // 写端点必须是 handler 型，由 `write-bridge.ts` 的独立 fiber 挂载
    // （见 `registerKnowselfWriteBridge` / `src/index.ts`）。
    sub.effect(() => sub.webServer.register(route));
  });

  return () => {
    void fiber.dispose();
  };
}
