/**
 * vitest `globalSetup`（W-8/B3）。
 *
 * ## 为什么要有它
 * 没有它的时候，`npx vitest` 在一个 Node 大版本不对的环境里会直接吐
 * `NODE_MODULE_VERSION 137 / 127` 这种编译期术语 —— 谁看都是一头雾水，
 * 于是被误当成"代码坏了"。有了这一层，同一个故障会变成一句中文：
 *
 *   当前 Node v22.22.2 与仓库声明不符（要求 24.x：.nvmrc=24.14.1、engines.node=>=24 <25）。
 *   请切换到与该大版本一致的 Node 后重试。
 *
 * ## 约束（主理人定，逐条对应）
 *   1. **只读**：只调 `checkEnv()`，不写 node_modules、不 rebuild；
 *   2. **只用 node 内置**：本文件只 import `./ensure-native.mjs`，后者只用 fs / path / module / child_process；
 *   3. **失败即终止**：抛错让 vitest 直接退出（非 0），不跑任何用例；
 *   4. **不得出现 `NODE_MODULE_VERSION` 字面**：`ensure-native.mjs` 里已经统一改写成中文；
 *   5. **不影响 `dsh/knowself`**：那是独立工程，有**自己的** `vitest.config.ts`，
 *      不会读到这里；反向也成立（本文件不被它引用）。
 */
import { checkEnv } from "./ensure-native.mjs";

/**
 * vitest 的 globalSetup 入口。
 *
 * @returns {void}
 * @throws {Error} 环境不可用时抛出（一句话中文），让整轮测试终止
 */
export default function setup() {
  const result = checkEnv();
  if (result.ok) return;
  // 只在末尾补一行"去哪看详情"，避免长篇大论
  const hint =
    result.natives.some((native) => !native.ok) && result.message !== null
      ? "\n（明细：node scripts/ensure-native.mjs）"
      : "";
  throw new Error(`${result.message}${hint}`);
}
