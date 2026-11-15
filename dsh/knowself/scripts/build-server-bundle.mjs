/**
 * 重建 dsh 宿主经 knowself.patch.yml 加载的 server bundle
 * （`dist/bundle/index.js`；patch 中 `name: './dist/bundle/index.js'` 依赖此路径）。
 *
 * 背景：`dist/bundle/index.js`（约 15 MB）此前存在，但仓库内没有生成脚本；
 * `dist/` 被根 `.gitignore` 忽略 → 干净克隆后宿主必然加载失败（M0 缺陷）。
 *
 * 关键约束（05 实施方案 §3 T01 / §11 V2，04 详细设计 §6.2）：
 *   1. 领域库 dist 的 ESM import 缺 `.js` 扩展名，纯 Node ESM 无法直接加载，
 *      必须 esbuild 打成自包含 bundle（esbuild 能解析无扩展名 import）。
 *   2. 原生模块必须 external：`better-sqlite3` 与 `better-sqlite3-multiple-ciphers`
 *      内部都用 bindings() 定位 `.node`；打进 bundle 会让 `.node` 查找基准漂移 →
 *      ERR_DLOPEN_FAILED（V2 已实测踩过）。
 *   3. ESM 输出需要 CJS 互操作 banner（archiver 用 require、tesseract 用 __dirname）。
 *
 * 运行：`node scripts/build-server-bundle.mjs`（cwd 任意；路径全部由 import.meta.url 推导）
 * 依赖：根 workspace 的 `esbuild@0.28.0`，经 `createRequire(import.meta.url)` 解析
 *      （插件顶层无 esbuild bin；与 build-client-bundle.mjs 完全同一模式）。
 *      不新增依赖、不改 package.json 依赖版本、不跑 pnpm install。
 */
import { createRequire, builtinModules } from "node:module";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build, version } = require("esbuild");

/** 插件根目录（`dsh/knowself/`），所有路径相对它解析。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PLUGIN_ROOT, "src", "index.ts");
const OUT_FILE = join(PLUGIN_ROOT, "dist", "bundle", "index.js");
const BRIDGE_SOURCE = join(PLUGIN_ROOT, "src", "wechat-uia-bridge.py");
const BRIDGE_OUT = join(PLUGIN_ROOT, "dist", "bundle", "wechat-uia-bridge.py");

/** 体积下限：external 配错（把 node_modules 全打进去 / 或反过来漏打）时体积会明显异常。 */
const MIN_SIZE_BYTES = 5 * 1024 * 1024;

/** CJS 互操作 banner：ESM 输出里补回 require / __filename / __dirname。 */
const BANNER = [
  'import { createRequire } from "module";',
  'import { fileURLToPath as __f } from "url";',
  'import { dirname as __d } from "path";',
  'const require = createRequire(import.meta.url);',
  'const __filename = __f(import.meta.url);',
  'const __dirname = __d(__filename);',
].join(" ");

/**
 * 由宿主 / 系统提供、必须保留为运行时 import 的包。
 *
 * **列表即契约**（0.3.5 起）：这里每一项都必须同时满足
 *   ① 产物里真的存在该裸 specifier（`dependencies` 里的包由 build-package.mjs 反向校验）；
 *   ② 若不属于 `@deepseek-ai/*`（宿主提供），则必须在 package.json 的 `dependencies`
 *      里钉死版本，否则干净安装（tgz → profile）时必然 ERR_MODULE_NOT_FOUND。
 * ② 由本文件末尾 `assertRuntimeImports()` 用 esbuild metafile 逐项硬校验。
 *
 * 0.3.5 清理：删掉 `onnxruntime-node`、`koffi` 两条**死配置**——
 *   `context-router/src/embedding.ts` 的向量嵌入已改为本机 Ollama HTTP
 *   （"原 @xenova/transformers + Xenova/bge-small-zh-v1.5 方案作废"），
 *   `packages/ingestion` 也不再走 koffi 系 OCR 绑定；产物里两者的裸 specifier
 *   命中数为 0，源码引用数为 0。留着它们会诱导出「给不存在的 import 声明依赖」
 *   这种更难查的错误（装了 50MB 用不到的原生二进制，版本还得靠猜）。
 */
const EXTERNALS = [
  "@deepseek-ai/*", // 宿主提供（cordis / dsh-tools / dsh-system-prompt / ...）
  "better-sqlite3", // 原生模块（context-router 用）
  "better-sqlite3-multiple-ciphers", // 原生模块（person-store 用，**不能漏**，V2）
  // sqlite-vec（0.3.4 修复）：**必须 external**。
  // 该包用 `import.meta.resolve("sqlite-vec-<os>-<arch>/vec0.dll")` 在**自身文件位置**
  // 解析平台原生包（见 node_modules/sqlite-vec/index.mjs:39）。一旦被 esbuild 内联，
  // import.meta.url 变成 bundle 路径，平台包便只能从「bundle 所在目录向上」查找 ——
  // 装进 profile（只剩 tgz 声明的 4 个依赖）后必然 ERR_MODULE_NOT_FOUND，
  // 导致 createContextRouter 抛错 → 检索/摄入整层降级 → chat-import 503。
  "sqlite-vec",
  "@node-rs/jieba", // 原生模块（context-router 分词）
];

/**
 * 允许「产物里有、但不声明依赖」的**可选**运行时 import（必须逐条给出证据）。
 *
 * 准入条件（三条全中才可入表）：
 *   ① 调用点自带 try/catch（或 `?.` / 空值兜底），包缺失时**不抛穿透**；
 *   ② 只影响非关键能力，缺包时行为退化为「不转换 / 不用该特性」；
 *   ③ 不涉及原生二进制定位（原生二进制的 .node/.dll 定位漂移必须靠 dependencies 修，
 *      参见 0.3.3 的 sqlite-vec 回归）。
 *
 * 任何**未入表**的未声明 import 依旧硬失败 —— 这张表是白名单，不是豁免开关。
 */
const OPTIONAL_RUNTIME_IMPORTS = new Map([
  [
    "encoding",
    "node-fetch@2 的可选依赖：产物内调用点为 `try { convert = __require(\"encoding\").convert } catch {}`，" +
      "仅在解码非 UTF-8 响应体时用到；本插件所有 HTTP 交互都是 UTF-8 的 JSON/文本，缺包只退化不解码。",
  ],
]);

/** 宿主提供的包前缀：运行时由 dsh 宿主解析，不进本包 dependencies。 */
const HOST_PROVIDED_PREFIXES = ["@deepseek-ai/"];

/**
 * Node 内置模块集合（同时收录 `fs` 与 `node:fs` 两种写法）。
 * esbuild metafile 会原样保留源码里的写法，且 `punycode` 这类「已废弃但仍是内置」的
 * 模块也在列表中 —— 它们由运行时提供，不需要也不允许进 dependencies。
 */
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`, name.replace(/^node:/, "")]),
);

/**
 * 产物自检（04 §6.2）：体积 / B2 REST 桥 / CJS banner / sqlite 原生包 external 生效。
 *
 * 关于 external specifier 的判定：esbuild 对 external 包一定保留「带引号的裸
 * specifier」作为模块路径；若被内联则该字符串消失（只剩 bindings() 等内联代码）。
 * 因此用 `["']<pkg>["']` 判断，避免依赖 `from "x"` / `require("x")` 的具体形态。
 * 两个包全部缺失才判失败；缺一个只打印可见性告警（不同 esbuild 版本输出形态可能不同）。
 *
 * @param {string} source bundle 文本
 * @param {number} size 产物字节数
 */
function assertBundle(source, size) {
  if (size < MIN_SIZE_BYTES) {
    throw new Error(
      `bundle 过小（${size} < ${MIN_SIZE_BYTES}），疑似 external 配置错误`,
    );
  }
  const required = [
    ["B2 REST 桥", "knowself-api"],
    ["CJS 互操作 banner", "createRequire(import.meta.url)"],
  ];
  for (const [label, token] of required) {
    if (!source.includes(token)) {
      throw new Error(`bundle 自检失败：缺少 ${label} → ${JSON.stringify(token)}`);
    }
  }

  const specifiers = ["better-sqlite3", "better-sqlite3-multiple-ciphers", "sqlite-vec"].map(
    (pkg) => ({
      pkg,
      present: new RegExp(`["']${pkg}["']`).test(source),
    }),
  );
  for (const item of specifiers) {
    process.stdout.write(
      `[build-server-bundle] external specifier ${item.pkg}: ` +
        `${item.present ? "保留为运行时 import ✓" : "未见于产物 ⚠"}\n`,
    );
  }
  if (specifiers.every((item) => !item.present)) {
    throw new Error(
      "bundle 自检失败：sqlite 原生包的 specifier 全部缺失，疑似 external 未生效/被内联",
    );
  }
  // 0.3.4 回归门禁：`sqlite-vec` 被内联会让平台 .dll 解析基准漂移到 bundle 目录
  // （见 EXTERNALS 注释）。装进 profile 后 chat-import 必然 503，故这一条必须硬失败。
  const sqliteVec = specifiers.find((item) => item.pkg === "sqlite-vec");
  if (sqliteVec !== undefined && !sqliteVec.present) {
    throw new Error(
      "bundle 自检失败：sqlite-vec 被内联进 bundle。平台包 sqlite-vec-<os>-<arch> " +
        "将无法解析（import.meta.resolve 基准变成 bundle 路径），装进 profile 后 " +
        "createContextRouter 会抛 ERR_MODULE_NOT_FOUND → chat-import 503。",
    );
  }
}

/**
 * 运行时 import 审计（0.3.5 新增，防 0.3.3 那类回归的**结构性**门禁）。
 *
 * 不变量：产物里**每一个残存的裸 specifier**，要么由宿主提供（`@deepseek-ai/*`），
 * 要么在 `package.json` 的 `dependencies` 里钉死版本。
 *
 * 为什么必须用 metafile 而不是扫文本：esbuild 的 metafile 记录的是**真实的**
 * external import 边，不会被注释 / 模板串 / 正则字面量里的同名文本误命中。
 *
 * 这条门禁同时堵住两个方向：
 *   - 漏声明（0.3.3 的 bug）：sqlite-vec 在产物里但不在 dependencies → 干净安装必挂；
 *   - 多声明 / 死配置：某包在 dependencies 却不在产物里 → 由 build-package.mjs 反向校验。
 *
 * @param {import("esbuild").Metafile} metafile esbuild 构建元数据
 * @param {string} outFile 产物绝对路径
 * @param {Record<string, string>} dependencies package.json 的 dependencies
 */
function assertRuntimeImports(metafile, outFile, dependencies) {
  // metafile 的 outputs 键是相对 absWorkingDir 的路径（如 "dist/bundle/index.js"），
  // 因此两边都归一化成绝对路径再比较，避免因键形态不同而误报「找不到产物」。
  const target = resolve(outFile).replace(/\\/g, "/").toLowerCase();
  const key = Object.keys(metafile.outputs).find(
    (k) => resolve(PLUGIN_ROOT, k).replace(/\\/g, "/").toLowerCase() === target,
  );
  if (key === undefined) {
    throw new Error(`运行时 import 审计失败：metafile 里找不到产物 ${outFile}`);
  }
  const imports = metafile.outputs[key].imports ?? [];
  const specifiers = [...new Set(imports.filter((i) => i.external).map((i) => i.path))].sort();

  const problems = [];
  for (const spec of specifiers) {
    const builtin = NODE_BUILTINS.has(spec);
    const host = HOST_PROVIDED_PREFIXES.some((p) => spec.startsWith(p));
    const declared = Object.prototype.hasOwnProperty.call(dependencies, spec);
    const optional = OPTIONAL_RUNTIME_IMPORTS.has(spec);
    const where = builtin
      ? "Node 内置"
      : host
        ? "宿主提供"
        : declared
          ? `dependencies@${dependencies[spec]}`
          : optional
            ? "可选（try/catch 守卫，见 OPTIONAL_RUNTIME_IMPORTS）"
            : "❌ 未声明";
    process.stdout.write(`[build-server-bundle] 运行时 import ${spec} → ${where}\n`);
    if (!builtin && !host && !declared && !optional) problems.push(spec);
  }

  if (problems.length > 0) {
    throw new Error(
      "运行时 import 审计失败：下列包在产物里是运行时 import，却既不是 @deepseek-ai/* " +
        `（宿主提供）也没在 package.json 的 dependencies 里声明 → ${problems.join(", ")}。\n` +
        "干净安装（tgz → profile）后这些 import 会抛 ERR_MODULE_NOT_FOUND，典型后果是" +
        "第 3 层（检索/摄入）整层降级、chat-import 恒 503（0.3.3 回归）。\n" +
        "修法：① 若源码确实要用 → 在 dependencies 里钉死版本；② 若已不再使用 → 从 EXTERNALS 删除，别留死配置。",
    );
  }
}

async function main() {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  copyFileSync(BRIDGE_SOURCE, BRIDGE_OUT);
  const dependencies = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"))
    .dependencies ?? {};
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: EXTERNALS,
    banner: { js: BANNER },
    charset: "utf8",
    logLevel: "info",
    metafile: true,
  });

  const size = statSync(OUT_FILE).size;
  const source = readFileSync(OUT_FILE, "utf8");
  assertBundle(source, size);
  assertRuntimeImports(result.metafile, OUT_FILE, dependencies);
  process.stdout.write(
    `[build-server-bundle] ${OUT_FILE} ${size} bytes, esbuild ${version}; ` +
      `knowself-api + CJS banner + JSONL bridge + 运行时 import 审计通过。\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[build-server-bundle] FAILED: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
