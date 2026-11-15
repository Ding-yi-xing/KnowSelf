/**
 * persons 密钥装配期自动生成（MD2-4 / OPEN-3 决策落地）。
 *
 * 职责：在装配 `createPersonStore` 之前，按配置的载体模式（auto/env/file）
 * 确保密钥可用。`auto` 是唯一会**生成**密钥的模式，生成采用原子写：
 *   - `mkdirSync(dirname, { recursive: true, mode: 0o700 })`
 *   - `writeFileSync(path, key + "\n", { flag: "wx", mode: 0o600 })`
 * `wx` + `EEXIST` 捕获保证并发首启时「后到者」只读不覆盖——覆盖 = 已加密数据
 * 永久不可解密（红线）。
 *
 * NFR-10：密钥值只停留在本函数栈内，绝不写入返回值、日志、错误信息；
 * `EncryptionKeyMissingError` 只带载体路径，天然不含密钥值。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  EncryptionKeyMissingError,
  KEY_BYTES,
  KEY_ENV_VAR,
  defaultPersonsKeyPath,
  resolvePersonsKey,
} from "@knowself/config";

/** 密钥载体模式（与插件 `Config.personsKeyMode` 对齐）。 */
export type PersonsKeyMode = "auto" | "env" | "file";

/** `ensurePersonsKey` 结果：只含路径与来源，绝不回传密钥值。 */
export interface EnsureKeyResult {
  /** 密钥文件路径（env 模式下同样返回该路径，便于日志定位载体）。 */
  path: string;
  /** 本次是否真正生成了文件。 */
  created: boolean;
  /** 密钥最终来源。 */
  source: "env" | "file" | "generated";
}

/** 从 unknown 提取 Node fs 错误 `code`（如 `EEXIST` / `ENOTDIR`），非对象时返回 undefined。 */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 确保 persons 密钥按指定载体模式就绪（详见模块头注）。
 *
 * 语义：
 *   - `env`：只用环境变量；`(opts.env ?? process.env)[KEY_ENV_VAR]` 为空 → 抛
 *     `EncryptionKeyMissingError`，**不写文件**。
 *   - `file`：只认文件；文件缺失/不可读 → 抛 `EncryptionKeyMissingError`，**不生成**。
 *   - `auto`：env 有值 → `{source:"env"}`；文件存在且合法 → `{source:"file"}`；
 *     两者皆无 → 生成 32 字节 base64 并原子写（`EEXIST` 视为别人刚生成，绝不覆盖）。
 *
 * @param opts.mode 载体模式：auto / env / file
 * @param opts.env 环境变量表（测试注入）；默认 `process.env`
 * @param opts.appDataDir `%APPDATA%` 根目录（测试注入）；默认 `process.env.APPDATA`
 * @param opts.keyPath 显式密钥文件路径；默认 `defaultPersonsKeyPath(appDataDir)`
 */
export function ensurePersonsKey(opts: {
  mode: PersonsKeyMode;
  env?: NodeJS.ProcessEnv;
  appDataDir?: string;
  keyPath?: string;
}): EnsureKeyResult {
  const env = opts.env ?? process.env;
  const path = opts.keyPath ?? defaultPersonsKeyPath(opts.appDataDir);
  const fromEnv = env[KEY_ENV_VAR]?.trim();

  if (opts.mode === "env") {
    if (!fromEnv) throw new EncryptionKeyMissingError(KEY_ENV_VAR);
    return { path, created: false, source: "env" };
  }

  if (opts.mode === "file") {
    // 只认文件：空 env 强制走文件分支；缺失/不可读由 resolvePersonsKey 抛错。
    resolvePersonsKey({ keyPath: path, env: {} });
    return { path, created: false, source: "file" };
  }

  // ── mode === "auto"：env > 文件 > 生成 ─────────────────────────────────────
  if (fromEnv) {
    return { path, created: false, source: "env" };
  }

  // 文件已存在且合法（含 base64/长度校验）→ 直接复用，绝不覆盖。
  // 文件存在但非法 → 让 EncryptionKeyInvalidError 冒泡（绝不静默覆盖现有密钥）。
  try {
    resolvePersonsKey({ keyPath: path, env: {} });
    return { path, created: false, source: "file" };
  } catch (err) {
    if (!(err instanceof EncryptionKeyMissingError)) throw err;
    // 文件确实缺失 → 落到生成分支。
  }

  const key = randomBytes(KEY_BYTES).toString("base64");
  // mkdir 在 try 外：目录创建失败（如父路径是普通文件）必须冒泡，不能误判为
  // 「并发生成」——EEXIST 只针对下方 `flag:"wx"` 的文件写入竞态。
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, key + "\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (errorCode(err) === "EEXIST") {
      // 并发首启：别人刚生成，只读复用，绝不覆盖。
      return { path, created: false, source: "file" };
    }
    throw err;
  }
  return { path, created: true, source: "generated" };
}
