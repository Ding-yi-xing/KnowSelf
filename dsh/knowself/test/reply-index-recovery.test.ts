import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quarantineReplyIndex, quarantineStamp } from "../src/reply-index-recovery.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ks-reply-index-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("reply index recovery", () => {
  it("renames the undecryptable index and its sidecar files, keeping the bytes", () => {
    const dir = tempDir();
    const dbPath = join(dir, "reply-retrieval.sqlite");
    writeFileSync(dbPath, "main");
    writeFileSync(`${dbPath}-wal`, "wal");
    writeFileSync(`${dbPath}-shm`, "shm");

    const result = quarantineReplyIndex(dbPath, "2026-11-17T03-00-00-000Z");

    expect(result.failed).toEqual([]);
    expect(result.moved).toHaveLength(3);
    expect(existsSync(dbPath)).toBe(false);
    const moved = `${dbPath}.broken-2026-11-17T03-00-00-000Z`;
    expect(readFileSync(moved, "utf8")).toBe("main");
    expect(readFileSync(`${moved}-wal`, "utf8")).toBe("wal");
    expect(readFileSync(`${moved}-shm`, "utf8")).toBe("shm");
  });

  it("ignores sidecars that do not exist and never throws", () => {
    const dir = tempDir();
    const dbPath = join(dir, "reply-retrieval.sqlite");
    writeFileSync(dbPath, "main");

    const result = quarantineReplyIndex(dbPath, "stamp");

    expect(result).toEqual({ moved: [dbPath], failed: [] });
  });

  it("reports nothing to move when the index is already gone", () => {
    const result = quarantineReplyIndex(join(tempDir(), "missing.sqlite"), "stamp");
    expect(result).toEqual({ moved: [], failed: [] });
  });

  it("keeps a filesystem-safe stamp (Windows forbids colons in file names)", () => {
    const stamp = quarantineStamp(new Date("2026-11-17T03:04:05.678Z"));
    expect(stamp).toBe("2026-11-17T03-04-05-678Z");
    expect(stamp).not.toContain(":");
    expect(stamp).not.toContain(".");
  });
});
