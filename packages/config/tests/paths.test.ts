import { describe, it, expect } from "vitest";
import { getDataPaths, ensureDataDirs } from "../dist/paths.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("getDataPaths", () => {
  it("returns all expected paths with default data dir", () => {
    const paths = getDataPaths(tmpdir());
    expect(paths.rootDir).toBe(tmpdir());
    expect(paths.dataDir).toBe(join(tmpdir(), "data"));
    expect(paths.profileDbPath).toBe(join(tmpdir(), "data", "profile.sqlite"));
    expect(paths.sourcesDir).toBe(join(tmpdir(), "data", "sources"));
    expect(paths.exportsDir).toBe(join(tmpdir(), "data", "exports"));
    expect(paths.modelsDir).toBe(join(tmpdir(), "data", "models"));
    expect(paths.conversationsDbPath).toBe(join(tmpdir(), "data", "conversations.sqlite"));
    expect(paths.retrievalDbPath).toBe(join(tmpdir(), "data", "retrieval.sqlite"));
  });

  it("accepts custom data subdirectory", () => {
    const paths = getDataPaths(tmpdir(), "mydata");
    expect(paths.dataDir).toBe(join(tmpdir(), "mydata"));
    expect(paths.profileDbPath).toBe(join(tmpdir(), "mydata", "profile.sqlite"));
  });

  it("resolves persons.sqlite at data/persons.sqlite (DESIGN-10 §8.1)", () => {
    const paths = getDataPaths(tmpdir());
    expect(paths.personsDbPath).toBe(join(tmpdir(), "data", "persons.sqlite"));
  });

  it("resolves automation db + dir under data/automation (DESIGN-16 §9.1)", () => {
    const paths = getDataPaths(tmpdir());
    expect(paths.automationDir).toBe(join(tmpdir(), "data", "automation"));
    expect(paths.automationDbPath).toBe(join(tmpdir(), "data", "automation", "automation.sqlite"));
  });

  it("honours the custom data subdirectory for the new V3 paths", () => {
    const paths = getDataPaths(tmpdir(), "mydata");
    expect(paths.personsDbPath).toBe(join(tmpdir(), "mydata", "persons.sqlite"));
    expect(paths.automationDir).toBe(join(tmpdir(), "mydata", "automation"));
    expect(paths.automationDbPath).toBe(
      join(tmpdir(), "mydata", "automation", "automation.sqlite"),
    );
  });
});

describe("ensureDataDirs", () => {
  it("creates all required directories", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ks-paths-"));
    try {
      const paths = getDataPaths(tmpDir);
      ensureDataDirs(paths);
      expect(existsSync(paths.dataDir)).toBe(true);
      expect(existsSync(paths.sourcesDir)).toBe(true);
      expect(existsSync(paths.exportsDir)).toBe(true);
      expect(existsSync(paths.modelsDir)).toBe(true);
      expect(existsSync(paths.automationDir)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("is idempotent (no error on second call)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ks-paths-"));
    try {
      const paths = getDataPaths(tmpDir);
      ensureDataDirs(paths);
      ensureDataDirs(paths); // second call should not throw
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
