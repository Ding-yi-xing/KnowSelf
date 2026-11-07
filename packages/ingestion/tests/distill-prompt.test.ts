import { describe, it, expect } from "vitest";
import { buildDistillPrompt, writeToProposalTarget } from "../src/distill-prompt";
import type { SourceStored } from "@knowself/contracts";

const sampleSource: SourceStored = {
  id: "00000000-0000-0000-0000-000000000001",
  kind: "file",
  original_name: "life-story.md",
  mime_type: "text/markdown",
  file_path: "00000000-0000-0000-0000-000000000001.md",
  url: null,
  extracted_text: "I was born in Beijing in 1990.",
  truncated: false,
  char_count: 35,
  user_note: "",
  user_tags: [],
  status: "raw",
  metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
  last_ingested_at: null,
  last_error: null,
};

describe("buildDistillPrompt", () => {
  it("返回长度 2 的 messages（system + user）且 user 含 source 的 original_name / mime", () => {
    const messages = buildDistillPrompt(sampleSource, { cards: [], journalDates: [] }, [], 4);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    const content = messages[1].content[0];
    expect(content.kind).toBe("text");
    if (content.kind === "text") {
      expect(content.text).toContain("life-story.md");
      expect(content.text).toContain("text/markdown");
    }
  });

  it("在 candidates.cards 非空时把卡片清单写入 user prompt", () => {
    const messages = buildDistillPrompt(
      sampleSource,
      { cards: [{ key: "work", title: "Work", summary: "Work stuff" }], journalDates: [] },
      [],
      4,
    );
    const content = messages[1].content[0];
    if (content.kind === "text") {
      expect(content.text).toContain("[work]");
      expect(content.text).toContain("Work stuff");
    }
  });

  it("在 hints 非空时把关注角度写入 user prompt", () => {
    const messages = buildDistillPrompt(
      sampleSource,
      { cards: [], journalDates: [] },
      ["career", "relationships"],
      4,
    );
    const content = messages[1].content[0];
    if (content.kind === "text") {
      expect(content.text).toContain("career");
      expect(content.text).toContain("relationships");
    }
  });

  it("在 user_note 非空时把用户备注写入 user prompt", () => {
    const messages = buildDistillPrompt(
      { ...sampleSource, user_note: "这张图片代表我今年想养成跑步习惯" },
      { cards: [], journalDates: [] },
      [],
      4,
    );
    const content = messages[1].content[0];
    if (content.kind === "text") {
      expect(content.text).toContain("用户备注");
      expect(content.text).toContain("跑步习惯");
    }
  });

  it("在 source.extracted_text > 200000 时只截取前 200000 字符", () => {
    const longSource = {
      ...sampleSource,
      extracted_text: "x".repeat(250000),
    };
    const messages = buildDistillPrompt(longSource, { cards: [], journalDates: [] }, [], 4);
    const content = messages[1].content[0];
    if (content.kind === "text") {
      const longestXRun = content.text.match(/x+/g)!.sort((a, b) => b.length - a.length)[0];
      expect(longestXRun.length).toBe(200000);
    }
  });

  it("writeToProposalTarget 三种 targetKind 都正确转换", () => {
    const core = writeToProposalTarget({
      target: { targetKind: "core" },
      body: "bio",
      reasoning: "test",
      excerpts: [],
    });
    expect(core).toEqual({ kind: "core" });

    const card = writeToProposalTarget({
      target: { targetKind: "card_section", cardKey: "skills", section: "coding" },
      body: "code",
      reasoning: "test",
      excerpts: [],
    });
    expect(card).toEqual({ kind: "card_section", card_key: "skills", section: "coding" });

    const journal = writeToProposalTarget({
      target: { targetKind: "journal", date: "2026-05-27" },
      body: "entry",
      reasoning: "test",
      excerpts: [],
    });
    expect(journal).toEqual({ kind: "journal", date: "2026-05-27" });
  });
});
