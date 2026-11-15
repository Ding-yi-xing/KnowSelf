/**
 * 本地 ambient 契约（B2 + W2/T04）——dsh host webServer 的最小类型面。
 *
 * 背景（主理人已核实 2026-11-09，见 B2 任务说明）：
 *   `@deepseek-ai/dsh-host-webserver@0.2.2-rc.1` 在本独立 pnpm 子工作区**不可解析**
 *   （只是 `@deepseek-ai/dsh` 的传递依赖，仅存在于 node_modules/.pnpm 虚拟存储，
 *   顶层 `node_modules/@deepseek-ai/` 下无链接；`require.resolve` → MODULE_NOT_FOUND）。
 *   直接 `import "@deepseek-ai/dsh-host-webserver"`（B2-工单.md 骨架第 47 行）会让
 *   `pnpm typecheck` 必然失败——与 A2 的虚拟模块同类问题。
 *
 * 因此沿用 A2 已验证的模式：按**真实 .d.ts 已核实签名**在 `types/` 下声明一份
 * 独立虚拟模块 `@knowself/dsh-webserver-contract`；`src/web-bridge.ts` 只 `import type`
 * 本模块（编译期擦除、运行期零依赖），**不 import 任何 @deepseek-ai 家族运行时包**。
 *
 * 真实签名（已核实，逐字，见 .pnpm 虚拟存储中 dsh-host-webserver 的 lib/types/index.d.ts）：
 *   export type WebRouteKind = 'exact' | 'prefix';
 *   export interface WebRoute { kind: WebRouteKind; path: string; handler: (req, res) => ... }
 *   export type WebResource = (request: Request, peer?: PeerScope) => Promise<Response>;
 *   export interface WebResourceRoute { kind: WebRouteKind; path: string; resource: WebResource; }
 *   export declare class WebServer extends Service {
 *     register(route: WebRoute | WebResourceRoute): () => void;   // 返回 disposer
 *     registerUpgrade(...): () => void; registerFallback(...): () => void;
 *   }
 *   declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }  // 必选！
 *   prefix 匹配（真实 lib/index.js:585）：
 *     `pathname !== prefix && !pathname.startsWith(prefix + '/')` 时跳过。
 *
 * 本契约相对真实签名的差异（均为有意、已登记到 README 偏差表）：
 *   1. 只声明我们用到的 resource 型路由，不含 handler 型 `WebRoute`；register 参数相应收窄；
 *   2. `WebResource` 省略可选第二参 `peer?: PeerScope`（来自 `@deepseek-ai/dsh-typert-protocol`，
 *      本工作区不可解析；参数更少的函数可安全赋给参数更多的函数类型，形状兼容）；
 *   3. 真实 augmentation 里 `webServer: WebServer` 是**必选**；本契约把它收敛到
 *      只有 `register` 的 `WebServerLike`，形状兼容（W2/T04 的 `sub.webServer` 强类型来源）。
 *   4. `WebBridgeContext` 是 B2 期探针用过的可选形状，W2 改子 fiber 后源码已不再引用，
 *      保留仅为兼容既有类型引用，不代表运行时仍做存在性探测。
 *
 * 另注（如实）：真实 `WebResource` 只回答 HTTP GET 与 HEAD，其他方法由 webServer 直接 405
 * （不进 resource）；resource 抛错时 HTTP 请求收到 400（进程内 readResource 则 reject）。
 * 插件层统一 400/404/500 + `{error}` 属于 `B2-工单.md` §1 的显式约定，按工单实现。
 *
 * 注意：本文件保持为「script」（无顶层 import/export），`declare module` 才是环境模块声明；
 * `Request` / `Response` 来自 tsconfig 的 DOM lib 全局类型，无需 import。
 * W2/T04 的 cordis 增强使用**内联 `import(...)` 查询**，不引入顶层 import/export。
 */
declare module "@knowself/dsh-webserver-contract" {
  /** 路由匹配方式（真实：'exact' | 'prefix'）。 */
  export type WebRouteKind = "exact" | "prefix";

  /** register 返回的卸载器（真实：`() => void`）。 */
  export type WebRouteDisposer = () => void;

  /**
   * 标准 Fetch 资源处理函数。
   * 真实签名还有可选第二参 `peer?: PeerScope`（本工作区不可解析，按核实结论省略）。
   */
  export type WebResource = (request: Request) => Promise<Response>;

  /** resource 型路由（本插件注册的就是它）。 */
  export interface WebResourceRouteLike {
    kind: WebRouteKind;
    /** 绝对路径，无尾斜杠（真实 prefix 匹配见 lib/index.js:585）。 */
    path: string;
    resource: WebResource;
  }

  /** `ctx.webServer` 的最小契约：只需 register（返回 disposer）。 */
  /**
   * W-1：raw HTTP **handler 型**路由（真实 `WebRoute`，见官方
   * `packages/host/webserver/src/index.ts:52-58`）。
   *
   * 与 `WebResourceRouteLike` 的区别是决定性的：resource 型由 `serveResource`
   * （同文件 :676-680）**只允许 GET/HEAD**，其它方法直接 405 且 request body
   * 永不读取；handler 型由 `handle()`（:541）直接 `await responder.handler(req,res)`，
   * **无 method 限制、可读 body**。所以四工单的 POST/PATCH 写端点必须走本类型。
   *
   * 参数类型用最小结构面而非 `import("node:http")`：插件的 tsconfig 只开 DOM lib，
   * 引入 node 类型会让 client bundle 的反向自检（禁 `node:*` 字面）误判，且这里
   * 只需要 `headers` / `method` / `url` / 异步迭代 body 与 `writeHead`/`end`。
   */
  export interface WebHandlerRequestLike {
    readonly method?: string;
    readonly url?: string;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    /** 异步迭代请求体分块（Node IncomingMessage 兼容 AsyncIterable<Buffer>）。 */
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
  }

  /** 最小响应面（只写状态码 + JSON 文本，不碰 Fetch Response）。 */
  export interface WebHandlerResponseLike {
    writeHead(status: number, headers: Readonly<Record<string, string>>): unknown;
    end(body?: string): unknown;
  }

  /** handler 型路由注册项。 */
  export interface WebHandlerRouteLike {
    kind: WebRouteKind;
    path: string;
    handler: (
      req: WebHandlerRequestLike,
      res: WebHandlerResponseLike,
    ) => void | Promise<void>;
  }

  export interface WebServerLike {
    register(route: WebResourceRouteLike | WebHandlerRouteLike): WebRouteDisposer;
  }

  /**
   * F3：dsh `connection` 服务的最小面：Host/Origin 围栏 + 会话校验。
   *
   * 真实签名（已核实，`@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts:82,185`）：
   *   export type ConnectionRequestRejection = 401 | 403 | undefined;
   *   requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection;
   *   export interface ConnectionTrustRequest { readonly headers: Headers | Readonly<Record<...>> }
   *
   * 入参收窄为 `Request`：`Request.headers` 是 `Headers`，因此形状兼容（真实实现可安全
   * 赋给本契约，参数逆变方向成立）；本插件只持有 `Request`，无需构造 `ConnectionTrustRequest`。
   */
  /**
   * W-1：handler 型通道只持有 `IncomingMessage.headers`，没有完整 Fetch `Request`。
   * 真实 `ConnectionTrustRequest`（官方 `packages/client/connection/src/rpc.ts:98-101`）
   * **只有 `readonly headers` 一个字段**，因此这里把入参放宽为 union：
   * resource 型继续传 `Request`，handler 型传 `{ headers }`，两者都能安全赋给真实实现。
   */
  export interface ConnectionTrustRequestLike {
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  }

  export interface ConnectionServiceLike {
    requestRejection(request: Request | ConnectionTrustRequestLike): 401 | 403 | undefined;
  }

  /**
   * B2 期 `registerKnowselfWebBridge` 对 ctx 做形状约束的最小面（历史保留）。
   * W2/T04 改 `ctx.inject(["webServer"], ...)` 子 fiber 后，源码不再走 `in` 探针。
   */
  export interface WebBridgeContext {
    webServer?: WebServerLike;
  }
}

/**
 * W2/T04 的 cordis `Context.webServer` 增强放在**独立模块文件**
 * `types/cordis-webserver.d.ts`（本文件保持 script）。
 *
 * 原因（实测）：在 script（无顶层 import/export）的 .d.ts 里写
 * `declare module "@deepseek-ai/cordis" { interface Context { ... } }`
 * 会被 TypeScript 当作**环境模块声明并覆盖**磁盘上的 cordis 模块，
 * 导致 `Context.effect` / `logger` / `inject` 全部消失（typecheck 4 处 TS2339）。
 * 标准 module augmentation 必须写在**模块文件**（有顶层 import/export）里，
 * 才能与已存在的 cordis 声明合并。详见 cordis-webserver.d.ts 头注。
 */
