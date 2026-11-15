/**
 * verify-cipher-split.ts — P0 修复验证（**仓库侧**，Node 24 / ABI 137）。
 *
 * 判据（主理人定的，不是"能开库"这种模糊话）：
 *   用**仓库侧解析到的** `better-sqlite3-multiple-ciphers`（此前是嵌套的 11.10.0）
 *   + 仓库自己的密钥解析与 `PRAGMA key` 代码，**只读**打开生产 `data/persons.sqlite`，
 *   读得到 persons / aliases 行数。
 *
 * 为什么走 tsx：`packages/<pkg>/dist` 是 tsc 产物（相对 import 不带扩展名），Node 原生 ESM
 * 解析不了；tsx 能直接吃 src，且**模块解析仍按仓库目录**，所以 `createRequire` 拿到的
 * 就是仓库侧那份驱动 —— 这正是要验证的东西。
 *
 * 只读三保险：`readonly: true` + `fileMustExist: true` + 不执行任何 DDL/写 pragma。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolvePersonsKey } from "../packages/config/src/keys.js";
// `applyKey` 只有一行 pragma；不 import 是因为 `cipher.ts` 会裸引 `@knowself/config`，
// 而那个包的 `exports` 指向 tsc 产物（相对 import 无扩展名），Node ESM 解析不了。
// 这里逐字照抄同一行，保证语义一致。
const applyKeyInline = (raw: { pragma(sql: string): unknown }, key: Buffer): void => {
  raw.pragma(`key = "x'${key.toString("hex")}'"`);
};

// 允许用 DB_PATH 指向另一份库（例如隔离根），默认生产库
const DB = process.env.DB_PATH ?? "C:/Users/40179/Documents/AllProjecks/knowSelf/data/persons.sqlite";
const KEY_FILE = "C:/Users/40179/AppData/Roaming/knowSelf/keys/persons.key";

// 关键：从**仓库侧**（packages/person-store/src）解析驱动，而不是从插件树解析。
// `FORCE_CIPHER_DIR` 用于**反向对照**：强制加载那个嵌套的旧副本，证明「分裂才是根因」。
const forceDir = process.env.FORCE_CIPHER_DIR;
const req = createRequire(
  forceDir === undefined
    ? new URL("../packages/person-store/src/db.ts", import.meta.url)
    : `${forceDir}/package.json`,
);
const cipherEntry = forceDir === undefined ? req.resolve("better-sqlite3-multiple-ciphers") : `${forceDir}/lib/index.js`;
const cipherPkg = req(forceDir === undefined ? "better-sqlite3-multiple-ciphers/package.json" : `${forceDir}/package.json`) as { version: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = req(forceDir === undefined ? "better-sqlite3-multiple-ciphers" : `${forceDir}/lib/index.js`) as any;

const out: Record<string, unknown> = {
  nodeVersion: process.version,
  abi: process.versions.modules,
  resolvedFrom: cipherEntry,
  resolvedVersion: cipherPkg.version,
  dbPath: DB,
};

if (!existsSync(KEY_FILE)) throw new Error("密钥文件不存在");
if (!existsSync(DB)) throw new Error("生产库不存在");

const key = resolvePersonsKey({ keyPath: KEY_FILE });
const raw = new Database(DB, { readonly: true, fileMustExist: true });
try {
  applyKeyInline(raw, key);
  raw.prepare("SELECT count(*) AS n FROM sqlite_master").get(); // 密钥校验
  out.encryptionMode =
    (raw.prepare("SELECT value FROM persons_meta WHERE key='encryption_mode'").get() as { value: string } | undefined)
      ?.value ?? null;
  out.persons = (raw.prepare("SELECT count(*) AS n FROM persons").get() as { n: number }).n;
  out.aliases = (raw.prepare("SELECT count(*) AS n FROM aliases").get() as { n: number }).n;
  out.chatMessages = (raw.prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n;
  out.ok = true;
} catch (err) {
  out.ok = false;
  out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
} finally {
  raw.close();
}
console.log(JSON.stringify(out, null, 2));
if (out.ok !== true) process.exitCode = 1;
