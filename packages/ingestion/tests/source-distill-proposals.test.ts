import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestionProposal, SourceStored } from "@knowself/contracts";
import { createProfileStore, type ProfileStore } from "../../profile-store/src";
import { acceptSourceDistillProposal } from "../src/proposals";
import { ProposalNotPendingError } from "../src/errors";

const NOW = "2026-11-14T12:00:00.000Z";
const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

function makeSource(): SourceStored {
  return {
    id: SOURCE_ID,
    kind: "paste",
    original_name: "session turn",
    mime_type: "text/plain",
    file_path: null,
    url: null,
    extracted_text: "I prefer working from a written decision log.",
    truncated: false,
    char_count: 44,
    user_note: "",
    user_tags: ["dsh-session"],
    status: "raw",
    metadata: {},
    created_at: NOW,
    last_ingested_at: null,
    last_error: null,
  };
}

function makeReview(id = "review-1"): IngestionProposal {
  return {
    id,
    source_id: SOURCE_ID,
    target: {
      kind: "source_distill",
      confidence: 0.4,
      classifier: "dsh-session-rule-v1",
      reason: "conversation has possible decision context",
    },
    proposed_body: "Distill this reviewed conversation.",
    reasoning: "low confidence session capture",
    source_excerpts: [],
    produced_by_provider: "dsh-session-rule-v1",
    status: "pending",
    user_edited_body: null,
    created_at: NOW,
    decided_at: null,
  };
}

function makeStore(): ProfileStore {
  const store = createProfileStore({ dbPath: ":memory:", sourcesDir: "unused", exportsDir: "unused" });
  store.sources.insert(makeSource());
  return store;
}

function makeDeps(store: ProfileStore, requestStructured: () => Promise<unknown>) {
  return {
    store,
    now: () => NOW,
    distillProviderId: "distill-provider",
    providerAdapter: {
      pickProvider: vi.fn(() => ({ id: "distill-provider" })),
      requestStructured: vi.fn(requestStructured),
    } as never,
  };
}

const MODEL_OUTPUT = {
  writes: [{ target: { targetKind: "core" }, body: "Uses written decision logs.", reasoning: "direct statement", excerpts: [] }],
};

describe("source_distill proposal acceptance", () => {
  const stores: ProfileStore[] = [];

  afterEach(() => {
    while (stores.length > 0) stores.pop()?.close();
  });

  it("claims once across concurrent acceptance and creates content proposals once", async () => {
    const store = makeStore();
    stores.push(store);
    store.proposals.insertMany([makeReview()]);
    const deps = makeDeps(store, async () => MODEL_OUTPUT);

    const results = await Promise.allSettled([
      acceptSourceDistillProposal(deps, "review-1"),
      acceptSourceDistillProposal(deps, "review-1"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toBeInstanceOf(
      ProposalNotPendingError,
    );
    expect((deps.providerAdapter as { requestStructured: ReturnType<typeof vi.fn> }).requestStructured).toHaveBeenCalledTimes(1);
    expect(store.proposals.get("review-1").status).toBe("accepted");
    expect(store.proposals.listBySource(SOURCE_ID).filter((item) => item.target.kind === "core")).toHaveLength(1);
  });

  it("releases the claim after a model failure so it can be retried", async () => {
    const store = makeStore();
    stores.push(store);
    store.proposals.insertMany([makeReview()]);
    const deps = makeDeps(store, async () => {
      throw new Error("provider unavailable");
    });

    await expect(acceptSourceDistillProposal(deps, "review-1")).rejects.toThrow("provider unavailable");

    expect(store.proposals.get("review-1").status).toBe("pending");
    expect(store.sources.get(SOURCE_ID).last_error).toContain("provider unavailable");
  });

  it("reuses existing content proposals but still accepts the review request", async () => {
    const store = makeStore();
    stores.push(store);
    store.proposals.insertMany([
      makeReview(),
      {
        ...makeReview("content-1"),
        target: { kind: "core" },
        proposed_body: "Existing content proposal.",
      },
    ]);
    const deps = makeDeps(store, async () => MODEL_OUTPUT);

    const accepted = await acceptSourceDistillProposal(deps, "review-1");

    expect(accepted.status).toBe("accepted");
    expect((deps.providerAdapter as { requestStructured: ReturnType<typeof vi.fn> }).requestStructured).not.toHaveBeenCalled();
  });
});
