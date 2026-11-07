import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createCoreRepo } from "../src/repository/core";
import { createCardsRepo } from "../src/repository/cards";
import { exportProfile } from "../src/export";

const TMP = join(process.cwd(), "__test_export_tmp");

describe("exportProfile", () => {
  let db: ProfileDb;

  beforeEach(() => {
    db = openProfileDb(":memory:");
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    db.raw.close();
    try {
      rmSync(TMP, { recursive: true });
    } catch {
      /* best-effort */
    }
  });

  it("exports as JSON format", async () => {
    const core = createCoreRepo(db);
    core.save({ body: "hello", display_name: "Test" }, "2026-05-27T00:00:00.000Z");

    const result = await exportProfile(
      { db, sourcesDir: TMP, exportsDir: TMP },
      { format: "json", include_sources: false },
    );

    expect(result.format).toBe("json");
    expect(result.download_path).toContain(".json");
    const fullPath = join(TMP, result.download_path);
    expect(existsSync(fullPath)).toBe(true);
    const content = readFileSync(fullPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.core_profile).toBeDefined();
    expect(parsed.exported_at).toBeDefined();
  });

  it("exports as markdown format", async () => {
    const core = createCoreRepo(db);
    core.save({ body: "hello world", display_name: "Test" }, "2026-05-27T00:00:00.000Z");

    const cards = createCardsRepo(db);
    cards.save(
      {
        key: "work",
        title: "Work",
        summary: "Work stuff",
        sections: [{ title: "Tasks", body: "Do things" }],
      },
      "2026-05-27T00:00:00.000Z",
    );

    const result = await exportProfile(
      { db, sourcesDir: TMP, exportsDir: TMP },
      { format: "markdown", include_sources: false },
    );

    expect(result.format).toBe("markdown");
    expect(result.download_path).toContain(".zip");
    expect(existsSync(join(TMP, result.download_path))).toBe(true);
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it("returns export response with correct shape", async () => {
    const core = createCoreRepo(db);
    core.save({ body: "x" }, "2026-05-27T00:00:00.000Z");

    const result = await exportProfile(
      { db, sourcesDir: TMP, exportsDir: TMP },
      { format: "json", include_sources: false },
    );

    expect(result).toHaveProperty("download_path");
    expect(result).toHaveProperty("format");
    expect(result).toHaveProperty("size_bytes");
    expect(result).toHaveProperty("generated_at");
  });
});
