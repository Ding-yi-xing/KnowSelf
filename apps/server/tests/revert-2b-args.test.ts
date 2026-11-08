/**
 * 批 2b —— CLI `--revert` 参数解析（验收 7 的入口侧）。
 * import ingest-chat.ts 不得触发 main（entry guard），否则会吃 vitest argv 并 process.exit。
 */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/ingest-chat";

describe("parseArgs --revert", () => {
  it("分离形式 --revert <id> 与 --no-index / --root 共存", () => {
    const opts = parseArgs(["--revert", "batch-42", "--no-index", "--root", "/tmp/root"]);
    expect(opts.revert).toBe("batch-42");
    expect(opts.rebuildIndex).toBe(false);
    expect(opts.rootDir).toBe("/tmp/root");
    expect(opts.dir).toBe(""); // 回滚分支不要求 --dir
  });

  it("等号形式 --revert=<id>", () => {
    expect(parseArgs(["--revert=batch-7"]).revert).toBe("batch-7");
  });

  it("未带 --revert 时缺省 undefined，原有导入参数不受影响", () => {
    const opts = parseArgs(["--dir", "/tmp/export", "--only", "张三"]);
    expect(opts.revert).toBeUndefined();
    expect(opts.dir).toBe("/tmp/export");
    expect(opts.only).toEqual(["张三"]);
    expect(opts.rebuildIndex).toBe(true);
  });
});
