#!/usr/bin/env node
/**
 * 把 `dsh/knowself` 对齐成「能被官方 dsh CLI 装入」的包形态，并在 `build:dsh` 之后做一次门禁自检。
 *
 * 为什么需要它（MD4-1）：
 *   dsh CLI 装一个插件包时只认包根的三样东西 ——
 *     ① package.json 的 `main` / `exports["."]` 指向**自包含 bundle**（dist/bundle/index.js），
 *        因为领域库 dist 的 ESM import 缺 `.js` 扩展名，纯 Node ESM 加载不了 tsc 产物；
 *     ② `dsh.bundle.patch` 指向包内的 `cordis.patch.yml`（挂载行由它 insert）；
 *     ③ `dependencies` 里只能是**运行时真的要装的东西**（4 个原生/预编译包；sqlite-vec 见 EXPECTED_DEPENDENCIES 注释），
 *        且不能出现 `file:` 协议 —— 消费方 npm 解析不了工作区相对路径。
 *   仓库内开发期的 11 个 `@knowself/*` file: 依赖**全部由 esbuild 内联进 bundle**，
 *   运行时不需要；留在 dependencies 会让 tgz 装上即报错。故本脚本把它们约束在
 *   devDependencies（消费方不装 devDependencies，仓库内仍能 pnpm 链接）。
 *
 * 三件事：
 *   1. 校验（默认）或对齐（`--fix`）package.json 的可发布字段；
 *   2. 落盘 `cordis.patch.yml`（内容为本脚本内置的规范文本，幂等）；
 *   3. 校验 dist 产物存在、且 dependencies 里的原生包 external 未被内联。
 *
 * 用法：
 *   node scripts/build-package.mjs          # 只校验（CI / build:dsh 之后跑）
 *   node scripts/build-package.mjs --fix    # 先把 deviating 字段写回，再校验
 *
 * 退出码：0 全通过；1 有任一失败（失败项逐条打印，不静默）。
 *
 * 约束：不新增依赖、不跑 pnpm/npm install、不联网。只用 node: 内置模块。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_JSON = join(PKG_ROOT, "package.json");
const PATCH_FILE = join(PKG_ROOT, "cordis.patch.yml");
const FIX = process.argv.includes("--fix");

/**
 * 包版本：0.0.0 是占位，CLI 装入/升级需要真实版本号。
 *
 * W-1 起**不再钉死具体值**：四工单要求每单升 patch（0.1.2 / 0.1.3 / 0.1.4），
 * 若这里强制 `0.1.0`，`--fix` 会把升好的版本打回去，构建链与 §3.3 直接冲突。
 * 改为只校验「三段数字 semver」——版本递增由工单负责，门禁只保证格式合法。
 */
const VERSION_FORMAT = /^\d+\.\d+\.\d+$/;
/** 版本非法时 `--fix` 的兜底值（仅此一种情况才会写回 package.json）。 */
const FALLBACK_VERSION = "0.1.0";

/** 入口：**必须**是 esbuild 自包含 bundle，不能是 dist/src/index.js（tsc 产物）。 */
const EXPECTED_MAIN = "dist/bundle/index.js";

/**
 * 打包白名单：只发运行时要用的三样。
 * dist/src/** 是旧 tsc 产物（死代码，且正是「纯 Node ESM 加载无扩展名 import 会失败」的入口），
 * dist/client-bundle/probe*.js 是开发期探针 —— 一并排除，避免消费方误加载。
 */
const EXPECTED_FILES = ["dist/bundle", "dist/client-bundle/client.js", "cordis.patch.yml"];

/** 运行时依赖：恰好 4 个，且全部钉死版本（tgz 消费方装的就是这四个）。
 *
 * 为什么 `sqlite-vec` 必须在这里（0.3.4 回归修复）：
 *   它用 `import.meta.resolve("sqlite-vec-<os>-<arch>/vec0.dll")` 在**包自身位置**
 *   解析平台原生包。若本包不声明它，profile 只装上面 3 个原生包 →
 *   `createContextRouter` 里 `openRetrievalDb()` 抛 ERR_MODULE_NOT_FOUND →
 *   第 3 层（检索/摄入）整层降级 → `POST /write/chat-import` 恒 503。
 *   同时它必须在 esbuild 里 external（见 build-server-bundle.mjs），
 *   否则 import.meta.url 会变成 bundle 路径，解析基准同样漂移。
 */
const EXPECTED_DEPENDENCIES = {
  "@node-rs/jieba": "1.10.4",
  "better-sqlite3": "12.11.1",
  "better-sqlite3-multiple-ciphers": "12.11.1",
  "sqlite-vec": "0.1.10-alpha.4",
};

/** peer 约束由宿主提供，**不得**由本包改（工单红线）。 */
const EXPECTED_PEERS = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-tools",
];

/** cordis.patch.yml 规范文本（与 MD2/MD3 实测通过的 profile patch 同语义）。 */
const PATCH_CONTENT = `# 由 @knowself/dsh-plugin 的 dsh.bundle.patch 指向；name 以本文件所在目录为基准
# （V7 已核实：顶层为 patch-entry 数组，entry.insert 为插入的新行列表；
#   name 是相对**本文件所在目录**的路径，因此这里必须是 ./dist/bundle/index.js，
#   不能用 dist/src/index.js —— 后者是 tsc 产物，纯 Node ESM 无法加载无扩展名 import）
- insert:
    - id: knowself
      name: './dist/bundle/index.js'
`;

/** server bundle 体积下限（与 build-server-bundle.mjs 一致）：external 配错时体积会明显异常。 */
const MIN_SERVER_BUNDLE_BYTES = 5 * 1024 * 1024;

const problems = [];
const fixes = [];

/**
 * 记录一条判定结果。
 * @param {boolean} ok 是否通过
 * @param {string} label 判定项
 * @param {string} [detail] 实测值 / 失败原因
 */
function check(ok, label, detail = "") {
  process.stdout.write(`[build-package] ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}\n`);
  if (!ok) problems.push(label + (detail ? " — " + detail : ""));
  return ok;
}

/**
 * `--fix` 分支：只改**确定性**字段（version / main / exports / dependencies / dsh.bundle），
 * 其余（scripts、devDependencies、pnpm 块、peer）一律不碰。
 * @param {any} pkg 已解析的 package.json
 * @returns {boolean} 是否有改动
 */
function applyFixes(pkg) {
  let changed = false;

  if (typeof pkg.version !== "string" || !VERSION_FORMAT.test(pkg.version)) {
    pkg.version = FALLBACK_VERSION;
    changed = true;
    fixes.push(`version → ${FALLBACK_VERSION}（原值不是合法 semver，兜底）`);
  }

  if (
    pkg.main !== EXPECTED_MAIN ||
    pkg.exports?.["."] !== "./" + EXPECTED_MAIN ||
    pkg.exports?.["./client"]?.default !== "./dist/client-bundle/client.js"
  ) {
    pkg.main = EXPECTED_MAIN;
    pkg.exports = {
      ...(pkg.exports ?? {}),
      ".": "./" + EXPECTED_MAIN,
      "./client": { default: "./dist/client-bundle/client.js" },
    };
    changed = true;
    fixes.push(`main/exports["."] → ${EXPECTED_MAIN}`);
  }

  const deps = pkg.dependencies ?? {};
  const expectedKeys = Object.keys(EXPECTED_DEPENDENCIES);
  const depsExact =
    Object.keys(deps).length === expectedKeys.length &&
    expectedKeys.every((k) => deps[k] === EXPECTED_DEPENDENCIES[k]);
  if (!depsExact) {
    pkg.dependencies = { ...EXPECTED_DEPENDENCIES };
    changed = true;
    fixes.push(`dependencies → ${expectedKeys.join(", ")}`);
  }

  if (pkg.dsh?.bundle?.patch !== "cordis.patch.yml") {
    pkg.dsh = { ...(pkg.dsh ?? {}), bundle: { patch: "cordis.patch.yml" } };
    changed = true;
    fixes.push('dsh.bundle.patch → "cordis.patch.yml"');
  }

  const files = Array.isArray(pkg.files) ? pkg.files : [];
  if (files.length !== EXPECTED_FILES.length || !EXPECTED_FILES.every((f) => files.includes(f))) {
    pkg.files = [...EXPECTED_FILES];
    changed = true;
    fixes.push(`files → ${EXPECTED_FILES.join(" + ")}`);
  }

  return changed;
}

/** 校验 package.json 的可发布字段（纯读，不改）。 */
function assertPackageJson(pkg) {
  check(
    typeof pkg.version === "string" && VERSION_FORMAT.test(pkg.version),
    "version（合法 semver，允许递增）",
    `${pkg.version}`,
  );

  const entryOk =
    pkg.main === EXPECTED_MAIN &&
    pkg.exports?.["."] === "./" + EXPECTED_MAIN &&
    pkg.exports?.["./client"]?.default === "./dist/client-bundle/client.js";
  check(
    entryOk,
    "入口指向自包含 bundle",
    entryOk ? `main=exports["."]=${EXPECTED_MAIN}` : `main=${JSON.stringify(pkg.main)} exports["."]=${JSON.stringify(pkg.exports?.["."])}`,
  );

  // dependencies：恰好 4 键、版本钉死、file: 数量为 0
  const deps = pkg.dependencies ?? {};
  const depsKeys = Object.keys(deps);
  const fileCount = Object.values(deps).filter(
    (v) => typeof v === "string" && v.startsWith("file:"),
  ).length;
  const missing = Object.keys(EXPECTED_DEPENDENCIES).filter((k) => !(k in deps));
  const extra = depsKeys.filter((k) => !(k in EXPECTED_DEPENDENCIES));
  const wrong = Object.keys(EXPECTED_DEPENDENCIES).filter(
    (k) => k in deps && deps[k] !== EXPECTED_DEPENDENCIES[k],
  );
  const depsExact = missing.length === 0 && extra.length === 0 && wrong.length === 0 && fileCount === 0;
  const why = [
    missing.length ? `缺 ${missing.join(",")}` : "",
    extra.length ? `多 ${extra.join(",")}` : "",
    wrong.length ? `版本不符 ${wrong.map((k) => `${k}=${deps[k]}`).join(",")}` : "",
    `file: 依赖 ${fileCount} 个`,
  ]
    .filter(Boolean)
    .join("；");
  check(depsExact, "dependencies 恰好 4 键且 file: = 0", `${depsKeys.length} 键；${why}`);

  const patchDecl = pkg.dsh?.bundle?.patch;
  check(patchDecl === "cordis.patch.yml", "dsh.bundle.patch", JSON.stringify(patchDecl));

  // files 白名单：不声明会整目录打包（带上旧 tsc 产物 + 开发探针）
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const filesOk =
    files.length === EXPECTED_FILES.length && EXPECTED_FILES.every((f) => files.includes(f));
  check(filesOk, "files 白名单只发运行时产物", files.length ? files.join(" + ") : "未声明");

  // peer 名单与数量不得被改动
  const peerKeys = Object.keys(pkg.peerDependencies ?? {});
  const peersOk =
    peerKeys.length === EXPECTED_PEERS.length && EXPECTED_PEERS.every((k) => k in pkg.peerDependencies);
  check(peersOk, "peerDependencies 6 项未被改动", `${peerKeys.length} 项`);

  // UI 扩展声明必须还在（否则客户端 bundle 不会被宿主认领）
  const client = pkg.dsh?.client;
  const clientOk =
    client?.platform === "web" &&
    Array.isArray(client?.inject) &&
    client.inject.length === 4 &&
    Array.isArray(client?.external) &&
    client.external.includes("react");
  check(
    clientOk,
    "dsh.client 声明完整",
    `platform=${client?.platform} inject=${client?.inject?.length ?? 0} 项 external=${(client?.external ?? []).join("+") || "无"}`,
  );

  // 仓库内开发：11 个工作区 file: 依赖必须仍在 devDependencies，否则 pnpm 解析不到 @knowself/*
  const devFileCount = Object.values(pkg.devDependencies ?? {}).filter(
    (v) => typeof v === "string" && v.startsWith("file:"),
  ).length;
  check(devFileCount === 11, "devDependencies 保留 11 个工作区 file: 链接", `${devFileCount} 个`);
}

/** 落盘 cordis.patch.yml：内容幂等，只报告 created / rewritten / unchanged。 */
function ensurePatch() {
  const exists = existsSync(PATCH_FILE);
  const current = exists ? readFileSync(PATCH_FILE, "utf8") : "";
  if (current === PATCH_CONTENT) {
    check(true, "cordis.patch.yml", `unchanged，${Buffer.byteLength(current)} B`);
    return;
  }
  writeFileSync(PATCH_FILE, PATCH_CONTENT, "utf8");
  check(true, "cordis.patch.yml", `${exists ? "rewritten" : "created"}，${Buffer.byteLength(PATCH_CONTENT)} B`);
}

/** 校验 dist 产物：server bundle 体积 + externals 未被内联，client bundle 形态。 */
function assertDist() {
  const serverBundle = join(PKG_ROOT, "dist", "bundle", "index.js");
  if (!existsSync(serverBundle)) {
    check(false, "dist/bundle/index.js 存在", "缺失，先跑 build:server");
    return;
  }
  const size = statSync(serverBundle).size;
  const source = readFileSync(serverBundle, "utf8");
  check(size >= MIN_SERVER_BUNDLE_BYTES, "server bundle 体积", `${size} B ≥ ${MIN_SERVER_BUNDLE_BYTES} B`);

  // external 判定：esbuild 对内联包会消灭「带引号的裸 specifier」；保留即仍是运行时 import。
  // 三个包都是原生 / 预编译二进制，任何一个被内联都会让 .node 定位漂移（V2 实测踩过）。
  for (const pkg of Object.keys(EXPECTED_DEPENDENCIES)) {
    const present = new RegExp(`["']${pkg}["']`).test(source);
    check(present, `external 保留 ${pkg}`, present ? "运行期 import ✓" : "未见于产物（疑似被内联）");
  }

  const clientBundle = join(PKG_ROOT, "dist", "client-bundle", "client.js");
  if (!existsSync(clientBundle)) {
    check(false, "dist/client-bundle/client.js 存在", "缺失，先跑 build:client");
    return;
  }
  const text = readFileSync(clientBundle, "utf8");
  check(
    text.includes("__ModuleLoader__.load"),
    "client bundle 为 __ModuleLoader__ 形态",
    `${statSync(clientBundle).size} B`,
  );
}

function main() {
  process.stdout.write(`[build-package] ${PKG_ROOT}${FIX ? "（--fix）" : "（只校验）"}\n`);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  if (FIX && applyFixes(pkg)) {
    writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
  assertPackageJson(pkg);
  ensurePatch();
  assertDist();

  if (fixes.length) {
    process.stdout.write(`[build-package] 已写回 package.json：${fixes.join("；")}\n`);
  }
  if (problems.length) {
    process.stderr.write(
      `[build-package] FAILED：${problems.length} 项不达标\n` + problems.map((p) => `  - ${p}\n`).join(""),
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[build-package] 全部通过：可发布形态就绪，下一步 npm pack 即可产出可装入的 tgz。\n`,
  );
}

main();
