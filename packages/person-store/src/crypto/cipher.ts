/**
 * SQLCipher 接入（DESIGN-13 §7.4）：解密在驱动层完成，调用方永远只见明文。
 * 密钥只在此处转成 PRAGMA 字面量，不入库、不落盘、不进日志、不出现在错误消息。
 */
import type Database from "better-sqlite3-multiple-ciphers";
import { EncryptionKeyInvalidError } from "@knowself/config";

export type CipherDbRaw = InstanceType<typeof Database>;

/** `PRAGMA key = "x'<hex>'"`：必须是打开库后的第一条语句。 */
export function applyKey(raw: CipherDbRaw, key: Buffer): void {
  raw.pragma(`key = "x'${key.toString("hex")}'"`);
}

/** 校验密钥可用：失败（错误密钥 / 非加密库）→ `ENCRYPTION_KEY_INVALID`。 */
export function verifyKey(raw: CipherDbRaw): void {
  try {
    raw.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  } catch {
    throw new EncryptionKeyInvalidError("persons 加密密钥无法打开数据库（PRAGMA key 校验失败）");
  }
}

/** `PRAGMA rekey`：轮换后旧备份不可读（DESIGN-13 §7.2）。 */
export function rekey(raw: CipherDbRaw, newKey: Buffer): void {
  raw.pragma(`rekey = "x'${newKey.toString("hex")}'"`);
}
