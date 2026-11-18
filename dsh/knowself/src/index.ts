/**
 * knowSelf 插件入口（dsh / Cordis 插件形态）。
 *
 * 注册聚合：
 *   1. 15 个领域工具（tools.ts）→ ctx.tools（W3 起按依赖层过滤）
 *   2. L1 概要注入（system-prompt.ts）→ ctx.systemPrompt
 *   3. 设置分节（settings-page.ts）→ ctx.settings
 *   4. REST 数据桥（web-bridge.ts）→ ctx.webServer（§13.4：人物层降级时仍注册并返回 503）
 *
 * 装配（services.ts）在 effect 内异步完成，W3/T05 起为三层分段降级：
 *   核心（必须成功）→ 人物（可失败）→ 检索/摄入（可失败）。
 *
 * A2：V4 / V9 面板机制已核实（见 A2-核实.md）；UI 面板（人物档案 / 知识图谱）走
 * ./client 入口（package.json 的 exports["./client"] + dsh.client），在 client 侧注册
 * main / sidebar.panellist 并接入 ctx.layout.selectPanel。server 侧 apply 只装配领域服务
 * 与工具/注入/设置，不注册面板；原有的两个空占位 server stub 已删除。
 *
 * W2/T04：声明必需依赖 `inject` 并导出插件 `Config`。
 * W3/T05：rootDir 四级推导 + 降级可观测 + 只注册依赖已满足的工具。
 * §13.4：去掉 W3 的「人物层缺失不调用桥」判断——桥只依赖 webServer。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
// 以下 side-effect 导入用于激活 dsh 对 cordis Context 的类型增强（declare module）。
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-settings";
import "@deepseek-ai/dsh-agent";

import { ensureSettingsFile } from "./bootstrap.js";

import { createRealServices, type KnowselfServices, type DshLlmStreamLike, type DshModelSelection } from "./services.js";
import { makeTools } from "./tools.js";
import { registerSystemPrompt } from "./system-prompt.js";
import { registerSettings } from "./settings-page.js";
import { registerKnowselfWebBridge } from "./web-bridge.js";
import { registerKnowselfWriteBridge } from "./write-bridge.js";
import { startWechatImportScheduler } from "./wechat-import-scheduler.js";
import { registerSessionDistillAdapter } from "./session-distill-adapter.js";
import { Config } from "./config.js";

/**
 * ② 插件 Config 级：当前 Config 只有 4 个宿主旋钮、**没有 rootDir**。
 * 按 05 §7 V6「Config 只放宿主旋钮、领域配置以 settings.json 为准」，本波不给
 * Config 新增 rootDir 以免造成配置双源；这里实现为「未来若提供 rootDir 则读取，
 * 否则跳过该级」。这是与 06 §4 T05 第②级的有意偏差（见汇报）。
 */
function configRootDir(): string | undefined {
  const dict = Config.dict;
  if (dict === undefined || !("rootDir" in dict)) return undefined;
  const value = dict.rootDir?.meta?.default;
  return typeof value === "string" && value.trim() !== ""
    ? resolve(value)
    : undefined;
}

/**
 * ③ 从 `import.meta.url` 逐级向上找含 `settings.json` 的最近目录。
 * 两种运行形态都成立：源码直跑（`src/index.ts`）与 esbuild bundle
 * （`dist/bundle/index.js`），两者向上都会到达仓库根 `.../knowSelf/settings.json`。
 */
function findSettingsRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "settings.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * 解析数据根目录，四级优先级：
 *   ① process.env.KNOWSELF_ROOT_DIR
 *   ② 插件 Config（当前无 rootDir → 跳过；未来提供则读取）
 *   ③ 从 import.meta.url 向上找含 settings.json 的最近目录 ← 关键：不再依赖用户手工设环境变量
 *   ④ process.cwd()
 */
export function resolveRootDir(): string {
  const fromEnv = process.env.KNOWSELF_ROOT_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv);

  const fromConfig = configRootDir();
  if (fromConfig !== undefined) return fromConfig;

  const found = findSettingsRoot();
  if (found !== undefined) return found;

  return process.cwd();
}

/**
 * 把全部服务注入 dsh：注册工具（已按依赖层过滤）+ 系统提示分节 + 设置分节
 * + B2 REST 数据桥（§13.4：人物层缺失时仍注册，三端点返回 503）。
 *
 * 降级可观测：装配成功但 `degraded.missing` 非空时，用
 * `ctx.logger("knowself").error` 输出缺失层与原因（F7 已核实存在）。
 * 测试桩（W1/W2 的 136 条）没有 degraded 字段，用 `?.` 防御性处理。
 *
 * @returns 统一卸载 disposer（含 web bridge disposer）
 */
export async function registerAll(ctx: Context, services: KnowselfServices): Promise<() => void> {
  const missing = services.degraded?.missing ?? [];
  const reasons = services.degraded?.reasons ?? [];
  if (missing.length > 0) {
    ctx.logger("knowself").error(
      "knowSelf 以降级模式运行（部分能力未注册）：",
      { missing, reasons },
    );
  }

  // W3/T05：makeTools 内部已按 services.degraded 与实际服务实体过滤依赖未满足的工具。
  const tools: ToolDefinition[] = makeTools(services);
  const disposers = tools.map((t) => ctx.tools.register(t));
  const spDispose = await registerSystemPrompt(ctx, services);
  const stDispose = registerSettings(ctx);
  const wechatImportScheduler = startWechatImportScheduler(services, {
    logger: ctx.logger("knowself"),
  });
  const sessionDistill = registerSessionDistillAdapter(ctx, services, {
    logger: ctx.logger("knowself"),
  });
  // §13.4：桥只依赖 webServer，人物层缺失时**仍注册**并在三端点返回 503；
  // 这样 T12 的 404 = 桥没注册、503 = 人物层降级，两者可判别。
  // webServer 不可用时子 fiber 不触发、自然不注册路由、不抛错、无噪音（W2/T04）。
  const webDispose = registerKnowselfWebBridge(ctx, services, wechatImportScheduler);
  // W-1：写端点走独立的 handler 型 fiber（官方 resource 型对非 GET 直接 405）。
  // 与读桥并列注册、并列回收；缺 webServer/connection 时同样 fail-closed。
  const writeDispose = registerKnowselfWriteBridge(ctx, services);
  return () => {
    disposers.forEach((d) => d());
    spDispose?.();
    stDispose?.();
    wechatImportScheduler.dispose();
    sessionDistill();
    webDispose();
    writeDispose();
  };
}

/** 插件入口：异步装配领域服务后注册全部扩展。 */
export function apply(ctx: Context, config?: Config): void {
  ctx.effect(async () => {
    // A1-3：装配可能抛错（离线 / 未配置 provider / SQLite 不可写）。
    // 失败时降级为「不注册工具」而非使整个插件装载崩溃。此路径 W3 不回退：
    // 第 1 层（核心）失败会冒泡到这里；第 2/3 层失败由 assembleServices 就地捕获。
    let services: KnowselfServices;
    try {
      const rootDir = resolveRootDir();
      // 0.3.6：全新安装没有 settings.json 时先自举，否则 loadSettings 抛错
      // → createRealServices 失败 → 整个插件不注册（/knowself-api/* 全 404/405）。
      const boot = ensureSettingsFile(rootDir);
      if (boot.created) {
        ctx.logger("knowself").warn(
          "未检测到 settings.json，已写入默认配置。请在设置里填入 provider 与 api_key 后再导入聊天记录。",
          { path: boot.path },
        );
      }
      // MD2-4：把 persons 密钥载体模式透传给装配层（默认 auto）。
      const personsKeyMode = config?.personsKeyMode ?? "auto";
      // llm/agentDefaultModel 用 ctx.get 读取：不在 inject 里阻塞插件加载，缺失时自动回退。
      const lookup = (name: string): unknown => {
        try {
          return (ctx as unknown as { get?: (key: string) => unknown }).get?.(name);
        } catch {
          return undefined;
        }
      };
      const llm = lookup("llm") as DshLlmStreamLike | undefined;
      const agentDefaultModel = lookup("agentDefaultModel") as
        | { currentSelection(): DshModelSelection }
        | undefined;
      services = await createRealServices(rootDir, personsKeyMode, {
        ...(llm === undefined ? {} : { llm }),
        ...(agentDefaultModel === undefined ? {} : { agentDefaultModel }),
      });
    } catch (err) {
      const log = ctx.logger("knowself");
      log.error(
        "领域服务装配失败，插件以降级模式运行（不注册任何 knowself_* 工具）：",
        err,
      );
      return () => {};
    }
    return await registerAll(ctx, services);
  });
}

/**
 * 必需服务声明（cordis `Plugin.Base.inject`，见
 * `@deepseek-ai/cordis/lib/types/registry.d.ts:57`）。
 * 只有三者齐备时插件才加载，避免 Proxy 读取未注入服务时抛错。
 */
export const inject = ["tools", "systemPrompt", "settings"] as const;

/** 插件 Config（设置页 schema），见 ./config.ts。 */
export { Config };

export default {
  name: "knowself",
  inject,
  apply,
  /**
   * 挂到插件对象上而不仅是 named export：cordis `Plugin.Base.Config`
   * （registry.d.ts:56）从插件形状读取该字段，settings.configure({auto:true})
   * 才有 4 个可展示字段。这是与 05 §3 T04 示例形状的一处有意偏差，见汇报。
   */
  Config,
};
