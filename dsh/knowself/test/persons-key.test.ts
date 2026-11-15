/**
 * MD2-4（OPEN-3）：`ensurePersonsKey` 装配期密钥确保的单元测试（4 条）。
 *
 * 隔离性：每个用例用 `mkdtempSync` 造独立临时目录，注入 `env` / `keyPath`，
 * **绝不读写真实 `%APPDATA%`**（红线：删错密钥 = 已加密数据永久不可解密）。
 *
 * 断言（对应 MD2-4 验收表）：
 *   1. auto + 无 env + 无文件 → 原子生成 32 字节 base64（44 字符）+ 换行；
 *   2. auto + 文件已存在 → 不覆盖（内容与 mtime 不变），source=file；
 *   3. env 模式 + 无 env → 抛 EncryptionKeyMissingError，且未创建任何文件；
 *   4. 写入失败（父路径是普通文件）→ 按错误码判定（EEXIST / ENOTDIR，
 *      Windows 与 POSIX 行为不同），且错误信息含被阻塞路径、不含密钥值。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptionKeyMissingError } from "@knowself/config";
import { ensurePersonsKey } from "../src/persons-key.js";

/** 已创建的隔离临时目录，afterEach 统一清理。 */
const tempDirs: string[] = [];

/** 造一个空的隔离临时目录。 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-personskey-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/** base64 → 32 字节且可逆（与 packages/config/src/keys.ts 的 decodeKey 对齐）。 */
function isValidKey(raw: string): boolean {
  const value = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

/** 检测是否泄漏了 44 位 base64 密钥值（32 字节 base64 = 44 字符）。 */
function hasKeyLeak(text: string): boolean {
  return /[A-Za-z0-9+/]{40,}={0,2}/.test(text);
}

describe("MD2-4：ensurePersonsKey 装配期密钥确保", () => {
  it("auto + 无 env + 无文件 → 生成 44 字符 base64 + 换行，created:true, source:generated", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "knowSelf", "keys", "persons.key");

    const result = ensurePersonsKey({ mode: "auto", keyPath, env: {} });

    expect(result.path).toBe(keyPath);
    expect(result.created).toBe(true);
    expect(result.source).toBe("generated");

    const raw = readFileSync(keyPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(isValidKey(raw)).toBe(true);
    expect(raw.trim()).toHaveLength(44);
    // 32 字节 base64 = 44 字符，加上换行 = 45 字节（MD2-4 的「44 字节 base64」+ 1 换行）。
    expect(statSync(keyPath).size).toBe(45);
  });

  it("auto + 文件已存在 → 不覆盖：created:false, source:file，内容与 mtime 不变", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "knowSelf", "keys", "persons.key");
    mkdirSync(join(dir, "knowSelf", "keys"), { recursive: true });
    // 预置一个合法密钥（32 字节 → base64 44 字符），带换行与 resolvePersonsKey 对齐。
    const existing = Buffer.alloc(32, 0x41).toString("base64");
    writeFileSync(keyPath, existing + "\n");

    const before = readFileSync(keyPath, "utf8");
    const mtimeBefore = statSync(keyPath).mtimeMs;

    const result = ensurePersonsKey({ mode: "auto", keyPath, env: {} });

    expect(result.path).toBe(keyPath);
    expect(result.created).toBe(false);
    expect(result.source).toBe("file");
    expect(readFileSync(keyPath, "utf8")).toBe(before);
    expect(statSync(keyPath).mtimeMs).toBe(mtimeBefore);
  });

  it("env 模式 + 无 env → 抛 EncryptionKeyMissingError，且未创建任何文件", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "knowSelf", "keys", "persons.key");

    expect(() =>
      ensurePersonsKey({ mode: "env", keyPath, env: {} }),
    ).toThrow(EncryptionKeyMissingError);

    // 不写文件：父目录链也不应被创建。
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(join(dir, "knowSelf"))).toBe(false);
  });

  it("写入失败（父路径是普通文件）→ 抛错，且错误信息不含密钥值", () => {
    const dir = makeTempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x"); // blocker 是普通文件 → mkdir 其下目录必失败
    const keyPath = join(blocker, "persons.key");

    let thrown: unknown;
    try {
      ensurePersonsKey({ mode: "auto", keyPath, env: {} });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    // 跨平台：Windows 下 mkdir 一个已存在的普通文件路径返回 EEXIST，
    // POSIX 下返回 ENOTDIR。按错误码判定，不写死 POSIX 文案。
    // 同时守住红线：mkdir 的 EEXIST 必须冒泡；若被当成「并发生成」吞掉，
    // 这里就不会抛错（thrown 为 undefined），toBeInstanceOf(Error) 即失败。
    const code =
      typeof thrown === "object" && thrown !== null && "code" in thrown
        ? (thrown as NodeJS.ErrnoException).code
        : undefined;
    expect(["EEXIST", "ENOTDIR"]).toContain(code);

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message.length).toBeGreaterThan(0);
    // 红线：密钥值绝不出现在错误信息里。
    expect(hasKeyLeak(message)).toBe(false);
    // 错误可读：指向被阻塞的目录路径（大小写不敏感，兼容 Windows 盘符/路径大小写差异）。
    expect(message.toLowerCase()).toContain(blocker.toLowerCase());
  });
});
