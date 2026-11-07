import { describe, it, expect, vi } from "vitest";
import { acceptProposal, editProposal, rejectProposal, listProposals } from "../src/proposals";
import { createProfileStore, type ProfileStore } from "@knowself/profile-store";
import type { IngestionProposal } from "@knowself/contracts";

const now = () => "2026-01-01T00:00:00.000Z";

const pendingProposal: IngestionProposal = {
  id: "10000000-0000-0000-0000-000000000001",
  source_id: "00000000-0000-0000-0000-000000000001",
  target: {
    kind: "card_section",
    card_key: "identity",
    section: "bio",
  },
  proposed_body: "Born in Beijing, 1990.",
  reasoning: "Basic bio info",
  source_excerpts: [],
  produced_by_provider: "test-provider",
  status: "pending",
  user_edited_body: null,
  created_at: now(),
  decided_at: null,
};

function mockStore(status: IngestionProposal["status"] = "pending"): ProfileStore {
  let current = { ...pendingProposal, status };
  const links: any[] = [];
  const writeCalls: any[] = [];

  return {
    core: {} as any,
    cards: {} as any,
    journal: {} as any,
    sources: {
      list: vi.fn(() => ({ items: [], total: 0 })),
      get: vi.fn(() => ({}) as any),
      insert: vi.fn(),
      updateStatus: vi.fn(),
      updateError: vi.fn(),
      updateNote: vi.fn(),
      countByStatus: vi.fn(() => ({})),
      latestDistillAt: vi.fn(() => null),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    proposals: {
      insertMany: vi.fn(),
      listBySource: vi.fn(() => [current]),
      get: vi.fn(() => current),
      decide: vi.fn((_id, _decision, _now) => {
        if (_decision.decision === "accept") {
          current = { ...current, status: "accepted", decided_at: _now };
        } else if (_decision.decision === "edit") {
          current = {
            ...current,
            status: "edited",
            user_edited_body: _decision.body,
            decided_at: _now,
          };
        } else {
          current = { ...current, status: "rejected", decided_at: _now };
        }
        return current;
      }),
    },
    links: {
      insert: vi.fn((l: any) => {
        links.push(l);
      }),
      listForProfile: vi.fn(() => ({ links: [], sources: [] })),
      listForSource: vi.fn(() => []),
    },
    events: {} as any,
    write: vi.fn((req: any) => {
      writeCalls.push(req);
    }),
    transaction: vi.fn((fn: () => unknown) => fn()),
    exportProfile: vi.fn() as any,
    exportProfileBuffer: vi.fn() as any,
    close: vi.fn(),
  };
}

describe("acceptProposal", () => {
  it("accepts a pending proposal and calls store.write", () => {
    const store = mockStore("pending");
    const deps = { store, now };

    const result = acceptProposal(deps, pendingProposal.id);

    expect(result.status).toBe("accepted");
    expect(store.write).toHaveBeenCalled();
    expect(store.links.insert).toHaveBeenCalled();
  });

  it("throws ProposalNotPendingError for non-pending proposal", () => {
    const store = mockStore("accepted");
    const deps = { store, now };

    expect(() => acceptProposal(deps, pendingProposal.id)).toThrow();
  });

  it("rolls back profile writes when link insertion fails", () => {
    const store = createProfileStore({
      dbPath: ":memory:",
      sourcesDir: "unused",
      exportsDir: "unused",
    });
    store.sources.insert({
      id: pendingProposal.source_id,
      kind: "file",
      original_name: "source.txt",
      mime_type: "text/plain",
      file_path: null,
      url: null,
      extracted_text: "Born in Beijing, 1990.",
      truncated: false,
      char_count: 23,
      user_note: "",
      user_tags: [],
      status: "raw",
      metadata: {},
      created_at: now(),
      last_ingested_at: null,
      last_error: null,
    });
    store.proposals.insertMany([pendingProposal]);
    store.links.insert = vi.fn(() => {
      throw new Error("link failed");
    }) as typeof store.links.insert;

    expect(() => acceptProposal({ store, now }, pendingProposal.id)).toThrow("link failed");
    expect(store.proposals.get(pendingProposal.id).status).toBe("pending");
    expect(() => store.cards.get("identity")).toThrow();

    store.close();
  });
});

describe("editProposal", () => {
  it("edits and accepts a pending proposal", () => {
    const store = mockStore("pending");
    const deps = { store, now };

    const result = editProposal(deps, pendingProposal.id, "Edited body text");

    expect(result.status).toBe("edited");
    expect(result.user_edited_body).toBe("Edited body text");
  });
});

describe("rejectProposal", () => {
  it("rejects a pending proposal without calling store.write", () => {
    const store = mockStore("pending");
    const deps = { store, now };

    const result = rejectProposal(deps, pendingProposal.id);

    expect(result.status).toBe("rejected");
    expect(store.write).not.toHaveBeenCalled();
  });
});

describe("listProposals", () => {
  it("returns proposals for a source", () => {
    const store = mockStore("pending");
    const deps = { store, now };

    const result = listProposals(deps, pendingProposal.source_id);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(pendingProposal.id);
  });
});
