/**
 * W2/T04：cordis `Context.webServer` 服务增强（标准 module augmentation）。
 *
 * 为什么单独一个文件：`@deepseek-ai/dsh-host-webserver` 在本工作区不可解析，
 * 真实宿主里由它的 augmentation 声明必选 `webServer: WebServer`；这里用本地
 * 最小契约 `WebServerLike`（只含 `register`）补齐，使
 * `src/web-bridge.ts` 的 `ctx.inject(["webServer"], (sub) => sub.webServer.register(route))`
 * 拿到强类型 `sub`，无需 `as any` / `@ts-ignore`。
 *
 * 关键（实测教训）：`types/dsh-webserver-contract.d.ts` 是 **script**（无顶层
 * import/export），在其中写 `declare module "@deepseek-ai/cordis"` 会被 TS 当作
 * **环境模块声明并覆盖**磁盘上的 cordis 模块，导致 `Context.effect` / `logger` /
 * `inject` 全部消失（typecheck 报 4 处 TS2339）。因此本文件用顶层 `export {}`
 * 成为**模块文件**，`declare module` 才是与已存在模块合并的 augmentation。
 *
 * 依据：
 *   - `@deepseek-ai/cordis/lib/types/registry.d.ts:111`
 *     `inject(deps, callback): Fiber & PromiseLike<Fiber>`；
 *   - `fiber.d.ts:110` `readonly dispose: () => Promise<void>`；
 *   - `registry.d.ts:56` `Plugin.Base.Config?: StandardSchemaV1<any, T>`；
 *   - 真实宿主 augmentation 的形状差异已在 dsh-webserver-contract.d.ts 头注登记。
 *
 * 注意：本文件保持用**内联 `import(...)` 查询**访问 ambient 契约，不引入任何
 * 运行时依赖；`Request` / `Response` 来自 tsconfig 的 DOM lib。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: import("@knowself/dsh-webserver-contract").WebServerLike;
  }
}

export {};
