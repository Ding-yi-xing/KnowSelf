import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveSourceFile, removeSourceFile, sourceFilePath } from "../src/files";
import type { SourceStored } from "@knowself/contracts";

describe("files", () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it("saveSourceFile 写入文件并返回相对路径（filename = sourceId + ext）", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ing-"));
    const result = await saveSourceFile(tmpDir, "abc-123", Buffer.from("test"), "text/plain");
    expect(result).toBe("abc-123.txt");
    expect(existsSync(join(tmpDir, result))).toBe(true);
  });

  it("saveSourceFile 在 sourcesDir 不存在时自动 mkdir", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ing-"));
    const nested = join(tmpDir, "sub", "nested");
    const result = await saveSourceFile(nested, "doc1", Buffer.from("data"), "text/markdown");
    expect(result).toBe("doc1.md");
    expect(existsSync(join(nested, result))).toBe(true);
  });

  it("removeSourceFile 删除存在的文件", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ing-"));
    const fpath = join(tmpDir, "test.txt");
    writeFileSync(fpath, "hello", "utf-8");
    await removeSourceFile(tmpDir, "test.txt");
    expect(existsSync(fpath)).toBe(false);
  });

  it("removeSourceFile 删除不存在的文件不抛错（幂等）", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ing-"));
    await expect(removeSourceFile(tmpDir, "nonexistent.txt")).resolves.not.toThrow();
  });

  it("sourceFilePath 在 source.file_path=null 时返回 null", () => {
    const source = { file_path: null } as SourceStored;
    expect(sourceFilePath("/tmp", source)).toBeNull();
  });

  it("sourceFilePath 在 source.file_path 有值时拼成绝对路径", () => {
    const source = { file_path: "abc-123.md" } as SourceStored;
    const result = sourceFilePath("/tmp/sources", source);
    expect(result).toBe(join("/tmp/sources", "abc-123.md"));
  });
});
