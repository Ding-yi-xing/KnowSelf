import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 全部为合成密钥（非真实密钥）；测试只在临时目录写盘，且不写入任何真实载体路径。
const SYNTHETIC_KEY_B64 = Buffer.alloc(32, 0x6b).toString("base64"); // 32 字节
const SYNTHETIC_SHORT_B64 = Buffer.alloc(16, 0x6b).toString("base64"); // 16 字节 → 非法
const SYNTHETIC_NOT_B64 = "synthetic-not-base64!!";

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("defaultPersonsKeyPath", () => {
  it("joins %APPDATA%/knowSelf/keys/persons.key (DESIGN-13 §7.2)", async () => {
    const { defaultPersonsKeyPath } = await import("../src/keys.js");
    expect(defaultPersonsKeyPath("C:\\AppData\\Roaming")).toBe(
      join("C:\\AppData\\Roaming", "knowSelf", "keys", "persons.key"),
    );
  });
});

describe("resolvePersonsKey", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-keys-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers the env var over the key file (ENV > 文件)", async () => {
    const { resolvePersonsKey, KEY_ENV_VAR } = await import("../src/keys.js");
    const keyPath = join(tmpDir, "persons.key");
    // 文件内容非法：若优先级错误就会抛 EncryptionKeyInvalidError
    writeFileSync(keyPath, SYNTHETIC_SHORT_B64, "utf-8");

    const key = resolvePersonsKey({ env: { [KEY_ENV_VAR]: SYNTHETIC_KEY_B64 }, keyPath });

    expect(key).toHaveLength(32);
    expect(key.toString("base64")).toBe(SYNTHETIC_KEY_B64);
  });

  it("falls back to the key file when the env var is absent", async () => {
    const { resolvePersonsKey } = await import("../src/keys.js");
    const keyPath = join(tmpDir, "persons.key");
    writeFileSync(keyPath, `${SYNTHETIC_KEY_B64}\n`, "utf-8");

    const key = resolvePersonsKey({ env: {}, keyPath });

    expect(key.toString("base64")).toBe(SYNTHETIC_KEY_B64);
  });

  it("treats a blank env var as unset and falls back to the file", async () => {
    const { resolvePersonsKey, KEY_ENV_VAR } = await import("../src/keys.js");
    const keyPath = join(tmpDir, "persons.key");
    writeFileSync(keyPath, SYNTHETIC_KEY_B64, "utf-8");

    const key = resolvePersonsKey({ env: { [KEY_ENV_VAR]: "   " }, keyPath });

    expect(key.toString("base64")).toBe(SYNTHETIC_KEY_B64);
  });

  it("throws ENCRYPTION_KEY_MISSING when no carrier exists", async () => {
    const { resolvePersonsKey } = await import("../src/keys.js");
    const { EncryptionKeyMissingError } = await import("../src/errors.js");
    const keyPath = join(tmpDir, "missing.key");

    const err = capture(() => resolvePersonsKey({ env: {}, keyPath }));

    expect(err).toBeInstanceOf(EncryptionKeyMissingError);
    expect((err as { code: string }).code).toBe("ENCRYPTION_KEY_MISSING");
    expect((err as Error).message).toContain(keyPath);
  });

  it("throws ENCRYPTION_KEY_INVALID for a non-base64 env value without echoing it", async () => {
    const { resolvePersonsKey, KEY_ENV_VAR } = await import("../src/keys.js");
    const { EncryptionKeyInvalidError } = await import("../src/errors.js");

    const err = capture(() => resolvePersonsKey({ env: { [KEY_ENV_VAR]: SYNTHETIC_NOT_B64 } }));

    expect(err).toBeInstanceOf(EncryptionKeyInvalidError);
    expect((err as { code: string }).code).toBe("ENCRYPTION_KEY_INVALID");
    expect((err as Error).message).not.toContain(SYNTHETIC_NOT_B64);
    expect(JSON.stringify((err as { toPayload: () => unknown }).toPayload())).not.toContain(
      SYNTHETIC_NOT_B64,
    );
  });

  it("throws ENCRYPTION_KEY_INVALID when the decoded length is not 32 bytes", async () => {
    const { resolvePersonsKey } = await import("../src/keys.js");
    const { EncryptionKeyInvalidError } = await import("../src/errors.js");
    const keyPath = join(tmpDir, "short.key");
    writeFileSync(keyPath, SYNTHETIC_SHORT_B64, "utf-8");

    const err = capture(() => resolvePersonsKey({ env: {}, keyPath }));

    expect(err).toBeInstanceOf(EncryptionKeyInvalidError);
    expect((err as { code: string }).code).toBe("ENCRYPTION_KEY_INVALID");
    expect((err as Error).message).toContain(keyPath);
    expect((err as Error).message).not.toContain(SYNTHETIC_SHORT_B64);
  });
});
