/**
 * F1 首启密钥引导：`node scripts/start-dsh.mjs --init-key` 的集成测试（子进程实跑）。
 *
 * 断言（对应 F1 验收）：
 *   1. 生成 32 字节随机 → base64（44 字符）写入 `%APPDATA%\knowSelf\keys\persons.key`，
 *      exit=0，输出含**路径**与「已生成」；
 *   2. **绝不打印密钥值**（输出不含文件内容）；
 *   3. 文件已存在 → 拒绝覆盖（exit=1，提示 `--force`），既有内容不变；
 *   4. `--force` 才覆盖（内容变化、仍合法）；
 *   5. `--init-key --check-only` → 严格只读：不生成任何文件（红线）。
 *
 * 隔离性：每个用例用 `mkdtempSync` 造独立 APPDATA，绝不读写本机真实 `%APPDATA%`。
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(PLUGIN_ROOT, "scripts", "start-dsh.mjs");

/** 已创建的隔离 APPDATA，afterEach 统一清理。 */
const tempDirs: string[] = [];

/** 造一个空的隔离 APPDATA。 */
function makeAppData(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-initkey-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/** 跑一次脚本，返回 status / 合并输出。 */
function run(args: string[], appData: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, APPDATA: appData, ...extraEnv },
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** 密钥文件路径（与脚本 `personsKeyPath()` 对齐）。 */
function keyPathOf(appData: string): string {
  return join(appData, "knowSelf", "keys", "persons.key");
}

/** base64 → 32 字节且可逆（与 packages/config 的 decodeKey 对齐）。 */
function isValidKey(raw: string): boolean {
  const value = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

describe("F1：--init-key 首启密钥引导", () => {
  it("生成 32 字节 base64 密钥到 %APPDATA%/knowSelf/keys/persons.key，输出含路径与「已生成」，绝不打印密钥值", () => {
    const appData = makeAppData();
    const { status, output } = run(["--init-key"], appData);
    console.log(output);

    expect(status).toBe(0);
    const keyPath = keyPathOf(appData);
    expect(output).toContain(keyPath);
    expect(output).toContain("已生成");

    const written = readFileSync(keyPath, "utf8");
    expect(isValidKey(written)).toBe(true);
    expect(written.trim()).toHaveLength(44);
    // 红线：密钥值绝不出现在输出里
    expect(output).not.toContain(written.trim());
    // 不因 --init-key 而建 junction / spawn 宿主
    expect(output).not.toContain("junction 目标");
    expect(output).not.toContain("将执行：");
  });

  it("密钥文件已存在 → 拒绝覆盖（exit=1，提示 --force），既有内容不变", () => {
    const appData = makeAppData();
    const first = run(["--init-key"], appData);
    expect(first.status).toBe(0);
    const before = readFileSync(keyPathOf(appData), "utf8");

    const second = run(["--init-key"], appData);
    console.log(second.output);
    expect(second.status).toBe(1);
    expect(second.output).toContain("拒绝覆盖");
    expect(second.output).toContain("--force");
    expect(readFileSync(keyPathOf(appData), "utf8")).toBe(before);
  });

  it("--force 才覆盖：内容变化且仍为合法 32 字节 base64", () => {
    const appData = makeAppData();
    expect(run(["--init-key"], appData).status).toBe(0);
    const before = readFileSync(keyPathOf(appData), "utf8");

    const forced = run(["--init-key", "--force"], appData);
    console.log(forced.output);
    expect(forced.status).toBe(0);
    expect(forced.output).toContain("已生成");
    const after = readFileSync(keyPathOf(appData), "utf8");
    expect(isValidKey(after)).toBe(true);
    expect(after).not.toBe(before);
    expect(forced.output).not.toContain(after.trim());
  });

  it("--init-key 与 --check-only 同时给 → 只读优先，不生成任何文件", () => {
    const appData = makeAppData();
    const { status, output } = run(["--init-key", "--check-only"], appData);
    console.log(output);
    expect(output).toContain("只读模式");
    expect(output).toContain("[check] 1/6");
    // 密钥缺失（隔离 APPDATA + 无 env）→ 第 5 项红、exit=1
    expect(output).toContain("[check] 5/6 ❌");
    expect(status).toBe(1);
    expect(() => readFileSync(keyPathOf(appData), "utf8")).toThrow();
  });
});
