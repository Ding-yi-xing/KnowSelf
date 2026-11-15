/**
 * F3：cordis `Context.connection` 服务增强（标准 module augmentation）。
 *
 * 背景（2026-11-09，主理人已读源码核实）：`/knowself-api/*` 完全绕过 dsh 会话鉴权
 * ——`ctx.webServer.register` 注册的 prefix 路由不在 dsh 自身路由的保护范围内。
 * dsh 提供的正确鉴权入口是 `connection.requestRejection(request)`：
 *   `@deepseek-ai/dsh-client-connection/lib/index.js:738`（服务注册名 `connection`）
 *   返回 `403`（Host/Origin 不受信任）/ `401`（会话无效）/ `undefined`（放行）。
 *
 * 为什么单独一个文件：`@deepseek-ai/dsh-client-connection` 在本工作区同样不保证可解析，
 * 且 `types/dsh-webserver-contract.d.ts` 是 **script**（无顶层 import/export），在其中写
 * `declare module "@deepseek-ai/cordis"` 会被 TS 当作环境模块声明并**覆盖**磁盘上的 cordis
 * 模块（`Context.effect` / `logger` / `inject` 全部消失）。标准 augmentation 必须写在
 * **模块文件**（有顶层 export）里，才能与已存在的 cordis 声明合并。详见 cordis-webserver.d.ts。
 *
 * 与 `webServer` 一样声明为**必选**：`src/web-bridge.ts` 用
 * `ctx.inject(["webServer", "connection"], ...)` 保证运行时两者齐备，缺任一依赖时
 * cordis 不触发回调、桥不注册（fail-closed，宁可 404 也不裸奔）。
 *
 * 注意：本文件保持用**内联 `import(...)` 查询**访问 ambient 契约，不引入任何运行时依赖；
 * `Request` 来自 tsconfig 的 DOM lib。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    connection: import("@knowself/dsh-webserver-contract").ConnectionServiceLike;
  }
}

export {};
