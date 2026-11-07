import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PersonDb } from "../src/db";
import { createPersonsRepo, type PersonsRepo } from "../src/repository/persons";
import { createAliasesRepo, type AliasesRepo } from "../src/repository/aliases";
import { AliasConflictError, PersonNotFoundError } from "../src/errors";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const LATER = "2026-09-10T11:00:00+08:00";

let dir: string;
let opened: PersonDb[];
let persons: PersonsRepo;
let repo: AliasesRepo;

beforeEach(() => {
  dir = makeTempDir();
  opened = [];
  const db = openIn(dir, opened, "aliases.sqlite");
  persons = createPersonsRepo(db);
  repo = createAliasesRepo(db);
  for (const id of ["p1", "p2"]) {
    persons.insert({ person_id: id, subject_kind: "contact", display_name: id }, NOW);
  }
});

afterEach(() => {
  closeAll(opened);
  removeTempDir(dir);
});

function insertAlias(
  aliasId: string,
  personId: string,
  overrides: Partial<Parameters<AliasesRepo["insert"]>[0]> = {},
): void {
  repo.insert(
    {
      alias_id: aliasId,
      person_id: personId,
      platform: "wechat",
      alias_kind: "nickname",
      alias: aliasId,
      normalized: aliasId,
      source: "manual",
      ...overrides,
    },
    NOW,
  );
}

describe("repository/aliases — 读", () => {
  it("insert / listByPerson / listAll（platform 过滤 + 分页）", () => {
    insertAlias("a1", "p1");
    insertAlias("a2", "p1", { platform: "qq" });
    insertAlias("a3", "p2");
    expect(repo.listByPerson("p1").map((r) => r.alias_id)).toEqual(["a1", "a2"]);
    expect(repo.listAll().length).toBe(3);
    expect(repo.listAll({ platform: "qq" }).map((r) => r.alias_id)).toEqual(["a2"]);
    expect(repo.listAll({ limit: 2 }).length).toBe(2);
    expect(repo.listAll({ limit: 2, offset: 2 }).length).toBe(1);
  });

  it("findByUid / resolvePersonId 只认 alias_kind='platform_uid'", () => {
    insertAlias("a1", "p1", { alias_kind: "platform_uid", alias: "wxid_1", normalized: "wxid_1" });
    expect(repo.findByUid("wechat", "wxid_1")?.person_id).toBe("p1");
    expect(repo.findByUid("wechat", "nope")).toBeNull();
    expect(repo.resolvePersonId("wechat", "wxid_1")).toBe("p1");
    expect(repo.resolvePersonId("wechat", "a1")).toBeNull();
  });

  it("findCandidates：normalized + platform + kinds + excludePersonId + limit", () => {
    insertAlias("a1", "p1", { normalized: "老王" });
    insertAlias("a2", "p2", { normalized: "老王" });
    insertAlias("a3", "p1", { normalized: "老王", alias_kind: "remark" });
    insertAlias("a4", "p1", { normalized: "老李" });

    expect(repo.findCandidates({ normalized: "老王", platform: "wechat" }).length).toBe(3);
    expect(
      repo
        .findCandidates({ normalized: "老王", platform: "wechat", kinds: ["remark"] })
        .map((r) => r.alias_id),
    ).toEqual(["a3"]);
    expect(
      repo
        .findCandidates({ normalized: "老王", platform: "wechat", excludePersonId: "p1" })
        .map((r) => r.alias_id),
    ).toEqual(["a2"]);
    expect(repo.findCandidates({ normalized: "老王", platform: "wechat", limit: 1 }).length).toBe(
      1,
    );
    expect(repo.findCandidates({ normalized: "老王", platform: "qq" })).toEqual([]);
  });
});

describe("repository/aliases — 写", () => {
  it("upsertExtractor：首次新建，二次复用同一 alias_id 且不新建", () => {
    const input = {
      person_id: "p1",
      platform: "wechat" as const,
      alias: "wxid_1",
      normalized: "wxid_1",
      alias_kind: "platform_uid" as const,
      confidence: 1.0,
      now: NOW,
    };
    const first = repo.upsertExtractor(input);
    expect(first.created).toBe(true);
    const second = repo.upsertExtractor({ ...input, now: LATER });
    expect(second).toEqual({ alias_id: first.alias_id, created: false });
    expect(repo.listByPerson("p1").length).toBe(1);
    expect(repo.findByUid("wechat", "wxid_1")?.source).toBe("extractor");
  });

  it("upsertExtractor：platform_uid 撞他人唯一键 → ALIAS_UID_CONFLICT", () => {
    insertAlias("a1", "p1", { alias_kind: "platform_uid", alias: "wxid_1", normalized: "wxid_1" });
    try {
      repo.upsertExtractor({
        person_id: "p2",
        platform: "wechat",
        alias: "wxid_1",
        normalized: "wxid_1",
        alias_kind: "platform_uid",
        confidence: 1.0,
        now: NOW,
      });
      expect.unreachable("应当抛出 ALIAS_UID_CONFLICT");
    } catch (error) {
      expect(error).toBeInstanceOf(AliasConflictError);
      expect((error as AliasConflictError).code).toBe("ALIAS_UID_CONFLICT");
    }
  });

  it("upsertExtractor：非 platform_uid 的同名别名可属于不同人（新建行）", () => {
    insertAlias("a1", "p1", { alias: "老王", normalized: "老王" });
    const created = repo.upsertExtractor({
      person_id: "p2",
      platform: "wechat",
      alias: "老王",
      normalized: "老王",
      alias_kind: "nickname",
      confidence: 0.7,
      now: NOW,
    });
    expect(created.created).toBe(true);
    expect(repo.listByPerson("p2").length).toBe(1);
  });

  it("moveToPerson：批量迁移 person_id，空数组返回 0", () => {
    insertAlias("a1", "p1");
    insertAlias("a2", "p1");
    expect(repo.moveToPerson(["a1", "a2"], "p2", LATER)).toEqual({ moved: 2 });
    expect(repo.listByPerson("p1")).toEqual([]);
    expect(
      repo
        .listByPerson("p2")
        .map((r) => r.alias_id)
        .sort(),
    ).toEqual(["a1", "a2"]);
    expect(repo.listByPerson("p2")[0]?.updated_at).toBe(LATER);
    expect(repo.moveToPerson([], "p2", LATER)).toEqual({ moved: 0 });
  });

  it("moveToPerson：撞 (platform, alias_kind, alias, person_id) 唯一键 → ALIAS_UID_CONFLICT", () => {
    insertAlias("a1", "p1", { alias: "老王", normalized: "老王" });
    insertAlias("a2", "p2", { alias: "老王", normalized: "老王" });
    try {
      repo.moveToPerson(["a1"], "p2", LATER);
      expect.unreachable("应当抛出 ALIAS_UID_CONFLICT");
    } catch (error) {
      expect(error).toBeInstanceOf(AliasConflictError);
    }
    expect(repo.listByPerson("p1").map((r) => r.alias_id)).toEqual(["a1"]);
  });

  it("setPrimary：一个人的 is_primary 至多一行；别名不存在抛 PERSON_NOT_FOUND", () => {
    insertAlias("a1", "p1");
    insertAlias("a2", "p1");
    repo.setPrimary("a1", LATER);
    expect(repo.listByPerson("p1").find((r) => r.alias_id === "a1")?.is_primary).toBe(true);
    repo.setPrimary("a2", LATER);
    const primaries = repo.listByPerson("p1").filter((r) => r.is_primary);
    expect(primaries.map((r) => r.alias_id)).toEqual(["a2"]);
    expect(() => repo.setPrimary("missing", LATER)).toThrow(PersonNotFoundError);
  });

  it("remove：删除单个别名，其余不受影响", () => {
    insertAlias("a1", "p1");
    insertAlias("a2", "p1");
    repo.remove("a1", LATER);
    expect(repo.listByPerson("p1").map((r) => r.alias_id)).toEqual(["a2"]);
    expect(repo.listAll().length).toBe(1);
  });
});
