/**
 * 重建 dsh web 宿主加载的 client bundle（`dist/client-bundle/client.js`）。
 *
 * 背景：`package.json` 的 `exports["./client"].default` 指向
 * `dist/client-bundle/client.js`；dsh web 宿主按该出口加载**预构建**的 client bundle
 * （A2 收口期 12:15 由用户产出）。A2 期旧包不含 B2 的
 * `src/client/rest-data-port.ts` 与三级 `resolveDataPort`，因此只改 `src/client/*.tsx`
 * 而不重打包，运行时仍走 A2 两级逻辑（面板显示「数据桥接待接入」）。
 *
 * 格式来源（如实）：全仓**没有** dsh 官方 / 用户既定的 client bundle 打包脚本或文档命令，
 * 也找不到 `window.__ModuleLoader__` 包装器的生成器；本脚本按现有 A2 期旧包的
 * **精确格式复刻**（已用逐字 diff 验证：未改动模块的输出与旧包完全一致）：
 *   - 首行 `window.__ModuleLoader__.load({ id: "@knowself/dsh-plugin", factory: (require) => { var module = ...; var exports = ...;`
 *   - 末行 `return module.exports; } });`
 *   - 中间是 esbuild `--format=cjs` 输出（自带 `"use strict";`、
 *     `__defProp` / `__export` / `__toCommonJS` 辅助函数、各模块 `// src/client/xxx.ts` 分隔注释）
 *   - `jsx: automatic` → `react` 与 `react/jsx-runtime` 保留为 external `require(...)`
 *   - 非 ASCII 转义为 `\uXXXX`（esbuild `charset: ascii` 默认行为）
 *
 * 运行：`node scripts/build-client-bundle.mjs`（cwd 任意；脚本内部一律用绝对根路径）
 * 依赖：根 workspace 已安装的 `esbuild@0.28.0`（`require.resolve('esbuild')` 可解析），
 *       **不新增 npm 依赖、不改 package.json 依赖版本、不跑 pnpm install**。
 *
 * W1 / T06 加固（05 实施方案 §3 T06）：在原有 11 项正向自检之外，追加
 * sha256 前 12 位指纹 + 反向自检（产物不得含 Node 侧依赖）。
 *
 * 注意：`dist/` 被 `.gitignore` 忽略、属既有产物目录；**每次改动 `src/client/` 下任何源码
 * 后都必须重跑本脚本**，否则宿主仍加载旧 bundle（B2 收口工单 ① 的教训）。
 * 落地 dsh web 环境时仍需按宿主 loader 校验该包装格式（见 README「剩余运行时门控」）。
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

/** 插件根目录（`dsh/knowself/`），所有路径相对它解析。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PLUGIN_ROOT, "src", "client", "index.tsx");
const OUT_FILE = join(PLUGIN_ROOT, "dist", "client-bundle", "client.js");

/** 宿主 loader 包装：与 A2 期旧包首/末行逐字一致。 */
const PREFIX =
  'window.__ModuleLoader__.load({ id: "@knowself/dsh-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;';
const SUFFIX = "return module.exports; } });";

/** esbuild 参数：精确复刻 A2 期旧 bundle 的 CJS 输出形状。 */
async function bundleClientCjs() {
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    write: false, // 只取文本，包装后再一次性落盘
    format: "cjs",
    platform: "browser",
    jsx: "automatic",
    // react / react/jsx-runtime 由宿主提供，保留为 external require（与旧包一致）
    external: ["react", "react/jsx-runtime"],
    charset: "ascii", // 非 ASCII → \uXXXX（旧包形态）
    target: "esnext", // 不降级语法（旧包保留 const / ?? / 可选链）
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (file === undefined) throw new Error("esbuild 未产出任何输出文件");
  return file.text;
}

/** 自检：确保 B2 内容真的进了 bundle，且包装形状未被破坏。 */
function assertBundle(bundled) {
  const required = [
    PREFIX,
    SUFFIX,
    "module.exports = __toCommonJS(index_exports);",
    'require("react/jsx-runtime")',
    'require("react")',
    "/knowself-api",
    "createRestDataPort",
    "personPanelDataPort", // 一级：ctx 注入
    "isPersonPanelBridgeConfigured()", // 二级：显式注册端口
    "// src/client/rest-data-port.ts",
    "// src/client/index.tsx",
    // 2026-11-18：统一入口（人物/画像/待整理/日志/资料 → KnowSelf + tab）必须进包，
    // 否则宿主仍加载五个旧侧栏图标。
    "// src/client/hub-panel.tsx",
    "// src/client/hub-tab.ts",
    "knowself-hub",
  ];
  for (const token of required) {
    if (!bundled.includes(token)) {
      throw new Error(`bundle 自检失败：缺少关键内容 ${JSON.stringify(token)}`);
    }
  }
  // 三级 resolveDataPort：默认分支必须调用 createRestDataPort()
  if (!/createRestDataPort\(\)/.test(bundled)) {
    throw new Error("bundle 自检失败：resolveDataPort 默认分支未调用 createRestDataPort()");
  }
}

/**
 * 反向自检：防止误把 Node 侧依赖打进浏览器 bundle（05 §3 T06 / §4 坑 3）。
 *
 * W1 施工前实测基线（`dist/client-bundle/client.js`，19,177 B）：
 *   - `node:fs`        → 0 命中 → 可作裸子串硬禁
 *   - `process.env`    → 0 命中 → 可作裸子串硬禁
 *   - `better-sqlite3` → **1 命中**，但纯属 UI 空态展示文案
 *     「浏览器面板无法直连 person-store（better-sqlite3 为 Node 原生模块）」，
 *     **并非模块引用**。若直接硬禁裸子串会误伤，导致 build 失败。
 *
 * 因此对 `better-sqlite3` 只禁「真实模块引用形态」（require("…") / from "…" /
 * import("…") 的 specifier），并把裸 token 命中数显式打印出来便于复核。
 * react / react/jsx-runtime 是宿主提供的合法 external，不在禁用清单内。
 *
 * @param {string} bundled 包装后的完整产物文本
 */
const FORBIDDEN_PLAIN_TOKENS = ["node:fs", "process.env"];
const NODE_MODULE_REF_RE =
  /(?:require\s*\(\s*|from\s+|import\s*\(?\s*)["'][^"']*(?:better-sqlite3|better-sqlite3-multiple-ciphers|node:fs|node:path|node:crypto|onnxruntime-node|@node-rs\/jieba|koffi)["']/;

function assertNoNodeDeps(bundled) {
  for (const token of FORBIDDEN_PLAIN_TOKENS) {
    if (bundled.includes(token)) {
      throw new Error(
        `bundle 反向自检失败：产物含 Node 侧 token ${JSON.stringify(token)}`,
      );
    }
  }
  const ref = NODE_MODULE_REF_RE.exec(bundled);
  if (ref !== null) {
    throw new Error(
      `bundle 反向自检失败：产物含 Node 原生模块引用 ${JSON.stringify(ref[0])}`,
    );
  }
  const cosmeticHits = bundled.split("better-sqlite3").length - 1;
  process.stdout.write(
    `[build-client-bundle] 反向自检通过：node:fs / process.env 均 0 命中；` +
      `better-sqlite3 裸串 ${cosmeticHits} 处（仅 UI 展示文案，非模块引用，已放行）；` +
      `无任何 Node 原生模块 require/from/import 引用。\n`,
  );
}

async function main() {
  const cjs = await bundleClientCjs();
  const bundled = `${PREFIX}\n${cjs.trimEnd()}\n${SUFFIX}\n`;
  assertBundle(bundled);
  assertNoNodeDeps(bundled);
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, bundled, "utf8");
  const sha256 = createHash("sha256").update(bundled, "utf8").digest("hex");
  process.stdout.write(
    `[build-client-bundle] wrote ${OUT_FILE} (${Buffer.byteLength(bundled, "utf8")} bytes); ` +
      `esbuild ${require("esbuild").version}; sha256=${sha256.slice(0, 12)}; ` +
      `B2 REST port + 三级 resolveDataPort present.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[build-client-bundle] FAILED: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
