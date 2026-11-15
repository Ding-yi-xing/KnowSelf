import { defineConfig } from "vitest/config";

/**
 * B2 环境适配（2026-11-09）：WorkBuddy 沙箱的 node fs shim 在 vitest 1.6 多 worker
 * 并发写同一 SSR 模块缓存（`%TEMP%/.../ssr/<hash>`）时偶发 `EPERM`，表现为
 * 「Vitest caught N unhandled errors」+ 部分测试文件未被收集 + `vitest run` 退出码 1
 * （与用例本身无关，串行重跑即 5 文件 / 69 测试全绿）。
 *
 * 把测试文件改为串行收集/执行可消除该竞态，使 `pnpm test` 稳定可复现。
 * 不改变任何用例语义、不新增 npm 依赖、不修改 package.json / tsconfig。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    fileParallelism: false,
    /**
     * 2026-11-12：默认 `threads` 池在 Node 24.14.1 上**稳定 segfault**
     * （EXIT=139，跑到第 7 个测试文件必崩；`w9-chat-import-mining` 单跑也崩）。
     * 改用 `forks` 池后 44 文件 / 447 用例全绿。写进配置而不是只写在 package.json，
     * 是因为 `npx vitest run` / 编辑器集成都绕不过这一层。
     */
    pool: "forks",
  },
});
