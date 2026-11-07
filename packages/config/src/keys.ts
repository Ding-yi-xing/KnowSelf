import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EncryptionKeyInvalidError, EncryptionKeyMissingError } from "./errors";

/** DESIGN-13 附录 A：环境变量载体（仅测试 / CI；生产只走密钥文件）。 */
export const KEY_ENV_VAR = "KNOWSELF_PERSONS_KEY";

/** DESIGN-13 附录 A：密钥规格 = 随机 256-bit = 32 字节（base64 存储）。 */
export const KEY_BYTES = 32;

/** DESIGN-13 §7.2：默认密钥文件 `%APPDATA%\knowSelf\keys\persons.key`。 */
const KEY_RELATIVE_PATH = ["knowSelf", "keys", "persons.key"];

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PersonsKeySource {
  /** 环境变量名；默认 `KNOWSELF_PERSONS_KEY`。 */
  envVar?: string;
  /** 密钥文件路径；默认 `%APPDATA%\knowSelf\keys\persons.key`。 */
  keyPath?: string;
  /** 环境变量表（测试注入用）；默认 `process.env`。 */
  env?: Record<string, string | undefined>;
  /** `%APPDATA%` 根目录（测试注入用）；默认 `process.env.APPDATA`。 */
  appDataDir?: string;
}

/** 默认密钥文件路径（DESIGN-13 §7.2）。 */
export function defaultPersonsKeyPath(appDataDir?: string): string {
  const base = appDataDir ?? process.env.APPDATA ?? "";
  return join(base, ...KEY_RELATIVE_PATH);
}

/**
 * 按 DESIGN-13 §7.2 的载体优先级解析 persons 加密密钥：ENV > 文件。
 * 环境变量为空串 / 纯空白视为未设置，回退到密钥文件。
 * 返回的 Buffer 只交给 `PRAGMA key`：不得落库、不得进日志、不得写错误消息（NFR-10）。
 */
export function resolvePersonsKey(source: PersonsKeySource = {}): Buffer {
  const envVar = source.envVar ?? KEY_ENV_VAR;
  const env = source.env ?? process.env;
  const keyPath = source.keyPath ?? defaultPersonsKeyPath(source.appDataDir);

  const fromEnv = env[envVar]?.trim();
  if (fromEnv) {
    return decodeKey(fromEnv, envVar);
  }
  return decodeKey(readKeyFile(keyPath), keyPath);
}

function readKeyFile(keyPath: string): string {
  try {
    return readFileSync(keyPath, "utf-8").trim();
  } catch {
    throw new EncryptionKeyMissingError(keyPath);
  }
}

/** 校验顺序（DESIGN-13 §7.2）：base64 合法性 → 解码长度必须 = 32 字节。 */
function decodeKey(base64: string, carrier: string): Buffer {
  const key = BASE64_PATTERN.test(base64) ? Buffer.from(base64, "base64") : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyInvalidError(
      `persons 加密密钥非法：期望 base64 编码的 ${KEY_BYTES} 字节（载体：${carrier}）`,
      carrier,
    );
  }
  return key;
}
