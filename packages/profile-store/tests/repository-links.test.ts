import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createLinksRepo } from "../src/repository/links";
import type { ProfileSourceLink } from "@knowself/contracts";

function insertSource(db: ProfileDb, id: string) {
  db.prepare(
    `INSERT INTO sources (id, kind, original_name, mime_type, extracted_text, truncated, char_count, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "file", "test.pdf", "application/pdf", "text", 0, 4, "raw", "2026-05-27T00:00:00.000Z");
}

function insertProposal(db: ProfileDb, id: string, sourceId: string) {
  db.prepare(
    `INSERT INTO ingestion_proposals
     (id, source_id, target_kind, target_ref, proposed_body, reasoning, source_excerpts,
      produced_by_provider, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    "core",
    JSON.stringify({ kind: "core" }),
    "body",
    "reasoning",
    "[]",
    "test-provider",
    "pending",
    "2026-05-27T00:00:00.000Z",
  );
}

const link = (overrides: Partial<ProfileSourceLink> = {}): ProfileSourceLink => ({
  profile_kind: "core",
  profile_id: "core_main",
  source_id: "550e8400-e29b-41d4-a716-446655440000",
  proposal_id: null,
  created_at: "2026-05-27T00:00:00.000Z",
  ...overrides,
});

describe("links repo", () => {
  let db: ProfileDb;
  let repo: ReturnType<typeof createLinksRepo>;

  beforeEach(() => {
    db = openProfileDb(":memory:");
    repo = createLinksRepo(db);
  });

  afterEach(() => {
    db.raw.close();
  });

  describe("insert", () => {
    it("inserts a link successfully when source exists", () => {
      insertSource(db, "550e8400-e29b-41d4-a716-446655440000");
      expect(() => repo.insert(link())).not.toThrow();
    });

    it("keeps duplicate profile/source links idempotent", () => {
      insertSource(db, "550e8400-e29b-41d4-a716-446655440000");
      insertProposal(
        db,
        "550e8400-e29b-41d4-a716-446655441001",
        "550e8400-e29b-41d4-a716-446655440000",
      );
      repo.insert(link());
      expect(() =>
        repo.insert(
          link({
            proposal_id: "550e8400-e29b-41d4-a716-446655441001",
            created_at: "2026-05-28T00:00:00.000Z",
          }),
        ),
      ).not.toThrow();

      const result = repo.listForProfile("core", "core_main");
      expect(result.links).toHaveLength(1);
      expect(result.links[0]!.proposal_id).toBe("550e8400-e29b-41d4-a716-446655441001");
    });
  });

  describe("listForProfile", () => {
    it("returns empty for profile with no links", () => {
      const result = repo.listForProfile("core", "core_main");
      expect(result.links).toEqual([]);
      expect(result.sources).toEqual([]);
    });

    it("returns links and sources for linked profile", () => {
      insertSource(db, "550e8400-e29b-41d4-a716-446655440000");
      repo.insert(link());
      const result = repo.listForProfile("core", "core_main");
      expect(result.links).toHaveLength(1);
      expect(result.links[0]!.profile_kind).toBe("core");
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]!.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    });
  });

  describe("listForSource", () => {
    it("returns empty for unlinked source", () => {
      expect(repo.listForSource("550e8400-e29b-41d4-a716-446655440000")).toEqual([]);
    });

    it("returns links for a source", () => {
      insertSource(db, "550e8400-e29b-41d4-a716-446655440000");
      repo.insert(link());
      repo.insert(link({ profile_kind: "journal_record", profile_id: "journal_record:1" }));
      const result = repo.listForSource("550e8400-e29b-41d4-a716-446655440000");
      expect(result).toHaveLength(2);
    });
  });
});
