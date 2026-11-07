import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createCoreRepo } from "../src/repository/core";
import { ProfileNotFoundError } from "../src/errors";

describe("core repo", () => {
  let db: ProfileDb;
  let repo: ReturnType<typeof createCoreRepo>;

  beforeEach(() => {
    db = openProfileDb(":memory:");
    repo = createCoreRepo(db);
  });

  afterEach(() => {
    db.raw.close();
  });

  it("throws ProfileNotFoundError when no row exists", () => {
    expect(() => repo.get()).toThrow(ProfileNotFoundError);
  });

  it("saves and reads back", () => {
    repo.save(
      { body: "hello world", display_name: "Test", locale: "en-US" },
      "2026-05-27T00:00:00.000Z",
    );
    const result = repo.get();
    expect(result.body).toBe("hello world");
    expect(result.display_name).toBe("Test");
    expect(result.locale).toBe("en-US");
    expect(result.section_tags).toEqual([]);
    expect(result.schema_version).toBe(1);
  });

  it("reads back with default values when optional fields omitted", () => {
    repo.save({ body: "minimal" }, "2026-05-27T00:00:00.000Z");
    const result = repo.get();
    expect(result.body).toBe("minimal");
    expect(result.display_name).toBe("");
    expect(result.locale).toBe("zh-CN");
  });

  it("updates existing row via INSERT OR REPLACE", () => {
    repo.save({ body: "first", display_name: "A" }, "2026-05-27T00:00:00.000Z");
    repo.save({ body: "second", locale: "en-US" }, "2026-05-28T00:00:00.000Z");
    const result = repo.get();
    expect(result.body).toBe("second");
    expect(result.display_name).toBe("A"); // preserved from first save
    expect(result.locale).toBe("en-US"); // overridden
    expect(result.updated_at).toBe("2026-05-28T00:00:00.000Z");
  });

  it("preserves section_tags across saves", () => {
    repo.save({ body: "test", section_tags: ["tag1", "tag2"] }, "2026-05-27T00:00:00.000Z");
    let r = repo.get();
    expect(r.section_tags).toEqual(["tag1", "tag2"]);

    repo.save({ body: "updated" }, "2026-05-28T00:00:00.000Z");
    r = repo.get();
    expect(r.section_tags).toEqual(["tag1", "tag2"]);
    expect(r.body).toBe("updated");
  });

  it("saves again overwrites tags when provided", () => {
    repo.save({ body: "test", section_tags: ["old"] }, "2026-05-27T00:00:00.000Z");
    repo.save({ body: "test", section_tags: ["new"] }, "2026-05-28T00:00:00.000Z");
    expect(repo.get().section_tags).toEqual(["new"]);
  });
});
