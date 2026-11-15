/**
 * `messages.countUnattributed` / `countBySenderId`（W-9 收口）。
 *
 * 这两条计数是「self alias 修好了没」的最短证据链：
 *   - `countUnattributed`：落库了但解析不到人的消息条数（**必须排除 system**）；
 *   - `countBySenderId`：会话表与消息表是否一致的自检口径（不经别名解析）。
 *
 * 为什么单测要盯住 `system`：系统消息本就不该有发送者归属，若把它算进
 * unattributed，修好之后仍然显示非 0，用户会以为没修好——这正是这条断言要防的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersonDb } from "../src/db";
import { createAliasesRepo } from "../src/repository/aliases";
import { createMessagesRepo, type MessagesRepo } from "../src/repository/messages";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const NOW = "2026-11-12T10:00:00+08:00";
const CONV = "wechat:123@chatroom";
const BASE_MS = 1_700_000_000_000;

let dir: string;
let db: PersonDb;
let repo: MessagesRepo;

beforeEach(() => {
  dir = makeTempDir();
  const opened: PersonDb[] = [];
  db = openIn(dir, opened, "persons.sqlite");
  repo = createMessagesRepo(db);
  db.prepare(
    `INSERT INTO chat_conversations
       (conversation_id, platform, kind, title, created_at, updated_at)
     VALUES (?, 'wechat', 'group', '群', ?, ?)`,
  ).run(CONV, NOW, NOW);
});

afterEach(() => {
  closeAll([db]);
  removeTempDir(dir);
});

/** 落一条消息（不做任何别名解析）。 */
function insert(input: {
  id: string;
  senderId: string;
  role: "me" | "other" | "system";
  batchId?: string;
}): void {
  repo.insertOrIgnore([
    {
      message_id: input.id,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: input.senderId,
      sender_name: "",
      role: input.role,
      ts_ms: BASE_MS,
      msg_date: "2026-11-12",
      content: "x",
      content_type: "text",
      reply_to: null,
      meta: "{}",
      batch_id: input.batchId ?? "b1",
      ingested_at: NOW,
    },
  ]);
}

/** 给某个平台 ID 建一条可解析的别名。 */
function aliasFor(personId: string, platformUid: string): void {
  createAliasesRepo(db).insert(
    {
      alias_id: `al-${personId}-${platformUid}`,
      person_id: personId,
      platform: "wechat",
      alias: platformUid,
      normalized: platformUid,
      alias_kind: "platform_uid",
      is_primary: true,
      confidence: 1,
      source: "extractor",
    } as never,
    NOW,
  );
}

function seedPerson(personId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO persons (person_id, subject_kind, display_name, created_at, updated_at)
     VALUES (?, 'contact', ?, ?, ?)`,
  ).run(personId, personId, NOW, NOW);
}

describe("countUnattributed", () => {
  it("没有人能解析时全部计入；建了别名后归 0", () => {
    seedPerson("p1");
    insert({ id: "m1", senderId: "wxid_a", role: "other" });
    insert({ id: "m2", senderId: "wxid_b", role: "other" });
    expect(repo.countUnattributed()).toBe(2);

    aliasFor("p1", "wxid_a");
    expect(repo.countUnattributed()).toBe(1);

    seedPerson("p2");
    aliasFor("p2", "wxid_b");
    expect(repo.countUnattributed()).toBe(0);
  });

  it("排除 role='system'：系统消息永远不算「无法识别」", () => {
    insert({ id: "s1", senderId: "system", role: "system" });
    insert({ id: "s2", senderId: "", role: "system" });
    // 两条 system 都不计入 → 0，否则修好后永远非 0
    expect(repo.countUnattributed()).toBe(0);

    insert({ id: "m1", senderId: "wxid_a", role: "other" });
    expect(repo.countUnattributed()).toBe(1);
  });

  it("带 batch_id 时只看该批（回执里的「其中 N 条」）", () => {
    insert({ id: "m1", senderId: "wxid_a", role: "other", batchId: "b1" });
    insert({ id: "m2", senderId: "wxid_b", role: "other", batchId: "b2" });

    expect(repo.countUnattributed({ batch_id: "b1" })).toBe(1);
    expect(repo.countUnattributed({ batch_id: "b2" })).toBe(1);
    expect(repo.countUnattributed({ batch_id: "b-missing" })).toBe(0);
    expect(repo.countUnattributed()).toBe(2);
  });
});

describe("countBySenderId", () => {
  it("按平台原始 ID 计数（不经别名：即使解析不到人也算）", () => {
    insert({ id: "m1", senderId: "me", role: "me" });
    insert({ id: "m2", senderId: "me", role: "me" });
    insert({ id: "m3", senderId: "wxid_a", role: "other" });

    expect(repo.countBySenderId("me")).toBe(2);
    expect(repo.countBySenderId("wxid_a")).toBe(1);
    expect(repo.countBySenderId("nobody")).toBe(0);
  });
});
