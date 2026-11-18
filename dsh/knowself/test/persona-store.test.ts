import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersonaFromDisk, personaFilePath, savePersonaToDisk } from "../src/persona-store.js";
import type { ReplyPersona } from "../src/wechat-persona.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-persona-"));
  dirs.push(dir);
  return dir;
}

function persona(overrides: Partial<ReplyPersona> = {}): ReplyPersona {
  return {
    target: { summary: "熟人", traits: [], psychology: [], communication: [], taboos: [], relationship: "" },
    voice: { tone: "直白", length: "5 字", habits: [], addressing: "你" },
    version: 2,
    generated_at: "2026-11-18T00:00:00.000Z",
    source_messages: 120,
    degraded: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persona-store", () => {
  it("round-trips a persona through disk", () => {
    const dataDir = tempDir();
    expect(savePersonaToDisk(dataDir, "wxid_abc", persona())).toBe(true);
    const loaded = loadPersonaFromDisk(dataDir, "wxid_abc");
    expect(loaded?.voice.tone).toBe("直白");
    expect(loaded?.version).toBe(2);
  });

  it("returns null when the file is missing", () => {
    expect(loadPersonaFromDisk(tempDir(), "wxid_missing")).toBeNull();
  });

  it("returns null for an empty or broken file so it gets regenerated", () => {
    const dataDir = tempDir();
    savePersonaToDisk(dataDir, "wxid_abc", persona());
    const file = personaFilePath(dataDir, "wxid_abc");
    writeFileSync(file, "   ", "utf8");
    expect(loadPersonaFromDisk(dataDir, "wxid_abc")).toBeNull();
    writeFileSync(file, "{not json", "utf8");
    expect(loadPersonaFromDisk(dataDir, "wxid_abc")).toBeNull();
  });

  it("keeps user edits authoritative on the next load", () => {
    const dataDir = tempDir();
    savePersonaToDisk(dataDir, "wxid_abc", persona());
    const file = personaFilePath(dataDir, "wxid_abc");
    writeFileSync(file, JSON.stringify(persona({ voice: { tone: "我改过了", length: "", habits: [], addressing: "" } })), "utf8");
    expect(loadPersonaFromDisk(dataDir, "wxid_abc")?.voice.tone).toBe("我改过了");
  });

  it("turns unsafe contact ids into a safe file name", () => {
    const file = personaFilePath("/tmp/x", "wechat:wxid_abc/../evil");
    expect(file).not.toContain("..");
    expect(file).not.toContain(":");
  });
});
