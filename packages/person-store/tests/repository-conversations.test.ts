import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PersonDb } from "../src/db";
import { createAliasesRepo } from "../src/repository/aliases";
import { createConversationsRepo, type ConversationsRepo } from "../src/repository/conversations";
import { createMessagesRepo } from "../src/repository/messages";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const LATER = "2026-09-10T11:00:00+08:00";
const CONV = "wechat:conv-1";

let dir: string;
let db: PersonDb;
let repo: ConversationsRepo;

beforeEach(() => {
  dir = makeTempDir();
  const opened: PersonDb[] = [];
  db = openIn(dir, opened, "persons.sqlite");
  repo = createConversationsRepo(db);
});

afterEach(() => {
  closeAll([db]);
  removeTempDir(dir);
});

function seedPerson(personId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
     VALUES (?, 'contact', ?, ?, ?)`,
  ).run(personId, personId, NOW, NOW);
}

function seedMessage(messageId: string, senderId: string, tsMs: number): void {
  createMessagesRepo(db).insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: senderId,
      role: "other",
      ts_ms: tsMs,
      msg_date: "2026-09-10",
      batch_id: "b1",
      ingested_at: NOW,
    },
  ]);
}

describe("conversations repo", () => {
  it("upsertFromCommit 新建会话；二次 UPSERT 保留 MIN(first) / MAX(last) / MAX(member_count)", () => {
    repo.upsertFromCommit(
      {
        conversation_id: CONV,
        platform: "wechat",
        kind: "direct",
        title: "张三",
        member_count: 2,
        first_msg_at: "2026-09-10T02:00:00.000Z",
        last_msg_at: "2026-09-10T03:00:00.000Z",
      },
      NOW,
    );
    const first = repo.get(CONV);
    expect(first?.title).toBe("张三");
    expect(first?.owner_person_id).toBe("me");
    expect(first?.msg_count).toBe(0);

    repo.upsertFromCommit(
      {
        conversation_id: CONV,
        platform: "wechat",
        kind: "direct",
        title: "张三改名",
        member_count: 3,
        first_msg_at: "2026-09-10T01:00:00.000Z",
        last_msg_at: "2026-09-10T05:00:00.000Z",
      },
      LATER,
    );
    const second = repo.get(CONV);
    expect(second?.title).toBe("张三改名");
    expect(second?.member_count).toBe(3);
    expect(second?.first_msg_at).toBe("2026-09-10T01:00:00.000Z");
    expect(second?.last_msg_at).toBe("2026-09-10T05:00:00.000Z");
    expect(second?.updated_at).toBe(LATER);
  });

  it("list / listForPerson / countByKind", () => {
    repo.upsertFromCommit(
      { conversation_id: CONV, platform: "wechat", kind: "direct", title: "张三" },
      NOW,
    );
    repo.upsertFromCommit(
      { conversation_id: "wechat:g1", platform: "wechat", kind: "group", title: "项目群" },
      NOW,
    );
    expect(repo.list({ kind: "group" }).map((r) => r.conversation_id)).toEqual(["wechat:g1"]);
    expect(repo.list({ keyword: "张" }).map((r) => r.conversation_id)).toEqual([CONV]);
    expect(repo.list({ limit: 1 }).length).toBe(1);
    expect(repo.countByKind()).toEqual({ direct: 1, group: 1 });

    seedPerson("p1");
    repo.upsertMember({ conversation_id: CONV, person_id: "me" }, NOW);
    repo.upsertMember({ conversation_id: CONV, person_id: "p1", is_active: false }, NOW);
    expect(repo.listForPerson("me").map((r) => r.conversation_id)).toEqual([CONV]);
    expect(repo.listForPerson("p1").length).toBe(1);
    expect(repo.listForPerson("p1", { active_only: true }).length).toBe(0);
    expect(repo.listGroupsOf("me").length).toBe(0);
  });

  it("recomputeStats 直接 COUNT/MIN/MAX（不做增量累加）", () => {
    repo.upsertFromCommit(
      { conversation_id: CONV, platform: "wechat", kind: "direct", title: "张三" },
      NOW,
    );
    seedMessage("m1", "wxid_a", 1_700_000_000_000);
    seedMessage("m2", "wxid_a", 1_700_000_060_000);
    repo.recomputeStats(CONV, LATER);
    const row = repo.get(CONV);
    expect(row?.msg_count).toBe(2);
    expect(row?.first_msg_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(row?.last_msg_at).toBe(new Date(1_700_000_060_000).toISOString());
  });
});

describe("chat_members（本仓库组合暴露）", () => {
  it("upsertMember 幂等 + last_msg_at 取并集（NULL 不吞值）", () => {
    repo.upsertFromCommit(
      { conversation_id: CONV, platform: "wechat", kind: "group", title: "项目群" },
      NOW,
    );
    seedPerson("p1");
    repo.upsertMember(
      { conversation_id: CONV, person_id: "p1", first_msg_at: "2026-09-10T01:00:00.000Z" },
      NOW,
    );
    repo.upsertMember(
      {
        conversation_id: CONV,
        person_id: "p1",
        group_alias: "老王",
        last_msg_at: "2026-09-10T05:00:00.000Z",
      },
      LATER,
    );
    const members = repo.listMembers(CONV);
    expect(members.length).toBe(1);
    expect(members[0]?.group_alias).toBe("老王");
    expect(members[0]?.is_active).toBe(true);
    expect(members[0]?.first_msg_at).toBe("2026-09-10T01:00:00.000Z");
    expect(members[0]?.last_msg_at).toBe("2026-09-10T05:00:00.000Z");
  });

  it("recomputeMemberStats 经 v_chat_messages.sender_person_id 归因（需 aliases）", () => {
    repo.upsertFromCommit(
      { conversation_id: CONV, platform: "wechat", kind: "direct", title: "张三" },
      NOW,
    );
    seedPerson("p1");
    seedPerson("p2");
    createAliasesRepo(db).insert(
      {
        alias_id: "a1",
        person_id: "p1",
        platform: "wechat",
        alias_kind: "platform_uid",
        alias: "wxid_a",
        normalized: "wxid_a",
        source: "extractor",
      },
      NOW,
    );
    seedMessage("m1", "wxid_a", 1_700_000_000_000);
    seedMessage("m2", "wxid_a", 1_700_000_060_000);
    repo.upsertMember({ conversation_id: CONV, person_id: "p1" }, NOW);
    repo.upsertMember({ conversation_id: CONV, person_id: "p2" }, NOW);

    repo.recomputeMemberStats(CONV, LATER);
    const members = repo.listMembers(CONV);
    const p1 = members.find((m) => m.person_id === "p1");
    const p2 = members.find((m) => m.person_id === "p2");
    expect(p1?.msg_count).toBe(2);
    expect(p1?.first_msg_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(p2?.msg_count).toBe(0);
  });
});
