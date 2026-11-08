import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PersonDb } from "../src/db";
import { TRACE_EXCERPT_CHARS } from "../src/constants";
import { createAliasesRepo } from "../src/repository/aliases";
import { createMessagesRepo, type MessagesRepo } from "../src/repository/messages";
import { createStagingRepo } from "../src/repository/staging";
import { closeAll, makeTempDir, openIn, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const CONV = "wechat:conv-1";
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
     VALUES (?, 'wechat', 'direct', '张三', ?, ?)`,
  ).run(CONV, NOW, NOW);
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

function insert(
  messageId: string,
  tsMs: number,
  content = "hi",
  batchId = "b1",
  contentType: "text" | "image" = "text",
): void {
  repo.insertOrIgnore([
    {
      message_id: messageId,
      conversation_id: CONV,
      platform: "wechat",
      sender_id: "wxid_a",
      sender_name: "张三",
      role: "other",
      ts_ms: tsMs,
      msg_date: "2026-09-10",
      content,
      content_type: contentType,
      batch_id: batchId,
      ingested_at: NOW,
    },
  ]);
}

describe("messages repo — 基础读写", () => {
  it("insertOrIgnore 幂等（L2）：二次插入 ignored 计数", () => {
    insert("m1", BASE_MS);
    expect(repo.count()).toBe(1);
    const again = repo.insertOrIgnore([
      {
        message_id: "m1",
        conversation_id: CONV,
        platform: "wechat",
        sender_id: "wxid_a",
        role: "other",
        ts_ms: BASE_MS,
        msg_date: "2026-09-10",
        batch_id: "b1",
        ingested_at: NOW,
      },
    ]);
    expect(again).toEqual({ inserted: 0, ignored: 1 });
    expect(repo.count()).toBe(1);
    expect(repo.get("m1")?.content).toBe("hi");
    expect(repo.get("missing")).toBeNull();
  });

  it("list / count 支持 person_id（经 v_chat_messages 解析）与 content_types", () => {
    seedPerson("p1");
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
    insert("m1", BASE_MS);
    insert("m2", BASE_MS + 1000, "[图片]", "b1", "image");
    expect(repo.count({ person_id: "p1" })).toBe(2);
    expect(repo.list({ person_id: "p1" }).map((r) => r.message_id)).toEqual(["m1", "m2"]);
    expect(repo.list({ content_types: ["image"] }).map((r) => r.message_id)).toEqual(["m2"]);
    expect(repo.list({ from_ms: BASE_MS + 1 }).map((r) => r.message_id)).toEqual(["m2"]);
    expect(repo.list({ limit: 1 }).length).toBe(1);
    expect(repo.count({ conversation_id: "nope" })).toBe(0);
  });

  it("searchContent 转义 LIKE 通配符（% / _）", () => {
    insert("m1", BASE_MS, "100% 完成");
    insert("m2", BASE_MS + 1, "普通消息");
    expect(repo.searchContent({ keyword: "100%" }).map((r) => r.message_id)).toEqual(["m1"]);
    expect(repo.searchContent({ keyword: "%" }).length).toBe(1);
    expect(repo.searchContent({ keyword: "_" }).length).toBe(0);
  });

  it("listThread 沿 reply_to 链回溯（根 → 叶）", () => {
    insert("m1", BASE_MS);
    repo.insertOrIgnore([
      {
        message_id: "m2",
        conversation_id: CONV,
        platform: "wechat",
        sender_id: "wxid_a",
        role: "other",
        ts_ms: BASE_MS + 1000,
        msg_date: "2026-09-10",
        reply_to: "m1",
        batch_id: "b1",
        ingested_at: NOW,
      },
    ]);
    expect(repo.listThread("m2").map((r) => r.message_id)).toEqual(["m1", "m2"]);
    expect(repo.listThread("m1").map((r) => r.message_id)).toEqual(["m1"]);
  });

  it("histogramByDate 按 msg_date 聚合", () => {
    insert("m1", BASE_MS);
    insert("m2", BASE_MS + 1);
    expect(repo.histogramByDate({})).toEqual([{ msg_date: "2026-09-10", count: 2 }]);
    expect(repo.histogramByDate({ from_date: "2026-09-11" })).toEqual([]);
  });
});

describe("messages repo — append-only（D2）", () => {
  it("UPDATE / DELETE chat_messages 被触发器拒绝", () => {
    insert("m1", BASE_MS);
    expect(() =>
      db.prepare("UPDATE chat_messages SET content = 'x' WHERE message_id = 'm1'").run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM chat_messages WHERE message_id = 'm1'").run()).toThrow(
      /append-only/,
    );
    expect(repo.get("m1")?.content).toBe("hi");
  });
});

describe("messages repo — stream / mentions / trace", () => {
  it("stream 分页遍历且排除已回滚批次", async () => {
    const staging = createStagingRepo(db);
    staging.beginBatch({
      batch_id: "b1",
      platform: "wechat",
      extractor: "tarry9110",
      tool_version: "v1",
      now: NOW,
    });
    staging.beginBatch({
      batch_id: "b2",
      platform: "wechat",
      extractor: "tarry9110",
      tool_version: "v1",
      now: NOW,
    });
    staging.markBatchReverted({ batch_id: "b2", now: NOW });
    insert("m1", BASE_MS, "hi", "b1");
    insert("m2", BASE_MS + 1, "reverted", "b2");

    const seen: string[] = [];
    for await (const row of repo.stream({ scope_kind: "direct", scope_id: CONV })) {
      seen.push(row.message_id);
    }
    expect(seen).toEqual(["m1"]);
    // 批 2b：buildFilter 现在无条件排除已回滚批次，派生读数与 stream 视图一致。
    // 改动前这里断言 2（count 直读基表、与 stream 的 1 不一致，正是评审定稿的缺陷）。
    // 这不是放宽断言：改为 1 并补 list / searchContent / histogram 三条收紧校验。
    expect(repo.count({ conversation_id: CONV })).toBe(1);
    expect(repo.list({ conversation_id: CONV }).map((r) => r.message_id)).toEqual(["m1"]);
    expect(repo.searchContent({ keyword: "reverted" })).toEqual([]);
    expect(repo.histogramByDate({})).toEqual([{ msg_date: "2026-09-10", count: 1 }]);
    // 回滚不物理删除（append-only），基表仍有 2 行
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()).toEqual({ n: 2 });
  });

  it("upsertMentions 幂等 + deleteMentionsByMessageIds + readMentions 过滤", () => {
    insert("m1", BASE_MS);
    seedPerson("p1");
    const rows = [{ message_id: "m1", person_id: "p1", created_at: NOW }];
    expect(repo.upsertMentions(rows)).toEqual({ upserted: 1 });
    expect(repo.upsertMentions(rows)).toEqual({ upserted: 0 });
    expect(repo.readMentions({ conversation_id: CONV }).map((r) => r.person_id)).toEqual(["p1"]);
    expect(repo.readMentions({ person_id: "p2" })).toEqual([]);
    expect(repo.readMentions({ from_ms: BASE_MS + 1 })).toEqual([]);
    expect(repo.deleteMentionsByMessageIds(["m1"])).toEqual({ deleted: 1 });
    expect(repo.deleteMentionsByMessageIds([])).toEqual({ deleted: 0 });
  });

  it("trace 截断 ≤200 字符且只读", () => {
    insert("m1", BASE_MS, "x".repeat(500));
    const rows = repo.trace(["m1", "missing"]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.content_excerpt.length).toBe(TRACE_EXCERPT_CHARS);
    expect(rows[0]?.sender_name).toBe("张三");
    expect(repo.trace([])).toEqual([]);
  });
});
