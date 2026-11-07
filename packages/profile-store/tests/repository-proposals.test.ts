import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createProposalsRepo } from "../src/repository/proposals";
import { createSourcesRepo } from "../src/repository/sources";
import { ProfileNotFoundError, ConstraintViolationError } from "../src/errors";
import type { IngestionProposal, SourceStored } from "@knowself/contracts";

const SOURCE_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeSource(overrides: Partial<SourceStored> = {}): SourceStored {
  return {
    id: overrides.id ?? SOURCE_ID,
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
    ...overrides,
  };
}

function makeProposal(overrides: Partial<IngestionProposal> = {}): IngestionProposal {
  return {
    id: overrides.id ?? "550e8400-e29b-41d4-a716-446655441001",
    source_id: SOURCE_ID,
    target: { kind: "core" },
    proposed_body: "...",
    reasoning: "...",
    source_excerpts: [{ start: 0, end: 10 }],
    produced_by_provider: "deepseek-flash",
    status: "pending",
    user_edited_body: null,
    created_at: "2026-05-27T00:00:00.000Z",
    decided_at: null,
    ...overrides,
  };
}

describe("proposals repo", () => {
  let db: ProfileDb;
  let repo: ReturnType<typeof createProposalsRepo>;

  beforeEach(() => {
    db = openProfileDb(":memory:");
    createSourcesRepo(db).insert(makeSource());
    repo = createProposalsRepo(db);
  });

  afterEach(() => {
    db.raw.close();
  });

  it("listProposals — empty list", () => {
    const result = repo.listBySource(SOURCE_ID);
    expect(result).toEqual([]);
  });

  it("listProposals — multiple proposals ordered by created_at DESC", () => {
    const p1 = makeProposal({ id: "p001", created_at: "2026-05-27T00:00:00.000Z" });
    const p2 = makeProposal({ id: "p002", created_at: "2026-05-27T01:00:00.000Z" });
    const p3 = makeProposal({ id: "p003", created_at: "2026-05-27T02:00:00.000Z" });
    repo.insertMany([p1, p2, p3]);

    const result = repo.listBySource(SOURCE_ID);
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe("p003");
    expect(result[1]!.id).toBe("p002");
    expect(result[2]!.id).toBe("p001");
  });

  it("getProposal — by ID", () => {
    repo.insertMany([makeProposal()]);
    const result = repo.get("550e8400-e29b-41d4-a716-446655441001");
    expect(result.target).toEqual({ kind: "core" });
    expect(result.proposed_body).toBe("...");
    expect(result.source_excerpts).toEqual([{ start: 0, end: 10 }]);
    expect(result.status).toBe("pending");
    expect(result.decided_at).toBeNull();
  });

  it("getProposal — not found returns null", () => {
    expect(() => repo.get("00000000-0000-0000-0000-000000000000")).toThrow(ProfileNotFoundError);
  });

  it("createProposal — inserts and returns ID", () => {
    repo.insertMany([makeProposal({ id: "new-proposal-1" })]);
    const result = repo.get("new-proposal-1");
    expect(result.id).toBe("new-proposal-1");
    expect(result.status).toBe("pending");
  });

  it("updateProposalStatus — status change", () => {
    const NOW = "2026-05-28T12:00:00.000Z";
    repo.insertMany([makeProposal()]);
    const r1 = repo.decide("550e8400-e29b-41d4-a716-446655441001", { decision: "accept" }, NOW);
    expect(r1.status).toBe("accepted");
    expect(r1.decided_at).toBe(NOW);

    repo.insertMany([makeProposal({ id: "edit-1" })]);
    const r2 = repo.decide("edit-1", { decision: "edit", body: "edited text" }, NOW);
    expect(r2.status).toBe("edited");
    expect(r2.user_edited_body).toBe("edited text");

    repo.insertMany([makeProposal({ id: "reject-1" })]);
    const r3 = repo.decide("reject-1", { decision: "reject" }, NOW);
    expect(r3.status).toBe("rejected");
    expect(r3.user_edited_body).toBeNull();
  });

  it("deleteProposal — valid delete", () => {
    repo.insertMany([makeProposal()]);
    repo.listBySource(SOURCE_ID); // ensure it exists
    // proposals repo has no explicit delete; deleting via raw SQL
    db.raw
      .prepare("DELETE FROM ingestion_proposals WHERE id = ?")
      .run("550e8400-e29b-41d4-a716-446655441001");
    const result = repo.listBySource(SOURCE_ID);
    expect(result).toHaveLength(0);
  });

  it("deleteProposal — not found returns false", () => {
    const info = db.raw
      .prepare("DELETE FROM ingestion_proposals WHERE id = ?")
      .run("00000000-0000-0000-0000-000000000000");
    expect(info.changes).toBe(0);
  });

  it("decide — double accept throws ConstraintViolationError", () => {
    const NOW = "2026-05-28T12:00:00.000Z";
    repo.insertMany([makeProposal()]);
    repo.decide("550e8400-e29b-41d4-a716-446655441001", { decision: "accept" }, NOW);
    expect(() =>
      repo.decide("550e8400-e29b-41d4-a716-446655441001", { decision: "accept" }, NOW),
    ).toThrow(ConstraintViolationError);
  });

  it("JSON corrupt — listBySource does not crash, target falls back to default", () => {
    repo.insertMany([makeProposal()]);
    db.raw
      .prepare("UPDATE ingestion_proposals SET target_ref = ? WHERE id = ?")
      .run("{{{", "550e8400-e29b-41d4-a716-446655441001");

    const result = repo.listBySource(SOURCE_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.target.kind).toBe("core");
  });
});
