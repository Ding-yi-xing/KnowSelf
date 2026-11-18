import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createIdentityStatesRepo } from "../src/repository/identity-states";

let db: ProfileDb;

beforeEach(() => {
  db = openProfileDb(":memory:");
});

afterEach(() => {
  db.raw.close();
});

const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-10T00:00:00.000Z";
const T2 = "2026-11-18T00:00:00.000Z";

describe("identity states", () => {
  it("keeps enrollment and work states side by side", () => {
    const repo = createIdentityStatesRepo(db);
    repo.append({ category: "enrollment", text: "在读", source_quote: "学业搞好" }, T0);
    repo.append({ category: "work", text: "在找工作", source_quote: "翻招聘信息" }, T1);

    const active = repo.listActive();
    expect(active.map((state) => state.text).sort()).toEqual(["在找工作", "在读"].sort());
  });

  it("a newer state in the same category invalidates the older one", () => {
    const repo = createIdentityStatesRepo(db);
    repo.append({ category: "work", text: "在找工作", source_quote: "投简历" }, T0);
    repo.append({ category: "work", text: "入职了", source_quote: "我今天入职" }, T2);

    const active = repo.listActive(["work"]);
    expect(active).toHaveLength(1);
    expect(active[0]?.text).toBe("入职了");

    // 旧记录不删除，保留历史（可回溯）。
    const all = repo.listAll();
    expect(all).toHaveLength(2);
    expect(all.find((state) => state.text === "在找工作")?.invalid_at).toBe(T2);
  });

  it("does not duplicate an identical active state", () => {
    const repo = createIdentityStatesRepo(db);
    repo.append({ category: "work", text: "在找工作", source_quote: "投简历" }, T0);
    repo.append({ category: "work", text: "在找工作", source_quote: "又投了一次" }, T1);
    expect(repo.listActive()).toHaveLength(1);
    expect(repo.listAll()).toHaveLength(1);
  });

  it("trims and caps text and quote so the prompt cannot grow", () => {
    const repo = createIdentityStatesRepo(db);
    const state = repo.append(
      { category: "other", text: "长".repeat(100), source_quote: "引".repeat(300) },
      T0,
    );
    expect(state.text.length).toBe(60);
    expect(state.source_quote.length).toBe(120);
  });
});
