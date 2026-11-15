/**
 * P0 复盘（W-9）：人物库密钥的**两条互斥路径**必须都被锁住。
 *
 *   ① 库已存在但密钥不匹配 → **抛错、不覆盖**（既不换密钥也不动库）
 *   ② 密钥文件缺失         → `auto` 正常生成，并能开新库
 *
 * 为什么②要单独锁：修①时最容易顺手把生成分支带坏（例如「打不开就重生成一把」，
 * 那会静默毁掉用户原有加密数据）。这两条是同一段代码的两个出口，必须成对断言。
 *
 * 隔离性：全部落在 `mkdtempSync` 的临时目录里，不读写真实 `%APPDATA%`，不触网。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonStore } from "@knowself/person-store";
import { ensurePersonsKey } from "../src/persons-key.js";

const tempDirs: string[] = [];

/** 造一个隔离目录，返回 { dir, keyPath, dbPath }。 */
function makeSandbox(): { dir: string; keyPath: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "knowself-keymismatch-"));
  tempDirs.push(dir);
  return { dir, keyPath: join(dir, "keys", "persons.key"), dbPath: join(dir, "persons.sqlite") };
}

/** 文件 sha256（不存在返回空串）。 */
function sha256(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("persons 密钥与库不匹配（P0 复盘）", () => {
  it("库存在但密钥不匹配 → 抛错且**不覆盖**密钥与库", () => {
    const { keyPath, dbPath } = makeSandbox();

    // ① 正常首启：生成密钥 + 建库
    const first = ensurePersonsKey({ mode: "auto", env: {}, keyPath });
    expect(first.created).toBe(true);
    expect(first.source).toBe("generated");

    const store = createPersonStore({ dbPath, encryption: { mode: "sqlcipher", keyPath } });
    store.close();

    const dbShaBefore = sha256(dbPath);

    // ② 把密钥换成另一把合法密钥（模拟「库与钥匙不配对」）
    const otherKey = randomBytes(32).toString("base64");
    writeFileSync(keyPath, `${otherKey}\n`, "utf8");
    const keyShaAfterSwap = sha256(keyPath);

    // ③ auto 不得生成新密钥（文件已存在且合法 → 复用；能不能开库是下一步的事）
    const again = ensurePersonsKey({ mode: "auto", env: {}, keyPath });
    expect(again.created).toBe(false);
    expect(again.source).toBe("file");
    // 文件内容必须原样（没有被静默替换成第三把）
    expect(sha256(keyPath)).toBe(keyShaAfterSwap);

    // ④ 开库必须失败，且错误文案可执行（含载体路径与「勿覆盖」语义）
    let caught: unknown = null;
    try {
      createPersonStore({ dbPath, encryption: { mode: "sqlcipher", keyPath } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("ENCRYPTION_KEY_INVALID");
    const message = (caught as Error).message;
    expect(message).toContain("当前进程无法打开 persons 库");
    expect(message).toContain("① 密钥与库不匹配");
    expect(message).toContain("② 在进程外（Node ABI）运行");
    expect(message).toContain("才可用 scripts/rebuild-persons.mjs 重建");
    expect(message).toContain("切勿直接覆盖");
    // 路径被家目录脱敏成 …/keys/persons.key（该字段会落库，不上屏完整用户名路径）
    expect(message).toContain("persons.key");
    expect(message).not.toContain("\\Users\\");

    // ⑤ 库文件一个字节都不能变
    expect(sha256(dbPath)).toBe(dbShaBefore);
  });

  it("密钥文件缺失 → auto 正常生成，并能开新库（生成分支没被修坏）", () => {
    const { keyPath, dbPath } = makeSandbox();

    const result = ensurePersonsKey({ mode: "auto", env: {}, keyPath });
    expect(result.created).toBe(true);
    expect(result.source).toBe("generated");
    expect(sha256(keyPath)).not.toBe("");

    const store = createPersonStore({ dbPath, encryption: { mode: "sqlcipher", keyPath } });
    const persons = store.listPersons();
    store.close();

    // 新库自带 self 行
    expect(persons.some((p) => p.person_id === "me")).toBe(true);
  });

  it("密钥文件已存在且合法 → 复用不重写（created=false，内容不变）", () => {
    const { keyPath } = makeSandbox();
    ensurePersonsKey({ mode: "auto", env: {}, keyPath });
    const before = sha256(keyPath);

    const again = ensurePersonsKey({ mode: "auto", env: {}, keyPath });
    expect(again.created).toBe(false);
    expect(sha256(keyPath)).toBe(before);
  });
});
