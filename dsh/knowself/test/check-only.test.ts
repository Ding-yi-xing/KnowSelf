/**
 * §13.5 / T12 step 0：`--check-only` 六项预检的集成测试（子进程实跑，不启动宿主）。
 *
 * 断言：
 *   1. 六项按序打印 `[check] N/6 ✅|❌` 与可执行修复建议；
 *   2. 密钥缺失（env 未注入 + 密钥文件不存在的隔离 APPDATA）→ 第 5 项红、exitCode=1，
 *      且修复建议是明确命令 `node scripts/start-dsh.mjs --init-key`；
 *      **不伪造密钥、不跳过该项**；
 *   3. 注入合法 32 字节 base64 密钥后六项全绿、exitCode=0；
 *   4. `--check-only` 不建 junction、不 spawn —— 输出不含 junction / spawn 相关行；
 *      且**严格只读**：不会写出密钥文件（F1 红线）。
 *
 * F1 补充：本文件用 `mkdtempSync` 造一个**隔离的 APPDATA**（无 persons.key），使
 * 「密钥缺失 → 红」的断言不受本机既有密钥文件影响（既往前置条件未写明，机器上一旦
 * 存在 %APPDATA%\knowSelf\keys\persons.key，第 5 项就必然绿，用例会假红）。
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCRIPT = join(PLUGIN_ROOT, "scripts", "start-dsh.mjs");

/** 隔离的 APPDATA：保证其中没有 knowSelf/keys/persons.key。 */
const ISOLATED_APPDATA = mkdtempSync(join(tmpdir(), "knowself-checkonly-"));
const ISOLATED_KEY_PATH = join(
  ISOLATED_APPDATA,
  "knowSelf",
  "keys",
  "persons.key",
);

afterAll(() => {
  rmSync(ISOLATED_APPDATA, { recursive: true, force: true });
});

/** 跑一次 `--check-only`，可覆盖环境变量（默认使用隔离 APPDATA）。 */
function runCheckOnly(extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, "--check-only"], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, APPDATA: ISOLATED_APPDATA, ...extraEnv },
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("§13.5：--check-only 六项预检", () => {
  it("六项按序打印；密钥缺失时第 5 项红且给出 --init-key 修复命令，exit=1，不写密钥", () => {
    const { status, output } = runCheckOnly({ KNOWSELF_PERSONS_KEY: "" });
    console.log(output);

    for (let index = 1; index <= 6; index += 1) {
      expect(output).toContain(`[check] ${index}/6`);
    }
    expect(output).toContain("[check] 1/6 ✅");
    expect(output).toContain("[check] 2/6 ✅");
    expect(output).toContain("[check] 3/6 ✅");
    expect(output).toContain("[check] 4/6 ✅");
    expect(output).toContain("[check] 5/6 ❌");
    expect(output).toContain("[check] 6/6 ✅");
    // F1：修复建议从「自己 randomBytes 再设 env」改为明确命令。
    expect(output).toContain("node scripts/start-dsh.mjs --init-key");
    expect(output).toContain("pnpm run build:dsh");
    expect(output).toContain("5/6 通过，1 项未通过");
    expect(status).toBe(1);

    // 红线：--check-only 严格只读，绝不生成密钥文件。
    expect(existsSync(ISOLATED_KEY_PATH)).toBe(false);

    // 不建 junction、不注入 env、不 spawn
    expect(output).not.toContain("junction 目标");
    expect(output).not.toContain("KNOWSELF_ROOT_DIR 未设，注入默认值");
    expect(output).not.toContain("将执行：");
  });

  it("注入合法 32 字节 base64 密钥后六项全绿，exit=0", () => {
    const key = randomBytes(32).toString("base64");
    const { status, output } = runCheckOnly({ KNOWSELF_PERSONS_KEY: key });
    console.log(output);
    expect(output).toContain("[check] 5/6 ✅");
    expect(output).toContain("6/6 通过（exit=0）");
    expect(status).toBe(0);
    // 只校验 env 值，不写任何密钥文件；也不回显密钥值
    expect(output).not.toContain(key);
    expect(existsSync(ISOLATED_KEY_PATH)).toBe(false);
  });

  it("非法格式密钥不被接受（仍红），不会因有值就误判通过", () => {
    const { status, output } = runCheckOnly({
      KNOWSELF_PERSONS_KEY: "not-a-valid-key",
    });
    expect(output).toContain("[check] 5/6 ❌");
    expect(status).toBe(1);
  });
});
