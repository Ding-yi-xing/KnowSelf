/**
 * SQLCipher 接入（DESIGN-13 §7.4）：解密在驱动层完成，调用方永远只见明文。
 * 密钥只在此处转成 PRAGMA 字面量，不入库、不落盘、不进日志、不出现在错误消息。
 */
import { homedir } from "node:os";
import { randomBytes, hkdfSync } from "node:crypto";
import { mkdirSync, openSync, readFileSync, closeSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { EncryptionKeyInvalidError } from "@knowself/config";

export type CipherDbRaw = InstanceType<typeof Database>;

export const REPLY_RETRIEVAL_INFO = "knowself/reply-retrieval/v1";
export const REPLY_RETRIEVAL_SALT_BYTES = 32;
export const REPLY_RETRIEVAL_KEY_BYTES = 32;

export interface DerivedCipherDb {
  raw: CipherDbRaw;
  prepare: CipherDbRaw["prepare"];
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

/** `PRAGMA key = "x'<hex>'"`：必须是打开库后的第一条语句。 */
export function applyKey(raw: CipherDbRaw, key: Buffer): void {
  raw.pragma(`key = "x'${key.toString("hex")}'"`);
}

/**
 * 派生库专用密钥。rootKey 只应由 person-store 内部持有；调用方只拿到打开后的连接。
 * salt 不写入原始库，避免把派生库轮换信息混入 persons.sqlite 事实数据。
 */
export function deriveReplyRetrievalKey(rootKey: Buffer, salt: Buffer): Buffer {
  if (rootKey.length === 0 || salt.length === 0) {
    throw new Error("reply-retrieval key derivation requires non-empty key and salt");
  }
  return Buffer.from(
    hkdfSync("sha256", rootKey, salt, REPLY_RETRIEVAL_INFO, REPLY_RETRIEVAL_KEY_BYTES),
  );
}

/** 读取已有 salt；若不存在则以独占创建，避免多个宿主并发生成不同 salt。 */
export function ensureReplyRetrievalSalt(saltPath: string): Buffer {
  mkdirSync(dirname(saltPath), { recursive: true });
  try {
    const salt = readFileSync(saltPath);
    if (salt.length !== REPLY_RETRIEVAL_SALT_BYTES) {
      throw new Error("reply-retrieval salt has invalid length");
    }
    return salt;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const salt = randomBytes(REPLY_RETRIEVAL_SALT_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(saltPath, "wx");
    writeFileSync(fd, salt);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const existing = readFileSync(saltPath);
      if (existing.length !== REPLY_RETRIEVAL_SALT_BYTES) {
        throw new Error("reply-retrieval salt has invalid length");
      }
      return existing;
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return salt;
}

/**
 * 以专用 key 打开派生库。该函数不接受明文 key 字符串，也不在错误里回显 key。
 */
export function openDerivedCipherDb(
  dbPath: string,
  rootKey: Buffer,
  salt: Buffer,
  label = "reply-retrieval",
): DerivedCipherDb {
  const derivedKey = deriveReplyRetrievalKey(rootKey, salt);
  const raw = new Database(dbPath);
  try {
    applyKey(raw, derivedKey);
    raw.pragma("cipher_memory_security = ON");
    raw.pragma("temp_store = MEMORY");
    raw.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    const txn = raw.transaction.bind(raw) as <T>(fn: () => T) => () => T;
    return {
      raw,
      prepare: (sql: string) => raw.prepare(sql),
      transaction<T>(fn: () => T): () => T {
        return txn(fn);
      },
      close: () => raw.close(),
    };
  } catch {
    raw.close();
    throw new EncryptionKeyInvalidError(`${label} 加密库无法打开（密钥校验失败）`);
  } finally {
    derivedKey.fill(0);
  }
}

/**
 * 把家目录下的绝对路径压成 `…/keys/persons.key`（保留文件名 + 上级目录名）。
 *
 * 为什么需要：错误消息会进 `degraded.reasons` 与 `sources.last_error`，**落库并上屏**；
 * 完整路径里带用户名，属于不该外泄的本机信息。API 响应层（`routes/http.ts`）
 * 还有一道兜底，但**落库路径不经过它**，所以在这里也压一次。
 *
 * @param path 密钥载体绝对路径
 * @returns 家目录下时返回 `…/<dir>/<file>`；否则原样返回
 */
export function redactKeyPath(path: string): string {
  const home = homedir();
  if (home === "" || !path.toLowerCase().startsWith(home.toLowerCase())) return path;
  const parts = path.split(/[\\/]/).filter((segment) => segment !== "");
  const file = parts[parts.length - 1] ?? "";
  const dir = parts[parts.length - 2] ?? "";
  return dir === "" ? file : `…/${dir}/${file}`;
}

/**
 * 校验密钥可用：失败（错误密钥 / 非加密库）→ `ENCRYPTION_KEY_INVALID`。
 *
 * 错误文案刻意做成**可执行提示**（W-9/P0 复盘）：原来只有「密钥无法打开数据库」，
 * 下一个接手的人只会以为是密钥坏了。实际踩到过两种情况：
 *   ① 进程外环境（Node ABI 的 multiple-ciphers 产物）打不开由宿主创建的库 →
 *      这时该换宿主/产物，而不是重建库；
 *   ② 库确实是旧的、与任何可用密钥都不配对 → 这时才谈重建。
 * 两者处置完全相反，所以文案必须同时说清「别急着覆盖」和「按宿主重编」。
 *
 * @param raw 已 `PRAGMA key` 的连接
 * @param keyPath 密钥载体路径（可选：只用于提示，绝不回显密钥值）
 */
export function verifyKey(raw: CipherDbRaw, keyPath?: string): void {
  try {
    raw.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  } catch {
    const where = keyPath === undefined ? "" : `\n（当前密钥载体：${redactKeyPath(keyPath)}）`;
    throw new EncryptionKeyInvalidError(
      "当前进程无法打开 persons 库（PRAGMA key 校验失败）。" +
        "\n可能原因：① 密钥与库不匹配；② 在进程外（Node ABI）运行，而该库只能被 Electron 侧产物解开。" +
        "\n处置：先在 in-app 验证；确认是派生库且无人工数据时，才可用 scripts/rebuild-persons.mjs 重建。" +
        "\n切勿直接覆盖——含人工编辑字段的库一旦覆盖不可恢复。" +
        where,
    );
  }
}

/** `PRAGMA rekey`：轮换后旧备份不可读（DESIGN-13 §7.2）。 */
export function rekey(raw: CipherDbRaw, newKey: Buffer): void {
  raw.pragma(`rekey = "x'${newKey.toString("hex")}'"`);
}
