import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createSourcesRepo } from "../src/repository/sources";
import { ProfileNotFoundError } from "../src/errors";
import type { SourceStored } from "@knowself/contracts";

function makeSource(overrides: Partial<SourceStored> = {}): SourceStored {
  return {
    id: overrides.id ?? "550e8400-e29b-41d4-a716-446655440000",
    kind: "file" as const,
    original_name: "test.pdf",
    mime_type: "application/pdf" as const,
    file_path: "sources/test.pdf",
    url: null,
    extracted_text: "sample text",
    truncated: false,
    char_count: 11,
    user_note: "",
    user_tags: [],
    status: "raw" as const,
    metadata: {},
    created_at: "2026-05-27T00:00:00.000Z",
    last_ingested_at: null,
    last_error: null,
    ...overrides,
  };
}

describe("sources repo", () => {
  let db: ProfileDb;
  let repo: ReturnType<typeof createSourcesRepo>;

  beforeEach(() => {
    db = openProfileDb(":memory:");
    repo = createSourcesRepo(db);
  });

  afterEach(() => {
    db.raw.close();
  });

  describe("insert + get", () => {
    it("inserts and retrieves a source", () => {
      const s = makeSource();
      repo.insert(s);
      const result = repo.get("550e8400-e29b-41d4-a716-446655440000");
      expect(result.id).toBe(s.id);
      expect(result.original_name).toBe("test.pdf");
      expect(result.extracted_text).toBe("sample text");
      expect(result.truncated).toBe(false);
      expect(result.char_count).toBe(11);
    });

    it("throws on unknown id", () => {
      expect(() => repo.get("00000000-0000-0000-0000-000000000000")).toThrow(ProfileNotFoundError);
    });
  });

  describe("list", () => {
    it("lists all sources", () => {
      repo.insert(makeSource({ id: "550e8400-e29b-41d4-a716-446655440001" }));
      repo.insert(makeSource({ id: "550e8400-e29b-41d4-a716-446655440002" }));
      const result = repo.list({ limit: 10 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it("filters by status", () => {
      repo.insert(makeSource({ id: "550e8400-e29b-41d4-a716-446655440001", status: "raw" }));
      repo.insert(makeSource({ id: "550e8400-e29b-41d4-a716-446655440002", status: "rejected" }));
      const result = repo.list({ status: "rejected" });
      expect(result.total).toBe(1);
      expect(result.items[0]!.status).toBe("rejected");
    });

    it("filters by tag", () => {
      repo.insert(
        makeSource({ id: "550e8400-e29b-41d4-a716-446655440001", user_tags: ["important"] }),
      );
      repo.insert(makeSource({ id: "550e8400-e29b-41d4-a716-446655440002", user_tags: [] }));
      const result = repo.list({ tag: "important" });
      expect(result.total).toBe(1);
    });
  });

  describe("updateStatus", () => {
    it("updates source status", () => {
      repo.insert(makeSource());
      repo.updateStatus(
        "550e8400-e29b-41d4-a716-446655440000",
        "pending_review",
        "2026-05-28T00:00:00.000Z",
      );
      const result = repo.get("550e8400-e29b-41d4-a716-446655440000");
      expect(result.status).toBe("pending_review");
      expect(result.last_ingested_at).toBe("2026-05-28T00:00:00.000Z");
    });

    it("counts sources by status", () => {
      repo.insert(makeSource({ id: "550e8400-e29b-41d4-a716-446655440001", status: "raw" }));
      repo.insert(
        makeSource({
          id: "550e8400-e29b-41d4-a716-446655440002",
          status: "pending_review",
        }),
      );
      expect(repo.countByStatus()).toMatchObject({ raw: 1, pending_review: 1 });
    });
  });

  describe("updateNote", () => {
    it("updates user note and tags", () => {
      repo.insert(makeSource());
      repo.updateNote("550e8400-e29b-41d4-a716-446655440000", "my note", ["tag1", "tag2"]);
      const result = repo.get("550e8400-e29b-41d4-a716-446655440000");
      expect(result.user_note).toBe("my note");
      expect(result.user_tags).toEqual(["tag1", "tag2"]);
    });
  });

  describe("delete", () => {
    it("deletes a source", () => {
      repo.insert(makeSource());
      repo.delete("550e8400-e29b-41d4-a716-446655440000");
      expect(() => repo.get("550e8400-e29b-41d4-a716-446655440000")).toThrow(ProfileNotFoundError);
    });
  });
});
