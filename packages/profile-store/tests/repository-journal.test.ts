import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createJournalRepo } from "../src/repository/journal";

describe("journal repo", () => {
  let db: ProfileDb;
  let repo: ReturnType<typeof createJournalRepo>;
  const now = "2026-05-27T00:00:00.000Z";

  beforeEach(() => {
    db = openProfileDb(":memory:");
    repo = createJournalRepo(db);
  });

  afterEach(() => {
    db.raw.close();
  });

  describe("listDates", () => {
    it("returns empty array when no records", () => {
      expect(repo.listDates()).toEqual([]);
    });

    it("returns date summaries with counts", () => {
      repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "Entry 1",
          provenance: "user" as const,
          tags: [],
        },
        now,
      );
      repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "Entry 2",
          provenance: "user" as const,
          tags: [],
        },
        "2026-05-27T01:00:00.000Z",
      );
      repo.append(
        {
          target: "journal" as const,
          date: "2026-05-28",
          body: "Entry 3",
          provenance: "user" as const,
          tags: [],
        },
        "2026-05-28T00:00:00.000Z",
      );

      const dates = repo.listDates();
      expect(dates).toHaveLength(2);
      expect(dates[0]!.date).toBe("2026-05-28");
      expect(dates[1]!.date).toBe("2026-05-27");
      expect(dates[1]!.record_count).toBe(2);
    });
  });

  describe("get", () => {
    it("returns empty records for unused date", () => {
      const result = repo.get("2026-05-27");
      expect(result.date).toBe("2026-05-27");
      expect(result.records).toEqual([]);
    });

    it("returns records ordered by ordinal", () => {
      repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "First",
          provenance: "user" as const,
          tags: [],
        },
        now,
      );
      repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "Second",
          provenance: "user" as const,
          tags: [],
        },
        "2026-05-27T01:00:00.000Z",
      );

      const result = repo.get("2026-05-27");
      expect(result.records).toHaveLength(2);
      expect(result.records[0]!.body).toBe("First");
      expect(result.records[0]!.ordinal).toBe(1);
      expect(result.records[1]!.body).toBe("Second");
      expect(result.records[1]!.ordinal).toBe(2);
    });
  });

  describe("append", () => {
    it("returns inserted record with correct id and ordinal", () => {
      const record = repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "Hello",
          provenance: "user" as const,
          tags: ["tag1"],
        },
        now,
      );
      expect(record.id).toBeGreaterThan(0);
      expect(record.date).toBe("2026-05-27");
      expect(record.ordinal).toBe(1);
      expect(record.body).toBe("Hello");
      expect(record.tags).toEqual(["tag1"]);
      expect(record.provenance).toBe("user");
    });

    it("increments ordinal for same date", () => {
      const r1 = repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "A",
          provenance: "user" as const,
          tags: [],
        },
        now,
      );
      const r2 = repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "B",
          provenance: "user" as const,
          tags: [],
        },
        now,
      );
      expect(r1.ordinal).toBe(1);
      expect(r2.ordinal).toBe(2);
    });

    it("starts ordinal at 1 for different dates", () => {
      repo.append(
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "A",
          provenance: "user" as const,
          tags: [],
        },
        now,
      );
      const r2 = repo.append(
        {
          target: "journal" as const,
          date: "2026-05-28",
          body: "B",
          provenance: "user" as const,
          tags: [],
        },
        now,
      );
      expect(r2.ordinal).toBe(1);
    });
  });
});
