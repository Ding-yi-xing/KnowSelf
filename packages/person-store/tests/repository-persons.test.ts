import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPersonMeta, type PersonDb } from "../src/db";
import { createPersonsRepo, type PersonsRepo } from "../src/repository/persons";
import { createAliasesRepo } from "../src/repository/aliases";
import { PersonNotFoundError } from "../src/errors";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const LATER = "2026-09-10T11:00:00+08:00";

let dir: string;
let opened: PersonDb[];
let db: PersonDb;
let repo: PersonsRepo;

beforeEach(() => {
  dir = makeTempDir();
  opened = [];
  db = openIn(dir, opened, "persons.sqlite");
  repo = createPersonsRepo(db);
});

afterEach(() => {
  closeAll(opened);
  removeTempDir(dir);
});

function insertContact(personId: string, displayName = personId): void {
  repo.insert({ person_id: personId, subject_kind: "contact", display_name: displayName }, NOW);
}

describe("repository/persons — 读", () => {
  it("get 返回 null，getOrThrow 抛 PERSON_NOT_FOUND", () => {
    expect(repo.get("missing")).toBeNull();
    expect(() => repo.getOrThrow("missing")).toThrow(PersonNotFoundError);
    try {
      repo.getOrThrow("missing");
    } catch (error) {
      expect((error as PersonNotFoundError).code).toBe("PERSON_NOT_FOUND");
    }
  });

  it("getSelf：'me' 恰好一行，重复调用不新建", () => {
    const self = repo.getSelf();
    expect(self.person_id).toBe("me");
    expect(self.subject_kind).toBe("self");
    expect(repo.getSelf().person_id).toBe("me");
    expect(repo.count({ subject_kind: "self" })).toBe(1);
  });

  it("insert 默认值齐备（remark/sort_key/status/manual_locked/统计列）", () => {
    const row = repo.insert(
      { person_id: "p1", subject_kind: "contact", display_name: "张三" },
      NOW,
    );
    expect(row.remark).toBe("");
    expect(row.sort_key).toBe("");
    expect(row.avatar_ref).toBeNull();
    expect(row.status).toBe("active");
    expect(row.merged_into).toBeNull();
    expect(row.manual_locked).toBe(false);
    expect(row.msg_count).toBe(0);
    expect(row.conv_count).toBe(0);
    expect(row.profile_json).toBe("{}");
    expect(row.created_at).toBe(NOW);
    expect(row.updated_at).toBe(NOW);
  });

  it("list / count 支持 subject_kind + status + keyword + 分页", () => {
    insertContact("p1", "张三");
    insertContact("p2", "李四");
    insertContact("p3", "张四");
    expect(repo.count()).toBe(4); // me + 3
    expect(repo.count({ subject_kind: "contact" })).toBe(3);
    expect(
      repo
        .list({ keyword: "张" })
        .map((r) => r.person_id)
        .sort(),
    ).toEqual(["p1", "p3"]);
    expect(repo.list({ limit: 2 }).length).toBe(2);
    expect(repo.list({ limit: 2, offset: 2 }).length).toBe(2);
    repo.setManualLocked("p2", true, NOW);
    repo.updateManual("p2", { status: "archived" }, NOW);
    expect(repo.count({ status: "archived" })).toBe(1);
    expect(repo.list({ status: "archived" }).map((r) => r.person_id)).toEqual(["p2"]);
  });
});

describe("repository/persons — 写与锁定避让", () => {
  it("updateManual 置 manual_locked=1 并落 patch", () => {
    insertContact("p1");
    const row = repo.updateManual("p1", { display_name: "老张", remark: "同事" }, LATER);
    expect(row.display_name).toBe("老张");
    expect(row.remark).toBe("同事");
    expect(row.manual_locked).toBe(true);
    expect(row.updated_at).toBe(LATER);
  });

  it("updateAutoStats：未锁则更新；锁定则跳过并回报 skipped_locked", () => {
    insertContact("p1");
    const ok = repo.updateAutoStats("p1", { msg_count: 12, conv_count: 3 }, LATER);
    expect(ok).toEqual({ updated: true, skipped_locked: false });
    expect(repo.getOrThrow("p1").msg_count).toBe(12);

    repo.setManualLocked("p1", true, LATER);
    const skipped = repo.updateAutoStats("p1", { msg_count: 99 }, LATER);
    expect(skipped).toEqual({ updated: false, skipped_locked: true });
    expect(repo.getOrThrow("p1").msg_count).toBe(12);

    repo.setManualLocked("p1", false, LATER);
    expect(repo.updateAutoStats("p1", { msg_count: 99 }, LATER).updated).toBe(true);
    expect(repo.getOrThrow("p1").msg_count).toBe(99);
  });

  it("updateAutoStats：空 patch 不写库", () => {
    insertContact("p1");
    expect(repo.updateAutoStats("p1", {}, LATER)).toEqual({
      updated: false,
      skipped_locked: false,
    });
    expect(repo.getOrThrow("p1").updated_at).toBe(NOW);
  });

  it("updateProfileJson：写 profile_json + 版本位 produced_by.profile；锁定则跳过", () => {
    insertContact("p1");
    const ok = repo.updateProfileJson("p1", '{"topics":[]}', "person-store:profile-v1", LATER);
    expect(ok).toEqual({ updated: true, skipped_locked: false });
    expect(repo.getOrThrow("p1").profile_json).toBe('{"topics":[]}');
    expect(getPersonMeta(db, "produced_by.profile")).toBe("person-store:profile-v1");

    repo.setManualLocked("p1", true, LATER);
    expect(repo.updateProfileJson("p1", "{}", "v2", LATER)).toEqual({
      updated: false,
      skipped_locked: true,
    });
    expect(repo.getOrThrow("p1").profile_json).toBe('{"topics":[]}');
  });

  it("setManualLocked 对不存在的人物抛 PERSON_NOT_FOUND", () => {
    expect(() => repo.setManualLocked("missing", true, NOW)).toThrow(PersonNotFoundError);
  });
});

describe("repository/persons — 归并审计（person_merges）", () => {
  it("insertMerge / getMerge / listMerges 过滤 / markMergeUndone", () => {
    insertContact("p1");
    insertContact("p2");
    const merge = repo.insertMerge({
      merge_id: "m1",
      from_person_id: "p1",
      into_person_id: "p2",
      performed_by: "manual",
      merged_at: NOW,
      reason: "同手机号",
      evidence: '{"alias_ids":["a1"]}',
      confidence: 0.95,
    });
    expect(merge.reason).toBe("同手机号");
    expect(merge.undone_at).toBeNull();
    expect(repo.getMerge("m1")?.merge_id).toBe("m1");
    expect(repo.getMerge("nope")).toBeNull();
    expect(repo.listMerges({ from_person_id: "p1" }).length).toBe(1);
    expect(repo.listMerges({ into_person_id: "p9" }).length).toBe(0);
    expect(repo.listMerges({ undone: false }).length).toBe(1);

    repo.markMergeUndone("m1", '{"alias_ids":["a1"],"undone":true}', LATER);
    expect(repo.getMerge("m1")?.undone_at).toBe(LATER);
    expect(repo.getMerge("m1")?.evidence).toBe('{"alias_ids":["a1"],"undone":true}');
    expect(repo.listMerges({ undone: true }).length).toBe(1);
    expect(repo.listMerges({ undone: false }).length).toBe(0);
  });

  it("markMerged / listMerged / unmarkMerged 只动人物行状态", () => {
    insertContact("p1");
    insertContact("p2");
    repo.markMerged("p1", "p2", LATER);
    const merged = repo.getOrThrow("p1");
    expect(merged.status).toBe("merged");
    expect(merged.merged_into).toBe("p2");
    expect(repo.listMerged("p2").map((r) => r.person_id)).toEqual(["p1"]);

    repo.unmarkMerged("p1", LATER);
    const restored = repo.getOrThrow("p1");
    expect(restored.status).toBe("active");
    expect(restored.merged_into).toBeNull();
    expect(repo.listMerged("p2")).toEqual([]);
  });
});

describe("repository/persons — recomputeStats", () => {
  function seedChat(): void {
    const aliases = createAliasesRepo(db);
    aliases.insert(
      {
        alias_id: "a1",
        person_id: "p1",
        platform: "wechat",
        alias_kind: "platform_uid",
        alias: "wxid_1",
        normalized: "wxid_1",
        source: "extractor",
      },
      NOW,
    );
    db.prepare(
      `INSERT INTO chat_conversations (conversation_id, platform, kind, created_at, updated_at)
       VALUES ('wechat:c1', 'wechat', 'direct', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO chat_conversations (conversation_id, platform, kind, created_at, updated_at)
       VALUES ('wechat:g1', 'wechat', 'group', ?, ?)`,
    ).run(NOW, NOW);
    const insertMsg = db.prepare(
      `INSERT INTO chat_messages
         (message_id, conversation_id, platform, sender_id, role, ts_ms, msg_date, batch_id, ingested_at)
       VALUES (?, ?, 'wechat', 'wxid_1', 'other', ?, ?, 'b1', ?)`,
    );
    insertMsg.run("m1", "wechat:c1", 1_700_000_000_000, "2023-11-15", NOW);
    insertMsg.run("m2", "wechat:c1", 1_700_000_060_000, "2023-11-15", NOW);
    insertMsg.run("m3", "wechat:g1", 1_700_000_120_000, "2023-11-15", NOW);
  }

  it("由 v_chat_messages 聚合 msg_count / conv_count / first / last，且幂等", () => {
    insertContact("p1");
    seedChat();
    const row = repo.recomputeStats("p1", LATER);
    expect(row.msg_count).toBe(3);
    expect(row.conv_count).toBe(2);
    expect(row.first_msg_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(row.last_msg_at).toBe(new Date(1_700_000_120_000).toISOString());
    expect(row.updated_at).toBe(LATER);
    expect(repo.recomputeStats("p1", LATER)).toEqual(row);
  });

  it("锁定行只读：recomputeStats 不覆盖 manual_locked=1 的行", () => {
    insertContact("p1");
    seedChat();
    repo.updateManual("p1", { display_name: "锁住的人" }, LATER);
    const row = repo.recomputeStats("p1", LATER);
    expect(row.msg_count).toBe(0);
    expect(row.updated_at).toBe(LATER);
  });

  it("无消息的人物聚合为 0 / NULL", () => {
    insertContact("p1");
    const row = repo.recomputeStats("p1", LATER);
    expect(row.msg_count).toBe(0);
    expect(row.conv_count).toBe(0);
    expect(row.first_msg_at).toBeNull();
    expect(row.last_msg_at).toBeNull();
  });
});
