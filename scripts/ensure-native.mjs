/**
 * `ensure-native.mjs` —— 原生模块「版本层 + 功能层」自检与自修复（W-8/B2）。
 *
 * ## 为什么需要它
 * 这台机器上反复出现两类"看起来像代码坏了"的故障：
 *   ① **Node 版本与仓库声明不符**（`.nvmrc` 写 20，实际跑 22/24）→ 原生模块加载失败，
 *      报错是 `NODE_MODULE_VERSION 137 vs 127`，对不熟悉 ABI 的人等于天书；
 *   ② **原生模块没为当前 Node 重编**（`npm rebuild` 被跳过）→ 同上。
 * 两者症状一样、处置一样（换 Node 或重编），但都需要"先看懂"。本脚本把这件事
 * 变成一句中文 + 一个 `--fix`。
 *
 * ## 三层判据（顺序固定）
 *   1. **声明自洽**：`.nvmrc` 的大版本 == `engines.node` 的下界大版本（只改一个就自相矛盾）；
 *   2. **声明 vs 运行时**：`process.version` 的大版本 == 声明的大版本；
 *   3. **功能自检**：每个 SQLite 驱动各 `open(':memory:')` + `SELECT 1`（**不信 ABI 数字，信能不能干活**）。
 *
 * ## `--check` 与 `--fix`
 *   - `--check`（默认）**只读**：不写 node_modules、不 rebuild，只报告；
 *   - `--fix` 进**目标包目录**跑 bare `npm rebuild`。
 *     ⚠ 绝不能在仓库根跑 `npm rebuild <pkg>`：那会走 node-gyp 源码编译，
 *     先清空 `build/` 再失败——实测把失败数从 4 推到 226。
 *
 * ## 输出约束
 * 任何用户可见的失败文案**不得出现 `NODE_MODULE_VERSION` 字面**（那是编译期术语，
 * 用户看不懂也不需要看），统一替换成「与当前 Node 的编译目标不一致」。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件在 `<root>/scripts/` 下）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 需要自检的原生 SQLite 驱动。 */
export const NATIVE_PACKAGES = ["better-sqlite3", "better-sqlite3-multiple-ciphers"];

const here = createRequire(import.meta.url);

/**
 * 读 `.nvmrc`（纯文本版本号）。
 * @param {string} root 仓库根
 * @returns {string | null}
 */
export function readNvmrc(root = REPO_ROOT) {
  try {
    const raw = readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/i, "");
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/**
 * 读 `package.json` 的 `engines.node`。
 * @param {string} root 仓库根
 * @returns {string | null}
 */
export function readEnginesNode(root = REPO_ROOT) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const value = pkg?.engines?.node;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 从版本/范围字符串里取"期望的主版本"。
 *
 * 只认本项目实际用到的两种写法：`24.14.1`（.nvmrc）与 `>=24 <25`（engines）。
 * 取不到就返回 null —— 宁可跳过版本检查，也不要瞎猜（猜错会给出错误指引）。
 *
 * @param {string | null} value 版本或范围
 * @returns {number | null}
 */
export function majorOf(value) {
  if (value === null || value === undefined) return null;
  const match = value.match(/(\d+)(?:\.\d+)*/);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

/** 把底层报错压成一句中文（**必须**抹掉 `NODE_MODULE_VERSION` 这类术语）。 */
function friendlyNativeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/NODE_MODULE_VERSION|different Node\.js version|ERR_DLOPEN/i.test(raw)) {
    return "与当前 Node 的编译目标不一致（需要用当前 Node 重编）";
  }
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(raw)) {
    return "模块不存在（依赖没装全）";
  }
  if (/file is not a database|not a database|SQLITE_NOTADB/i.test(raw)) {
    return "库文件无法打开（格式/加密驱动不匹配）";
  }
  return raw.split("\n")[0].slice(0, 200);
}

/**
 * 功能层自检单个驱动：`open(':memory:')` + `SELECT 1`。
 *
 * 为什么不用 `process.versions.modules === 137` 这类断言：ABI 数字是手段不是目的，
 * 真正要保证的是"能不能干活"。数字对但加载失败的情况真实存在（版本分裂那次）。
 *
 * @param {string} dir 包目录
 * @returns {{ ok: boolean, version: string | null, error: string | null }}
 */
function probePackage(dir) {
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    /* 版本读不到不影响功能自检 */
  }
  try {
    const Database = here(dir);
    const db = new Database(":memory:");
    try {
      const row = db.prepare("SELECT 1 AS ok").get();
      if (row?.ok !== 1) return { ok: false, version, error: "SELECT 1 返回值异常" };
    } finally {
      db.close();
    }
    return { ok: true, version, error: null };
  } catch (error) {
    return { ok: false, version, error: friendlyNativeError(error) };
  }
}

/** 收集"真正会被加载"的驱动目录（解析路径，不是目录列表）。 */
function liveTargets(root) {
  const targets = [];
  const push = (label, dir) => {
    if (dir === null || targets.some((t) => t.path === dir)) return;
    targets.push({ label, path: dir });
  };
  for (const name of NATIVE_PACKAGES) {
    // 仓库侧：解析到**包根目录**（`<name>/package.json`），而不是 main 文件，
    // 否则读不到版本号、也没法在同目录跑 `npm rebuild`
    try {
      push(`repo:${name}`, dirname(here.resolve(`${name}/package.json`, { paths: [root] })));
    } catch {
      /* 仓库侧没装就不检 */
    }
    // 插件侧（pnpm workspace，内部链接到 .pnpm/<pkg>@<ver>/node_modules/<pkg>）
    const pluginRoot = join(root, "dsh", "knowself");
    if (existsSync(join(pluginRoot, "package.json"))) {
      try {
        const pluginRequire = createRequire(join(pluginRoot, "package.json"));
        push(`plugin:${name}`, dirname(pluginRequire.resolve(`${name}/package.json`)));
      } catch {
        /* 插件侧没装就不检 */
      }
    }
  }
  return targets.map((t) => {
    let real = t.path;
    try {
      real = realpathSync(t.path);
    } catch {
      /* 保留原路径 */
    }
    return { ...t, real };
  });
}

/**
 * 扫 `.pnpm` 里**同名但不同版本**的残留副本。
 *
 * 这不是要修的错，而是要在报告里喊一声：ISS-009 的根因就是"同一棵树两个大版本"，
 * 而且当时排除矩阵里"两个版本都试过"是假的（`require` 命中的永远是旧副本）。
 * 留一个显式的告警，比事后靠人回忆强。
 *
 * @param {string} root 仓库根
 * @returns {{ name: string, version: string, dir: string }[]}
 */
export function scanStaleCopies(root = REPO_ROOT) {
  const storeDir = join(root, "dsh", "knowself", "node_modules", ".pnpm");
  if (!existsSync(storeDir)) return [];
  const live = new Map();
  for (const target of liveTargets(root)) {
    const name = target.real.split(/[\\/]/).filter(Boolean).pop() ?? "";
    live.set(name, target.real);
  }
  const stale = [];
  for (const entry of readdirSync(storeDir)) {
    const match = entry.match(/^((?:@[^@]+\/)?[^@]+)@(\d[^_]*)/);
    if (!match) continue;
    const [, name, version] = match;
    if (!NATIVE_PACKAGES.includes(name)) continue;
    const pkgDir = join(storeDir, entry, "node_modules", name);
    if (!existsSync(pkgDir)) continue;
    const liveDir = live.get(name);
    if (liveDir === undefined) continue;
    if (realpathSync(pkgDir) === realpathSync(liveDir)) continue;
    stale.push({ name, version, dir: pkgDir });
  }
  return stale;
}

/**
 * 全量自检（**只读**；`vitest` 的 globalSetup 与 `--check` 共用这一个函数）。
 *
 * @param {{ root?: string, nodeVersion?: string }} [opts]
 *   `nodeVersion` 仅测试用：注入"假想的运行时版本"以验证版本层判据。
 * @returns {{
 *   ok: boolean,
 *   message: string | null,
 *   node: { version: string, major: number | null },
 *   declared: { nvmrc: string | null, engines: string | null, expectMajor: number | null, consistent: boolean },
 *   natives: { label: string, path: string, version: string | null, ok: boolean, error: string | null }[],
 *   stale: { name: string, version: string, dir: string }[],
 * }}
 */
export function checkEnv(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const version = opts.nodeVersion ?? process.version;
  const major = majorOf(version);
  const nvmrc = readNvmrc(root);
  const engines = readEnginesNode(root);
  const nvmrcMajor = majorOf(nvmrc);
  const enginesMajor = majorOf(engines);
  const expectMajor = nvmrcMajor ?? enginesMajor;
  const consistent = nvmrcMajor === null || enginesMajor === null || nvmrcMajor === enginesMajor;

  const natives = liveTargets(root).map((target) => {
    const probe = probePackage(target.path);
    return { label: target.label, path: target.real, ...probe };
  });
  const stale = scanStaleCopies(root);

  const base = {
    node: { version, major },
    declared: { nvmrc, engines, expectMajor, consistent },
    natives,
    stale,
  };

  // ① 声明自洽：只改一个就会出现"两个文件各说一套"
  if (!consistent) {
    return {
      ...base,
      ok: false,
      message:
        `仓库声明的 Node 大版本自相矛盾：.nvmrc=${nvmrc ?? "(无)"}、engines.node=${engines ?? "(无)"}。` +
        ` 处置：把 .nvmrc 与 package.json 的 engines.node 同时改成同一个大版本` +
        `（例如 .nvmrc=24.14.1 与 engines.node=">=24 <25"），只改一个必然互相打架。`,
    };
  }
  // ② 声明 vs 运行时
  if (expectMajor !== null && major !== null && major !== expectMajor) {
    return {
      ...base,
      ok: false,
      // 文案三要素（主理人定）：① 当前跑的是什么 ② 仓库要的是什么 ③ **怎么切**。
      // "请切换到匹配的 Node"这种话等于没说——要给出可以直接照抄的命令。
      message:
        `当前 Node ${version}，但仓库要求 ${expectMajor}.x` +
        `（.nvmrc=${nvmrc ?? "(无)"}、engines.node=${engines ?? "(无)"}）。` +
        `处置：在仓库根执行 nvm use（读取 .nvmrc=${nvmrc ?? "-"}），` +
        `本机没有该版本时先 nvm install ${nvmrc ?? `${expectMajor}`}；切完重跑本命令确认。`,
    };
  }
  // ③ 功能层
  const broken = natives.filter((n) => !n.ok);
  if (broken.length > 0) {
    return {
      ...base,
      ok: false,
      message:
        `原生模块无法在当前 Node（${version}）下使用：` +
        broken.map((n) => `${n.label}（${n.error}）`).join("；") +
        `。处置：node scripts/ensure-native.mjs --fix`,
    };
  }
  return { ...base, ok: true, message: null };
}

/**
 * 找 npm 的 cli 入口。优先用**当前 node 同目录**下的 npm（保证重编目标正确），
 * 其次用仓库约定路径，最后交给 PATH 上的 `npm`。
 *
 * @returns {{ command: string, args: string[] }}
 */
function npmCommand() {
  const fromEnv = process.env.KNOWSELF_NPM_CLI;
  const candidates = [
    fromEnv,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    "C:/Stwe/nvm/nodejs/node_modules/npm/bin/npm-cli.js",
  ].filter((value) => typeof value === "string" && value !== "");
  for (const cli of candidates) {
    if (existsSync(cli)) return { command: process.execPath, args: [cli] };
  }
  return { command: "npm", args: [] };
}

/**
 * 就地重编：**必须在包目录内**跑 bare `npm rebuild`。
 *
 * ⚠ 已知局限（实测踩过）：`npm rebuild` 走 prebuild-install 下载预编译产物。
 * 如果**该版本早于当前 Node**（例如 `better-sqlite3@11` 早于 Node 24），
 * 没有对应产物时它会"成功退出"却留下一个**不可用**的二进制
 * （实测：重编后文件日期变成预编译包里的日期，加载仍失败）。
 * 所以这里**重编后立刻复检**，把"成功退出"和"真的能用"分开说。
 *
 * @param {string} dir 包目录（`.../node_modules/<pkg>`）
 * @returns {{ ok: boolean, usable: boolean, output: string }}
 */
export function rebuildPackage(dir) {
  const { command, args } = npmCommand();
  // ⚠ 本机（WorkBuddy 受管环境）会**全局注入** `ELECTRON_RUN_AS_NODE=1` 与 `NODE_OPTIONS`。
  // prebuild-install 据此会去取 **Electron** 的预编译产物（实测拿到 ABI 127 的包），
  // 于是"npm rebuild 成功"却装了个对当前 Node 无用的二进制。
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.npm_config_runtime;
  delete env.npm_config_target;
  env.npm_config_runtime = "node";

  const errors = [];

  // 首选：直接用 prebuild-install，并**显式**指定 target —— 这是唯一可靠的一条。
  //
  // 为什么要显式给 `--target`：`npm rebuild` 里 prebuild-install 自己推断 ABI 时会被
  // 上面那些环境变量带偏（实测推到 127）；显式传 `--target=<当前 node 版本>` 后
  // node-abi 一定算出 137，缓存/下载都命中正确的那份（W-11 实测由失败转为成功）。
  const prebuildBin = findPrebuildInstall(dir);
  if (prebuildBin !== null) {
    try {
      execFileSync(
        process.execPath,
        [prebuildBin, "--runtime=node", `--target=${process.versions.node}`, "--verbose"],
        { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
      );
      if (probePackage(dir).ok) return { ok: true, usable: true, output: "prebuild-install --target 命中" };
      errors.push("prebuild-install 完成但产物仍不可用");
    } catch (error) {
      errors.push(
        error instanceof Error
          ? String(error.stderr ?? error.message).split("\n").slice(-2).join(" ")
          : String(error),
      );
    }
  }

  // 兜底：bare `npm rebuild`（仍走 prebuild-install，但没有显式 target）
  try {
    execFileSync(command, [...args, "rebuild"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const usable = probePackage(dir).ok;
    return {
      ok: true,
      usable,
      output: usable ? "npm rebuild 命中" : `npm rebuild 完成但产物仍不可用；此前：${errors.join("；")}`,
    };
  } catch (error) {
    errors.push(
      error instanceof Error
        ? String(error.stderr ?? error.message).split("\n").slice(-3).join(" ")
        : String(error),
    );
    return { ok: false, usable: false, output: errors.join("；") };
  }
}

/**
 * 在目标包内定位 `prebuild-install` 的入口（它是这些原生包的依赖）。
 * @param {string} dir 包目录
 * @returns {string | null}
 */
function findPrebuildInstall(dir) {
  try {
    return createRequire(join(dir, "package.json")).resolve("prebuild-install/bin.js");
  } catch {
    return null;
  }
}

/**
 * `--fix`：对**当前失败**的目标逐个重编（成功的跳过，避免无谓的 30 秒）。
 * @param {string} [root] 仓库根
 * @returns {number} 退出码
 */
/**
 * 预编译缓存目录（prebuild-install 的落地处）。
 *
 * 允许用 `KNOWSELF_PREBUILD_CACHE` 覆盖：**测试要能指向一个临时目录**，
 * 否则验证删除逻辑就得动真实缓存（那是整台机器共用的，删错会影响别的项目）。
 *
 * @returns {string}
 */
function prebuildCacheDir() {
  const override = process.env.KNOWSELF_PREBUILD_CACHE;
  if (override !== undefined && override !== "") return override;
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? "";
  return join(base, "npm-cache", "_prebuilds");
}

/**
 * 列出缓存里**与该包同名**的条目（只认文件名里带 `-<包名>-v` 的那种）。
 *
 * 为什么要按包名筛：`_prebuilds` 是整机共用的，`sharp`、`sqlite3` 等项目也在用。
 * 一次 `--purge-cache` 把别人项目的包一起删掉，属于"修好自己、弄坏别人"。
 *
 * @param {string} cacheDir 缓存目录
 * @param {string[]} names 包名
 * @returns {{ path: string, size: number }[]}
 */
export function listPrebuildCacheEntries(cacheDir, names) {
  if (!existsSync(cacheDir)) return [];
  const wanted = new Set(names);
  const out = [];
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    // 文件名形如 `<hash>-<name>-v<ver>-node-v<abi>-<platform>-<arch>.tar.gz`
    const hit = names.find((name) => entry.name.includes(`-${name}-v`));
    if (hit === undefined || !wanted.has(hit)) continue;
    const full = join(cacheDir, entry.name);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      /* 读不到大小就当 0，不影响列出与删除 */
    }
    out.push({ path: full, size });
  }
  return out;
}

/**
 * 打印（可选删除）缓存条目。
 *
 * @param {{ path: string, size: number }[]} entries 缓存条目
 * @param {{ yes: boolean }} opts `yes=false` 时只打印
 * @returns {number} 实际删除的字节数
 */
export function purgePrebuildCache(entries, opts) {
  if (entries.length === 0) {
    console.log("[ensure-native] 缓存里没有与这些包同名的条目，无需清理。");
    return 0;
  }
  // 只删「ABI 与本机不同」的条目，保留当前 ABI 的那份。
  // 理由：当前 ABI 的包正是重编要用的（留着就不必联网重下）；
  // 而 ABI 不同的那些恰恰是"静默装错"的来源，删掉它们降低再次踩坑的概率。
  const abiTag = `-node-v${process.versions.modules}-`;
  const doomed = entries.filter((entry) => !entry.path.includes(abiTag));
  const kept = entries.filter((entry) => entry.path.includes(abiTag));
  if (kept.length > 0) {
    console.log(`[ensure-native] 保留 ${kept.length} 个与当前 ABI 匹配的条目（不删，重编要用）：`);
    for (const entry of kept) console.log(`  = ${entry.path}`);
  }
  if (doomed.length === 0) {
    console.log("[ensure-native] 其余条目都与当前 ABI 匹配，无需清理。");
    return 0;
  }
  const total = doomed.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`[ensure-native] 将清理 ${doomed.length} 个 ABI 不匹配的缓存条目（合计 ${(total / 1048576).toFixed(1)} MB）：`);
  for (const entry of doomed) {
    console.log(`  ${opts.yes ? "-" : "·"} ${entry.path}  ${(entry.size / 1024).toFixed(0)} KB`);
  }
  entries = doomed;
  if (!opts.yes) {
    console.log("[ensure-native] 这是**预演**：加 --yes 才会真的删除。");
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      unlinkSync(entry.path);
      removed += entry.size;
    } catch {
      console.log(`  ! 删除失败（跳过）：${entry.path}`);
    }
  }
  console.log(`[ensure-native] 已删除 ${(removed / 1048576).toFixed(1)} MB。`);
  return removed;
}

/**
 * `--fix`：对**当前失败**的目标逐个重编（成功的跳过，避免无谓的 30 秒）。
 *
 * @param {string} [root] 仓库根
 * @param {{ purgeCache?: boolean, yes?: boolean }} [opts]
 *   `purgeCache` 先按包名清预编译缓存（只删同名条目，不碰别人的项目）；
 *   `yes=false` 时只打印将删路径与大小。
 * @returns {number} 退出码
 */
export function fixNative(root = REPO_ROOT, opts = {}) {
  const before = checkEnv({ root });
  const broken = before.natives.filter((native) => !native.ok);

  if (opts.purgeCache === true) {
    // 有坏的就只清"坏的那几个包"；没有坏的（单纯想清缓存）就清全部自检包名。
    // 包名从解析路径里取（目录名就是包名），因此不会误伤 `sharp` 这类别人的项目。
    const names =
      broken.length > 0
        ? [...new Set(broken.map((native) => native.path.split(/[\\/]/).filter(Boolean).pop()))]
        : [...NATIVE_PACKAGES];
    purgePrebuildCache(listPrebuildCacheEntries(prebuildCacheDir(), names), {
      yes: opts.yes === true,
    });
    if (opts.yes !== true) {
      // 预演模式下**不做重建**：否则"我还没同意删，它已经改了 node_modules"。
      // 明确说出来，避免用户以为 --fix 已经跑过了。
      console.log("[ensure-native] 预演模式，未执行重编。确认无误后加 --yes 重跑。");
      return 0;
    }
  }

  if (before.ok) {
    console.log("[ensure-native] 无需修复：版本与原生模块都正常。");
    return 0;
  }
  if (broken.length === 0) {
    console.log(`[ensure-native] ${before.message}`);
    return 1;
  }
  console.log(`[ensure-native] 待重编 ${broken.length} 项：`);
  let allUsable = true;
  for (const target of broken) {
    console.log(`  - ${target.label}  ${target.path}`);
    const result = rebuildPackage(target.path);
    if (!result.ok) {
      allUsable = false;
      console.log(`    ✗ 重编失败：${result.output}`);
    } else if (!result.usable) {
      // "成功退出但产物不可用"是最坑的一种：必须明说，否则用户会以为已经好了
      allUsable = false;
      console.log(`    ✗ 重编命令成功，但产物仍加载不了（拿到的是别的运行时的预编译产物）`);
      console.log(
        `      本机实测原因：prebuild-install 从本地缓存里取了 Electron/旧 Node 的那份` +
          `（本机全局注入 ELECTRON_RUN_AS_NODE=1，缓存里只有 ABI 127 的包）。`,
      );
      console.log(`      处置（按优先级）：`);
      console.log(`        ① 清缓存后重试：删 %LOCALAPPDATA%\\npm-cache\\_prebuilds 再跑本命令；`);
      console.log(`        ② npm rebuild --build-from-source（需 VS BuildTools + Python）；`);
      console.log(`        ③ 把该包升级到支持当前 Node 的版本；`);
      console.log(`        ④ 换回与该包匹配的 Node 大版本。`);
    } else {
      console.log("    ✓ 重编完成且已复检可用");
    }
  }
  const after = checkEnv({ root });
  if (after.ok) {
    console.log("[ensure-native] 修复后复检：通过。");
    return 0;
  }
  if (!allUsable) {
    console.log(`[ensure-native] 仍有原生模块不可用：${after.message}`);
    return 1;
  }
  console.log(`[ensure-native] 修复后仍失败：${after.message}`);
  return 1;
}

/** CLI 入口。 */
function main(argv) {
  const fix = argv.includes("--fix");
  const purgeCache = argv.includes("--purge-cache");
  const yes = argv.includes("--yes");
  const root = REPO_ROOT;
  if (purgeCache && !fix) {
    // 允许单独清理：`--purge-cache [--yes]`（仍然只删同名条目）
    const names = [...NATIVE_PACKAGES];
    purgePrebuildCache(listPrebuildCacheEntries(prebuildCacheDir(), names), { yes });
    process.exitCode = 0;
    return;
  }
  if (fix) process.exitCode = fixNative(root, { purgeCache, yes });
  else {
    const result = checkEnv({ root });
    console.log(`[ensure-native] node ${result.node.version} / 声明 ${result.declared.nvmrc ?? "-"}`);
    for (const native of result.natives) {
      console.log(`  ${native.ok ? "✓" : "✗"} ${native.label} v${native.version ?? "?"}  ${native.path}`);
      if (!native.ok) console.log(`      ${native.error}`);
    }
    if (result.stale.length > 0) {
      console.log(
        `  ⚠ 存在未被引用的旧副本（${result.stale
          .map((s) => `${s.name}@${s.version}`)
          .join("、")}）：不是当前故障，但正是 ISS-009 的形态，建议 \`pnpm install\` 清理。`,
      );
    }
    if (result.ok) console.log("[ensure-native] 全部通过。");
    else console.log(`[ensure-native] ${result.message}`);
    process.exitCode = result.ok ? 0 : 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
