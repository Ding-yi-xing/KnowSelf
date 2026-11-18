#!/usr/bin/env node
/**
 * 一键启动 dsh web 宿主并挂载 knowSelf 插件（M0 可复现，05 实施方案 §3 T07 / §4 坑 6、7）。
 *
 * 职责：
 *   1. 幂等创建 junction：
 *      $DSH_HOME/profiles/web/node_modules/@knowself/dsh-plugin → 本插件目录。
 *      DSH_HOME 未设置时，调用宿主自己的 `@deepseek-ai/dsh-home-paths.resolveDshHome()`
 *      推导默认值（**不凭猜测硬编码路径**，见 resolveDshHomeDir() 的源码依据）。
 *   2. 校验两个 bundle 存在；缺失只提示 `pnpm run build:dsh`，不自动构建、不 spawn。
 *   3. 两个原生 SQLite 包各做一次内存库功能性自检（不比对 process.versions.modules，
 *      05 §11 V4），打印 require.resolve 路径与结果；失败仅警告、不阻止启动（诊断用途），
 *      也绝不擅自装包 / 改依赖 / 动仓库根那份包。
 *   4. 注入 KNOWSELF_ROOT_DIR（默认仓库根）、透传 KNOWSELF_PERSONS_KEY（值不打印）。
 *   5. spawn `dsh web --patch ./knowself.patch.yml` + 透传剩余参数，透传退出码/信号。
 *
 * 三种模式：
 *   - `--dry-run` / `--check`：做 1~4 全套并打印将执行的命令，**不 spawn**。
 *   - `--check-only`（05 §13.5 / T12 step 0）：**只做六项预检**——不建 junction、
 *     不注入 env、不 spawn；每项打印 ✅/❌ 与可执行的修复建议，任一红 exitCode=1。
 *     **严格只读**：不会生成、不会覆盖任何密钥文件。
 *   - `--init-key`（F1 首启引导）：生成 32 字节 CSPRNG → base64，写入
 *     `%APPDATA%\knowSelf\keys\persons.key`（目录递归创建、权限尽力收紧为 0600）；
 *     已存在则**拒绝**并提示 `--force`；只打印路径与「已生成」，**绝不打印密钥值**；
 *     不需要 bundle / junction，也不 spawn 宿主。
 *   - 默认：全套 + spawn 宿主。
 *
 * 运行：`node scripts/start-dsh.mjs [--dry-run|--check-only|--init-key [--force]] [--no-open ...]`（cwd 任意）
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "../..");
const require = createRequire(import.meta.url);

const SERVER_BUNDLE = join(PLUGIN_ROOT, "dist", "bundle", "index.js");
const CLIENT_BUNDLE = join(PLUGIN_ROOT, "dist", "client-bundle", "client.js");
const PATCH_FILE = "./knowself.patch.yml";
const DSH_BIN = join(
  PLUGIN_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "dsh.CMD" : "dsh",
);
// 直接跑 bin.js：.CMD shim 经 shell 转发参数时曾丢失 `--patch`，导致插件不挂载。
const DSH_BIN_JS = join(
  PLUGIN_ROOT,
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);
const DRY_RUN_FLAGS = new Set(["--dry-run", "--check"]);
const CHECK_ONLY_FLAG = "--check-only";
/** F1：首启密钥引导（生成 persons 主密钥文件）。 */
const INIT_KEY_FLAG = "--init-key";
/** F1：允许覆盖已存在的密钥文件（默认拒绝）。 */
const FORCE_FLAG = "--force";

/**
 * 展开 `~` / `~/...`（与宿主 expandHomePath 语义一致）。
 * @param {string} input 原始路径
 * @returns {string} 展开后的路径
 */
function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/**
 * 推导 DSH_HOME —— 严格复用宿主真实实现，不凭猜测硬编码。
 *
 * 源码证据（安装版本 @deepseek-ai/dsh@0.2.2-rc.1）：
 *   - `lib/bin.js:3`、`lib/profile-boot-e2mS45fC.js:2` 均
 *     `import { resolveDshHome } from "@deepseek-ai/dsh-home-paths"`；
 *     `bin.js:105` 明确 `--profile <name>` = "the profile under $DSH_HOME/profiles to boot"；
 *     `profile-boot:148,299` 用 `resolveProfileDir(name, home)` / `home: resolveDshHome()`。
 *   - `@deepseek-ai/dsh-home-paths/lib/index.js`：
 *       :11  `DSH_HOME_DIR_NAME = ".dsh"`
 *       :15  `DSH_HOME_ENV = "DSH_HOME"`
 *       :56  `defaultDshHome() = join(homedir(), DSH_HOME_DIR_NAME)`
 *       :101-103 优先级：显式配置 > $DSH_HOME > ~/.dsh；空白值视为未设
 *       :109-110 `resolveDshHome(configured, env) = resolveRoot(..., "DSH_HOME", defaultDshHome)`
 *   - 本机实跑（Node 24）：未设 → "C:\\Users\\40179\\.dsh"；设 C:/tmp/mydsh → "C:\\tmp\\mydsh"。
 *
 * 首选直接调用宿主 `resolveDshHome()`（零猜测）；仅当该包无法加载时，才回退到
 * 上面 :11/:56 源码实证的规则 `join(homedir(), ".dsh")` 并显著标注，同时建议显式设置。
 *
 * @returns {Promise<{home: string, source: string, fallback: boolean}>}
 */
async function resolveDshHomeDir() {
  const explicit = (process.env.DSH_HOME ?? "").trim();
  if (explicit !== "") {
    return {
      home: resolve(expandHome(explicit)),
      source: "process.env.DSH_HOME",
      fallback: false,
    };
  }

  try {
    const dshPkgJson = require.resolve("@deepseek-ai/dsh/package.json");
    const dshRequire = createRequire(dshPkgJson);
    const entry = dshRequire.resolve("@deepseek-ai/dsh-home-paths");
    const mod = await import(pathToFileURL(entry).href);
    if (typeof mod.resolveDshHome === "function") {
      const home = mod.resolveDshHome();
      if (typeof home === "string" && home !== "") {
        return {
          home: resolve(home),
          source: `@deepseek-ai/dsh-home-paths.resolveDshHome() [${entry}]`,
          fallback: false,
        };
      }
    }
  } catch (err) {
    process.stdout.write(
      `[start-dsh] 警告：无法加载宿主 resolveDshHome（${err?.message ?? String(err)}），` +
        `改用源码实证的默认规则 join(homedir(), ".dsh")。\n`,
    );
  }

  return {
    home: join(homedir(), ".dsh"),
    source:
      '源码实证回退：@deepseek-ai/dsh-home-paths/lib/index.js:11,56 → join(homedir(), ".dsh")',
    fallback: true,
  };
}

/**
 * existsSync 对悬空链接返回 false，用 lstat 补判。
 * @param {string} p 路径
 * @returns {boolean} 是否为（可能悬空的）符号链接
 */
function isDanglingLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 幂等创建 junction（05 §4 坑 7：Windows 一律 "junction"）。
 *
 * EEXIST 处理：
 *   - 已指向本插件目录 → 直接跳过（幂等，不删除）；
 *   - 是符号链接/junction 但指向别处 → 删除后重建；
 *   - 是普通目录（非链接）→ 只警告跳过，**绝不递归删除用户数据**。
 *
 * @param {string} home 已解析的 DSH_HOME
 * @returns {boolean} junction 是否就绪
 */
function ensureJunction(home) {
  const linkPath = join(
    home,
    "profiles",
    "web",
    "node_modules",
    "@knowself",
    "dsh-plugin",
  );
  const target = PLUGIN_ROOT;
  process.stdout.write(`[start-dsh] junction 目标：${linkPath} → ${target}\n`);

  if (existsSync(linkPath) || isDanglingLink(linkPath)) {
    let stat = null;
    try {
      stat = lstatSync(linkPath);
    } catch {
      stat = null;
    }
    let pointsToTarget = false;
    try {
      pointsToTarget = realpathSync(linkPath) === realpathSync(target);
    } catch {
      pointsToTarget = false;
    }
    if (pointsToTarget) {
      process.stdout.write(
        "[start-dsh] junction 已存在且指向本插件目录，无需重建（幂等）。\n",
      );
      return true;
    }
    if (stat !== null && stat.isSymbolicLink()) {
      rmSync(linkPath, { recursive: true, force: true });
      process.stdout.write("[start-dsh] 已移除指向其它位置的旧链接，准备重建。\n");
    } else {
      process.stdout.write(
        `[start-dsh] 警告：${linkPath} 已存在但不是符号链接（可能是真实目录），` +
          `为避免删除用户数据，跳过 junction 创建。请手动处理或改用未占用的 DSH_HOME。\n`,
      );
      return false;
    }
  }

  try {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath, "junction");
    process.stdout.write("[start-dsh] junction 创建成功。\n");
    return true;
  } catch (err) {
    process.stdout.write(
      `[start-dsh] !!! junction 创建失败（code=${err?.code ?? "-"}）：` +
        `${err?.message ?? String(err)}；不阻止宿主启动，已列为待确认项。\n`,
    );
    return false;
  }
}

/**
 * 打开一个原生 SQLite 包的内存库并执行 SELECT 1。
 * @param {string} pkg 包名
 * @returns {string} require.resolve 的解析路径
 */
function openNativeDatabase(pkg) {
  const resolvedPath = require.resolve(pkg);
  const mod = require(pkg);
  const Database =
    typeof mod === "function" ? mod : mod?.default ?? mod?.Database;
  if (typeof Database !== "function") {
    throw new Error(`${pkg} 导出的 Database 构造函数不可用`);
  }
  const db = new Database(":memory:");
  try {
    const row = db.prepare("SELECT 1 AS ok").get();
    if (row?.ok !== 1) throw new Error(`${pkg} 的 SELECT 1 返回异常`);
  } finally {
    db.close();
  }
  return resolvedPath;
}

/**
 * 两个原生包各做一次 `new Database(':memory:')` + `SELECT 1`（05 §4 坑 6 / §11 V4）。
 * 只做功能性自检，**不比对 process.versions.modules**；失败只警告、不阻止启动。
 *
 * @returns {Array<{pkg: string, resolvedPath: string, error: string, code?: string}>} 失败项
 */
function checkNativeModules() {
  const problems = [];
  for (const pkg of ["better-sqlite3", "better-sqlite3-multiple-ciphers"]) {
    let resolvedPath = "<无法解析>";
    try {
      resolvedPath = require.resolve(pkg);
      const mod = require(pkg);
      const Database =
        typeof mod === "function" ? mod : mod?.default ?? mod?.Database;
      if (typeof Database !== "function") {
        throw new Error(
          `导出的 Database 构造函数不可用（typeof=${typeof Database}）`,
        );
      }
      const db = new Database(":memory:");
      try {
        const row = db.prepare("SELECT 1 AS ok").get();
        if (row?.ok !== 1) {
          throw new Error(`SELECT 1 返回异常：${JSON.stringify(row)}`);
        }
      } finally {
        db.close();
      }
      process.stdout.write(
        `[start-dsh] 原生模块自检 OK  ${pkg}\n    resolve: ${resolvedPath}\n`,
      );
    } catch (err) {
      const code = err?.code ?? undefined;
      const message = err?.message ?? String(err);
      process.stdout.write(
        `[start-dsh] !!! 原生模块自检 FAILED  ${pkg}${code ? ` code=${code}` : ""}\n` +
          `    resolve: ${resolvedPath}\n` +
          `    error  : ${message}\n` +
          `    建议   : 在 dsh/knowself/ 下补装与当前 Node ABI 匹配的该包副本；` +
          `本脚本不会自动安装、不改依赖、不动仓库根那份包。\n`,
      );
      problems.push({ pkg, resolvedPath, error: message, code });
    }
  }
  return problems;
}

/**
 * 构造子进程环境变量：注入 KNOWSELF_ROOT_DIR，透传 KNOWSELF_PERSONS_KEY（值不打印）。
 * @returns {NodeJS.ProcessEnv} 子进程 env
 */
function buildEnv() {
  const env = { ...process.env };
  if (!env.KNOWSELF_ROOT_DIR) {
    env.KNOWSELF_ROOT_DIR = REPO_ROOT;
    process.stdout.write(
      `[start-dsh] KNOWSELF_ROOT_DIR 未设，注入默认值：${REPO_ROOT}\n`,
    );
  } else {
    process.stdout.write(
      `[start-dsh] KNOWSELF_ROOT_DIR 沿用调用方：${env.KNOWSELF_ROOT_DIR}\n`,
    );
  }
  process.stdout.write(
    `[start-dsh] KNOWSELF_PERSONS_KEY：` +
      `${env.KNOWSELF_PERSONS_KEY ? "已由调用方设置（值不打印，NFR-10）" : "未设置"}\n`,
  );
  return env;
}

// ─────────────────────────────────────────────────────────────────────────────
// 05 §13.5 / T12 step 0：`--check-only` 六项预检（只检查、不建 junction、不注入 env、不 spawn）
// ─────────────────────────────────────────────────────────────────────────────

/** 预检第 4 项：与 W3 `resolveRootDir()` 四级推导一致（Config 无 rootDir → 跳过该级）。 */
function resolveCheckRootDir() {
  const fromEnv = process.env.KNOWSELF_ROOT_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv);
  let dir = PLUGIN_ROOT;
  for (;;) {
    if (existsSync(join(dir, "settings.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** persons 密钥文件路径（只检查，不写）。 */
function personsKeyPath() {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "knowSelf", "keys", "persons.key");
}

/**
 * 校验密钥格式：base64 → 32 字节，与 `packages/config/src/keys.ts:58-68` 的
 * `decodeKey()` 顺序一致（base64 合法性 → 解码长度 = 32）。**只校验不生成、不写文件**。
 */
function isValidPersonsKey(raw) {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (value === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

/**
 * F1（首启密钥引导）：生成并写入 persons 主密钥文件。
 *
 * 规格：
 *   - 32 字节 CSPRNG → base64（44 字符），与 `packages/config/src/keys.ts` 的
 *     `decodeKey()` / 本文件 `isValidPersonsKey()` 完全对齐；
 *   - 目录 `mkdir -p`（mode 0700 尽力而为）；文件以 `mode:0600` 写入，写完再 `chmod`
 *     一次（Windows 上 chmod 仅切换只读位，真实权限由 NTFS ACL 决定，输出里如实说明）；
 *   - 已存在则**拒绝**（exit=1）并提示 `--force`；`--force` 才覆盖；
 *   - 只打印**路径**与「已生成」，**绝不打印密钥值**（NFR-10）。
 *
 * @param {boolean} force 是否允许覆盖已存在的密钥文件
 * @returns {void} 失败置 process.exitCode = 1
 */
function initPersonsKey(force) {
  const keyPath = personsKeyPath();
  const keyDir = dirname(keyPath);

  if (existsSync(keyPath) && !force) {
    process.stdout.write(
      `[init-key] 拒绝覆盖：密钥文件已存在\n` +
        `    路径：${keyPath}\n` +
        `    如需重新生成请追加 --force（注意：旧密钥加密的数据将无法解密）。\n` +
        `    当前密钥是否可用：node scripts/start-dsh.mjs --check-only\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    // 32 字节随机 → base64；变量仅停留在本函数栈上，不打印、不写日志。
    const key = randomBytes(32).toString("base64");
    writeFileSync(keyPath, key, {
      encoding: "utf8",
      mode: 0o600,
      // 默认 wx：并发/竞态下也不会静默覆盖别人的密钥；--force 才允许覆盖。
      flag: force ? "w" : "wx",
    });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Windows 上 chmod 语义有限，失败不影响可用性，权限说明已在下方输出。
    }
    process.stdout.write(
      `[init-key] 已生成 persons 密钥：${keyPath}\n` +
        `    权限：已请求 0600（Windows 下真实权限由 NTFS ACL 决定，chmod 仅切换只读位）\n` +
        `    密钥值不打印（NFR-10）。\n` +
        `    下一步：node scripts/start-dsh.mjs --check-only 验证 → node scripts/start-dsh.mjs 启动\n`,
    );
  } catch (err) {
    if (err?.code === "EEXIST") {
      process.stdout.write(
        `[init-key] 拒绝覆盖：密钥文件已存在\n    路径：${keyPath}\n` +
          `    如需重新生成请追加 --force。\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `[init-key] 生成失败（code=${err?.code ?? "-"}）：${err?.message ?? String(err)}\n` +
        `    路径：${keyPath}\n`,
    );
    process.exitCode = 1;
  }
}

/**
 * 六项预检主函数。
 * @returns {void} 通过则 exitCode 保持 0；任一红置 exitCode=1
 */function runCheckOnly() {
  const results = [];
  /** @param {number} index @param {string} name @param {boolean} ok @param {string} detail @param {string} fix */
  const report = (index, name, ok, detail, fix) => {
    results.push({ index, name, ok });
    process.stdout.write(`[check] ${index}/6 ${ok ? "✅" : "❌"} ${name}\n`);
    if (!ok) {
      if (detail) process.stdout.write(`        原因：${detail}\n`);
      if (fix) process.stdout.write(`        修复：${fix}\n`);
    }
  };

  // 1) 两个 bundle 存在
  const missing = [SERVER_BUNDLE, CLIENT_BUNDLE].filter((p) => !existsSync(p));
  report(
    1,
    "两个 bundle 存在（server + client）",
    missing.length === 0,
    missing.length > 0 ? `缺少：${missing.join(", ")}` : "",
    "pnpm run build:dsh",
  );

  // 2) better-sqlite3 可 open(':memory:')
  try {
    openNativeDatabase("better-sqlite3");
    report(2, "better-sqlite3 可 open(':memory:')", true, "", "");
  } catch (err) {
    report(
      2,
      "better-sqlite3 可 open(':memory:')",
      false,
      err?.message ?? String(err),
      "在 dsh/knowself 下重装该包（Node 24）：pnpm add -Dw better-sqlite3@12.11.1",
    );
  }

  // 3) better-sqlite3-multiple-ciphers 可 open + 解析路径在插件目录
  try {
    const resolved = openNativeDatabase("better-sqlite3-multiple-ciphers");
    const inPlugin = resolved
      .toLowerCase()
      .startsWith(PLUGIN_ROOT.toLowerCase());
    report(
      3,
      "better-sqlite3-multiple-ciphers 可 open(':memory:') 且解析在插件目录",
      inPlugin,
      inPlugin ? "" : `require.resolve → ${resolved}（不在插件目录，可能命中仓库根旧 ABI）`,
      "在 dsh/knowself 下重装该包（Node 24）：pnpm add -Dw better-sqlite3-multiple-ciphers@12.11.1（**必须与宿主同版本**，11.x 与 12.x 的磁盘格式不兼容），构建白名单见 pnpm-workspace.yaml 的 onlyBuiltDependencies",
    );
  } catch (err) {
    report(
      3,
      "better-sqlite3-multiple-ciphers 可 open(':memory:') 且解析在插件目录",
      false,
      err?.message ?? String(err),
      "在 dsh/knowself 下重装该包（Node 24）：pnpm add -Dw better-sqlite3-multiple-ciphers@12.11.1（**必须与宿主同版本**，11.x 与 12.x 的磁盘格式不兼容），构建白名单见 pnpm-workspace.yaml 的 onlyBuiltDependencies",
    );
  }

  // 4) settings.json 可读（rootDir 经 W3 四级推导）
  const rootDir = resolveCheckRootDir();
  const settingsPath = join(rootDir, "settings.json");
  let settingsOk = false;
  let settingsDetail = `路径：${settingsPath}`;
  try {
    readFileSync(settingsPath, "utf8");
    settingsOk = true;
  } catch (err) {
    settingsDetail += `；读取失败：${err?.message ?? String(err)}`;
  }
  report(
    4,
    `settings.json 可读（rootDir=${rootDir}）`,
    settingsOk,
    settingsOk ? "" : settingsDetail,
    "设 KNOWSELF_ROOT_DIR 指向含 settings.json 的仓库根（或检查文件权限）",
  );

  // 5) persons 密钥可解析（env 或文件）——只检查，不生成、不写入、不动个人目录
  let keyOk = isValidPersonsKey(process.env.KNOWSELF_PERSONS_KEY);
  let keyCarrier = "env KNOWSELF_PERSONS_KEY";
  if (!keyOk) {
    try {
      keyOk = isValidPersonsKey(readFileSync(personsKeyPath(), "utf8"));
      keyCarrier = `文件 ${personsKeyPath()}`;
    } catch {
      keyCarrier = "env 未设置且密钥文件不存在/不可读";
    }
  }
  report(
    5,
    "persons 密钥可解析（env 或密钥文件）",
    keyOk,
    keyOk ? `载体：${keyCarrier}` : `${keyCarrier}；密钥文件：${personsKeyPath()}`,
    "node scripts/start-dsh.mjs --init-key（生成 32 字节随机密钥并写入 " +
      `${personsKeyPath()}；已存在则加 --force 覆盖）`,
  );

  // 6) knowself.patch.yml 可解析且指向存在的 bundle
  let patchOk = false;
  let patchDetail = "";
  try {
    const text = readFileSync(join(PLUGIN_ROOT, "knowself.patch.yml"), "utf8");
    const hasId = text.includes("id: knowself");
    const hasBundle = text.includes("dist/bundle/index.js");
    const bundleExists = existsSync(SERVER_BUNDLE);
    patchOk = hasId && hasBundle && bundleExists;
    patchDetail = `hasId=${hasId} hasBundle=${hasBundle} bundleExists=${bundleExists}`;
  } catch (err) {
    patchDetail = err?.message ?? String(err);
  }
  report(
    6,
    "knowself.patch.yml 可解析且指向存在的 bundle",
    patchOk,
    patchOk ? "" : patchDetail,
    "检查 patch 的 name 相对路径（应为 ./dist/bundle/index.js）并先跑 pnpm run build:dsh",
  );

  const failed = results.filter((item) => !item.ok);
  if (failed.length > 0) {
    process.stdout.write(
      `[check] 结果：${results.length - failed.length}/6 通过，${failed.length} 项未通过（exit=1）。` +
        `按上方「修复」逐条处理后重跑：node scripts/start-dsh.mjs --check-only；` +
        `全绿后继续 T12 step 1：pnpm run build:dsh\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `[check] 结果：6/6 通过（exit=0）。可继续 T12 step 1：pnpm run build:dsh\n`,
    );
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);

  // F1：--init-key 是独立的密钥引导模式，不需要 bundle / junction，也不 spawn 宿主。
  if (rawArgs.includes(INIT_KEY_FLAG)) {
    if (rawArgs.includes(CHECK_ONLY_FLAG)) {
      // 红线：--check-only 严格只读，绝不因为同时给了 --init-key 就写文件。
      process.stdout.write(
        "[init-key] 注意：--check-only 为只读模式，--init-key 被忽略（不生成、不覆盖任何密钥）。\n",
      );
      runCheckOnly();
      return;
    }
    process.stdout.write(`[init-key] PLUGIN_ROOT = ${PLUGIN_ROOT}\n`);
    if (rawArgs.includes(FORCE_FLAG)) {
      process.stdout.write(
        "[init-key] --force：已允许覆盖既有密钥文件（旧数据可能无法解密）。\n",
      );
    }
    initPersonsKey(rawArgs.includes(FORCE_FLAG));
    return;
  }

  // §13.5：--check-only 是独立模式，只预检、不建 junction、不注入 env、不 spawn。
  if (rawArgs.includes(CHECK_ONLY_FLAG)) {
    runCheckOnly();
    return;
  }

  const dryRun = rawArgs.some((arg) => DRY_RUN_FLAGS.has(arg));
  const passthrough = rawArgs.filter(
    (arg) =>
      !DRY_RUN_FLAGS.has(arg) &&
      arg !== CHECK_ONLY_FLAG &&
      arg !== INIT_KEY_FLAG &&
      arg !== FORCE_FLAG,
  );

  process.stdout.write(
    `[start-dsh] PLUGIN_ROOT = ${PLUGIN_ROOT}\n` +
      `[start-dsh] REPO_ROOT   = ${REPO_ROOT}\n`,
  );

  // 2) bundle 校验：先于 junction / 自检 / spawn；缺失即退出，不自动构建。
  const missing = [SERVER_BUNDLE, CLIENT_BUNDLE].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    for (const p of missing) {
      process.stderr.write(`[start-dsh] 缺少产物：${p}\n`);
    }
    process.stderr.write(
      "[start-dsh] 请先运行：pnpm run build:dsh（本脚本不会自动构建，也不会启动宿主）\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[start-dsh] 产物校验通过：\n    ${SERVER_BUNDLE}\n    ${CLIENT_BUNDLE}\n`,
  );

  // 1) DSH_HOME 推导 + junction
  const homeInfo = await resolveDshHomeDir();
  process.stdout.write(
    `[start-dsh] DSH_HOME 解析 = ${homeInfo.home}\n` +
      `    依据：${homeInfo.source}` +
      `${homeInfo.fallback ? "（回退路径，建议显式设置 DSH_HOME 以与宿主完全一致）" : ""}\n`,
  );
  const junctionOk = ensureJunction(homeInfo.home);

  // 3) 原生模块功能性自检
  process.stdout.write(
    "[start-dsh] --- 原生模块功能性自检（不比对 process.versions.modules）---\n",
  );
  const nativeProblems = checkNativeModules();
  if (nativeProblems.length > 0) {
    process.stdout.write(
      `[start-dsh] !!! ${nativeProblems.length} 个原生包自检失败（详见上方）；` +
        `仅为诊断，不阻止宿主启动，已列为待确认项。\n`,
    );
  } else {
    process.stdout.write("[start-dsh] 原生模块功能性自检全部通过。\n");
  }

  // 4) 环境变量
  const env = buildEnv();
  if (!junctionOk) {
    process.stdout.write(
      "[start-dsh] 注意：junction 未就绪，宿主可能无法解析 @knowself/dsh-plugin。\n",
    );
  }

  // 5) spawn 或 dry-run
  const dshArgs = ["web", "--patch", PATCH_FILE, ...passthrough];
  process.stdout.write(
    `[start-dsh] 将执行：${process.execPath} ${DSH_BIN_JS} ${dshArgs.join(" ")}\n` +
      `    cwd = ${PLUGIN_ROOT}\n`,
  );
  if (dryRun) {
    process.stdout.write(
      "[start-dsh] --dry-run：跳过 spawn（未启动宿主、未占用端口）。\n",
    );
    return;
  }

  if (!existsSync(DSH_BIN_JS)) {
    process.stderr.write(`[start-dsh] 找不到 dsh CLI：${DSH_BIN_JS}\n`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [DSH_BIN_JS, ...dshArgs], {
    cwd: PLUGIN_ROOT,
    env,
    stdio: "inherit",
  });
  child.on("error", (err) => {
    process.stderr.write(
      `[start-dsh] spawn 失败：${err?.message ?? String(err)}\n`,
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal !== null && signal !== undefined) {
      process.stdout.write(`[start-dsh] dsh 被信号终止：${signal}\n`);
      process.exitCode = 128 + (constants.signals[signal] ?? 0);
    } else {
      process.stdout.write(`[start-dsh] dsh 退出码：${code}\n`);
      process.exitCode = code ?? 0;
    }
  });
}

main().catch((err) => {
  process.stderr.write(`[start-dsh] FAILED: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
