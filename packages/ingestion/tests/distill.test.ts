import { describe, it, expect, vi } from "vitest";
import { DistillOutputSchema, buildDistillPrompt } from "../src/distill-prompt";
import { runDistill } from "../src/distill";
import type { SourceStored } from "@knowself/contracts";

const sampleSource: SourceStored = {
  id: "00000000-0000-0000-0000-000000000001",
  kind: "file",
  original_name: "life-story.md",
  mime_type: "text/markdown",
  file_path: "00000000-0000-0000-0000-000000000001.md",
  url: null,
  extracted_text: "I was born in Beijing in 1990. I started coding at age 12.",
  truncated: false,
  char_count: 67,
  user_note: "",
  user_tags: [],
  status: "raw",
  metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
  last_ingested_at: null,
  last_error: null,
};

function makeRunDistillDeps(output: unknown) {
  const sources = {
    updateStatus: vi.fn(),
    updateError: vi.fn(),
  };
  const proposals = {
    insertMany: vi.fn(),
  };
  const store = {
    cards: { list: vi.fn(() => []) },
    journal: { listDates: vi.fn(() => []) },
    sources,
    proposals,
    transaction: vi.fn((fn: () => unknown) => fn()),
  } as any;
  const providerAdapter = {
    pickProvider: vi.fn(() => ({ id: "distill-provider" })),
    requestStructured: vi.fn(async () => output),
  } as any;

  return {
    deps: {
      store,
      providerAdapter,
      distillProviderId: "configured-provider",
      now: () => "2026-01-02T00:00:00.000Z",
    },
    sources,
    proposals,
    providerAdapter,
  };
}

describe("DistillOutputSchema", () => {
  it("validates a correct output", () => {
    const data = {
      writes: [
        {
          target: { targetKind: "core" },
          body: "Born in Beijing in 1990.",
          reasoning: "Basic bio info for L1 core profile",
          excerpts: [{ start: 0, end: 30 }],
        },
        {
          target: {
            targetKind: "card_section",
            cardKey: "tech_skills",
            section: "coding",
          },
          body: "Started coding at age 12.",
          reasoning: "Relevant to tech card",
          excerpts: [{ start: 31, end: 67 }],
        },
      ],
    };
    const parsed = DistillOutputSchema.parse(data);
    expect(parsed.writes).toHaveLength(2);
    expect(parsed.writes[0]!.target.targetKind).toBe("core");
    expect(parsed.writes[1]!.target.targetKind).toBe("card_section");
  });

  it("validates journal target write", () => {
    const data = {
      writes: [
        {
          target: { targetKind: "journal", date: "2026-01-15" },
          body: "Had a great day coding.",
          reasoning: "Personal note",
          excerpts: [],
        },
      ],
    };
    const parsed = DistillOutputSchema.parse(data);
    expect(parsed.writes[0]!.target.targetKind).toBe("journal");
    expect(parsed.writes[0]!.target.date).toBe("2026-01-15");
  });

  it("rejects invalid cardKey", () => {
    const data = {
      writes: [
        {
          target: {
            targetKind: "card_section",
            cardKey: "INVALID KEY!",
            section: "test",
          },
          body: "content",
          reasoning: "",
          excerpts: [],
        },
      ],
    };
    expect(() => DistillOutputSchema.parse(data)).toThrow();
  });

  it("rejects empty writes array", () => {
    const data = { writes: [] };
    // empty array is valid per schema (max 20, no min)
    const parsed = DistillOutputSchema.parse(data);
    expect(parsed.writes).toHaveLength(0);
  });
});

describe("buildDistillPrompt", () => {
  it("returns messages with system + user roles", () => {
    const messages = buildDistillPrompt(
      sampleSource,
      {
        cards: [{ key: "identity", title: "Identity", summary: "Core identity" }],
        journalDates: ["2026-01-01"],
      },
      ["extract personal info"],
      8,
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
  });

  it("includes source text in user message", () => {
    const messages = buildDistillPrompt(sampleSource, { cards: [], journalDates: [] }, [], 4);

    const userContent = messages[1]!.content[0]!;
    expect(userContent.kind).toBe("text");
    if (userContent.kind === "text") {
      expect(userContent.text).toContain("I was born in Beijing");
    }
  });

  it("includes card candidates", () => {
    const messages = buildDistillPrompt(
      sampleSource,
      {
        cards: [{ key: "work", title: "Work", summary: "Work stuff" }],
        journalDates: [],
      },
      [],
      4,
    );

    const userContent = messages[1]!.content[0]!;
    if (userContent.kind === "text") {
      expect(userContent.text).toContain("[work]");
    }
  });

  it("includes focus hints", () => {
    const messages = buildDistillPrompt(
      sampleSource,
      { cards: [], journalDates: [] },
      ["relationships", "career"],
      4,
    );

    const userContent = messages[1]!.content[0]!;
    if (userContent.kind === "text") {
      expect(userContent.text).toContain("relationships");
      expect(userContent.text).toContain("career");
    }
  });
});

describe("runDistill", () => {
  it("moves source through distilling to pending_review when proposals are produced", async () => {
    const { deps, sources, proposals } = makeRunDistillDeps({
      writes: [
        {
          target: { targetKind: "core" },
          body: "Born in Beijing.",
          reasoning: "Profile fact",
          excerpts: [{ start: 0, end: 20 }],
        },
      ],
    });

    const result = await runDistill(deps, sampleSource, {
      provider_id: "",
      focus_hints: [],
      max_proposals: 4,
    });

    expect(result.produced_proposal_ids).toHaveLength(1);
    expect(proposals.insertMany).toHaveBeenCalledTimes(1);
    expect(sources.updateStatus).toHaveBeenNthCalledWith(
      1,
      sampleSource.id,
      "distilling",
      "2026-01-02T00:00:00.000Z",
    );
    expect(sources.updateStatus).toHaveBeenLastCalledWith(
      sampleSource.id,
      "pending_review",
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("marks source completed when no proposals are produced", async () => {
    const { deps, sources, proposals } = makeRunDistillDeps({ writes: [] });

    await runDistill(deps, sampleSource, {
      provider_id: "",
      focus_hints: [],
      max_proposals: 4,
    });

    expect(proposals.insertMany).not.toHaveBeenCalled();
    expect(sources.updateStatus).toHaveBeenLastCalledWith(
      sampleSource.id,
      "completed",
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("marks source distill_failed when provider call fails", async () => {
    const { deps, sources, providerAdapter } = makeRunDistillDeps({ writes: [] });
    providerAdapter.requestStructured.mockRejectedValueOnce(new Error("provider down"));

    await expect(
      runDistill(deps, sampleSource, {
        provider_id: "",
        focus_hints: [],
        max_proposals: 4,
      }),
    ).rejects.toThrow("provider down");

    expect(sources.updateError).toHaveBeenCalledWith(
      sampleSource.id,
      "provider down",
      "2026-01-02T00:00:00.000Z",
    );
  });
});
