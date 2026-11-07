import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createCardsRepo } from "../src/repository/cards";
import { ProfileNotFoundError } from "../src/errors";

describe("cards repo", () => {
  let db: ProfileDb;
  let repo: ReturnType<typeof createCardsRepo>;
  const now = "2026-05-27T00:00:00.000Z";

  beforeEach(() => {
    db = openProfileDb(":memory:");
    repo = createCardsRepo(db);
  });

  afterEach(() => {
    db.raw.close();
  });

  describe("list", () => {
    it("returns empty array when no cards", () => {
      expect(repo.list()).toEqual([]);
    });

    it("returns saved cards", () => {
      repo.save({ key: "work", title: "Work", summary: "Work stuff", sections: [] }, now);
      const list = repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.key).toBe("work");
      expect(list[0]!.title).toBe("Work");
    });
  });

  describe("get", () => {
    it("throws when card not found", () => {
      expect(() => repo.get("nonexistent")).toThrow(ProfileNotFoundError);
    });

    it("returns card with sections after save", () => {
      repo.save(
        {
          key: "work",
          title: "Work",
          summary: "Summary",
          sections: [
            { title: "Sec1", body: "Body 1" },
            { title: "Sec2", body: "Body 2" },
          ],
        },
        now,
      );
      const result = repo.get("work");
      expect(result.card.key).toBe("work");
      expect(result.card.title).toBe("Work");
      expect(result.sections).toHaveLength(2);
      expect(result.sections[0]!.title).toBe("Sec1");
      expect(result.sections[0]!.ord).toBe(0);
      expect(result.sections[1]!.title).toBe("Sec2");
      expect(result.sections[1]!.ord).toBe(1);
    });
  });

  describe("save", () => {
    it("replaces card sections on re-save", () => {
      repo.save(
        {
          key: "work",
          title: "Work",
          summary: "Summary",
          sections: [{ title: "Old", body: "Old body" }],
        },
        now,
      );
      repo.save(
        {
          key: "work",
          title: "Work",
          summary: "Updated",
          sections: [{ title: "New", body: "New body" }],
        },
        "2026-05-28T00:00:00.000Z",
      );
      const result = repo.get("work");
      expect(result.card.summary).toBe("Updated");
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0]!.title).toBe("New");
    });

    it("saves tags", () => {
      repo.save(
        {
          key: "test",
          title: "Test",
          summary: "T",
          section_tags: ["tag1"],
          sections: [],
        },
        now,
      );
      expect(repo.get("test").card.section_tags).toEqual(["tag1"]);
    });
  });

  describe("appendSection", () => {
    it("creates card if not exists and adds section", () => {
      repo.appendSection(
        {
          target: "card_section" as const,
          key: "newcard",
          section: "Title",
          body: "Content",
          provenance: "user" as const,
        },
        now,
      );
      const result = repo.get("newcard");
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0]!.title).toBe("Title");
      expect(result.sections[0]!.body).toBe("Content");
    });

    it("appends second section with incremented ord", () => {
      repo.appendSection(
        {
          target: "card_section",
          key: "work",
          section: "First",
          body: "A",
          provenance: "user",
        } as const,
        now,
      );
      repo.appendSection(
        {
          target: "card_section",
          key: "work",
          section: "Second",
          body: "B",
          provenance: "user",
        } as const,
        "2026-05-28T00:00:00.000Z",
      );
      const result = repo.get("work");
      expect(result.sections).toHaveLength(2);
      expect(result.sections[0]!.ord).toBe(0);
      expect(result.sections[1]!.ord).toBe(1);
    });

    it("updates body on same title", () => {
      repo.appendSection(
        {
          target: "card_section",
          key: "work",
          section: "Title",
          body: "Original",
          provenance: "user",
        } as const,
        now,
      );
      repo.appendSection(
        {
          target: "card_section",
          key: "work",
          section: "Title",
          body: "Updated",
          provenance: "user",
        } as const,
        "2026-05-28T00:00:00.000Z",
      );
      const result = repo.get("work");
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0]!.body).toBe("Updated");
    });
  });

  describe("delete", () => {
    it("removes card and sections", () => {
      repo.save(
        {
          key: "temp",
          title: "Temp",
          summary: "T",
          sections: [{ title: "S", body: "B" }],
        },
        now,
      );
      repo.delete("temp");
      expect(() => repo.get("temp")).toThrow(ProfileNotFoundError);
      expect(repo.list()).toEqual([]);
    });

    it("does not throw on non-existent card", () => {
      repo.delete("nonexistent");
    });
  });
});
