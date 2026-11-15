/**
 * _verify-cipher-host.cjs — P0 修复验证（**宿主侧**，Electron ABI 149 产物）。
 *
 * 用 `ELECTRON_RUN_AS_NODE=1` 让 electron.exe 以 Node 模式跑本脚本，从而加载
 * **profile 里那份**（宿主 bundle 运行时真正用的）`better-sqlite3-multiple-ciphers`，
 * 只读打开生产 persons.sqlite。
 *
 * 与 `_verify-cipher-split.ts` 互补：那边验仓库侧（Node ABI 137），这边验宿主侧（ABI 149），
 * 两边都能开到同样的行数，才说明「修好了驱动分裂，且没有把宿主弄坏」。
 */
const { readFileSync, existsSync } = require("node:fs");
const { createRequire } = require("node:module");

const DB = process.env.DB_PATH || "C:/Users/40179/Documents/AllProjecks/knowSelf/data/persons.sqlite";
const KEY_FILE = "C:/Users/40179/AppData/Roaming/knowSelf/keys/persons.key";
const PROFILE_MODULES = "C:/Users/40179/.dsh/profiles/desktop/node_modules/";

const req = createRequire(PROFILE_MODULES + "noop.cjs");
const cipherEntry = req.resolve("better-sqlite3-multiple-ciphers");
const cipherPkg = req("better-sqlite3-multiple-ciphers/package.json");
const Database = req("better-sqlite3-multiple-ciphers");

const out = {
  runtime: "electron-as-node",
  nodeVersion: process.version,
  abi: process.versions.modules,
  electron: process.versions.electron ?? null,
  resolvedFrom: cipherEntry,
  resolvedVersion: cipherPkg.version,
  dbPath: DB,
};

if (!existsSync(KEY_FILE)) throw new Error("密钥文件不存在");
if (!existsSync(DB)) throw new Error("生产库不存在");

const key = Buffer.from(readFileSync(KEY_FILE, "utf-8").trim(), "base64");
if (key.length !== 32) throw new Error(`密钥长度异常：${key.length}（期望 32）`);

const raw = new Database(DB, { readonly: true, fileMustExist: true });
try {
  raw.pragma(`key = "x'${key.toString("hex")}'"`);
  raw.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  out.encryptionMode =
    raw.prepare("SELECT value FROM persons_meta WHERE key='encryption_mode'").get()?.value ?? null;
  out.persons = raw.prepare("SELECT count(*) AS n FROM persons").get().n;
  out.aliases = raw.prepare("SELECT count(*) AS n FROM aliases").get().n;
  out.chatMessages = raw.prepare("SELECT count(*) AS n FROM chat_messages").get().n;
  out.ok = true;
} catch (err) {
  out.ok = false;
  out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
} finally {
  raw.close();
}
console.log(JSON.stringify(out, null, 2));
if (out.ok !== true) process.exitCode = 1;
