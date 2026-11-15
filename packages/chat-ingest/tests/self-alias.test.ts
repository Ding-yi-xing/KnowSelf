/**
 * W-9 A+C：**self 的消息必须能解析成 `person_id='me'`**。
 *
 * ## 缺陷形状（真机实测）
 * 视图 `v_chat_messages` 用 `aliases(platform, alias_kind='platform_uid', alias=sender_id)`
 * JOIN 出 `sender_person_id`；self 的 alias 从来没人建（`index.ts` 里 `senderId === "me"` 直接
 * `continue`），于是我的消息 `sender_person_id = NULL` → 被 mining 的 `.filter(s => s !== null)`
 * 丢掉 → 图谱里「我」`degree` 恒为 0、`msg_count = 0`。
 *
 * ## 修复（C：写侧归一）
 * `index.ts` 遍历 senders 时，遇到 `"me"` 先确保 alias 存在（幂等 upsert）再 `continue`。
 * `"me"` 是 chat-ingest 自己写的**哨兵**（`lines.ts: senderIdOf`），与导出里的真实 uid 无关，
 * 所以这行 alias 对任何平台都成立。视图是查询期 JOIN ⇒ **已入库的历史行也会自动解析**。
 *
 * ## 测试里的两个坑（写下来防复发）
 * 1. `platform` 是描述符给的 **`wechat`**，不是 `other`；
 * 2. pipeline 模式下**会话也要到 `commitStaged` 才落库**，所以 ingest 之后
 *    `store.conversations.list()` 仍是空数组 —— 必须显式给会话 id 与元数据，不能靠 `list()[0]`。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonStore } from "@knowself/person-store";
import { createChatMessageCommitter, ingestExport } from "../src/index.js";

const NOW = "2026-11-12T00:00:00.000Z";
const PLATFORM = "wechat";
const CONVERSATION_ID = "wechat:99999999999@chatroom";
const dirs: string[] = [];

/** 造一份「我 + 两位他人」的小群聊导出（Tarry9110 格式）。 */
function makeExport(dir: string): void {
  const lines = [
    "# 会话对象 : 99999999999@chatroom",
    "# 显示名   : 两人小组",
    "# 类型     : 群聊",
    "# 消息数   : 6",
    "# 时间范围 : 2026-11-03 09:00 ~ 2026-11-03 09:05",
    "#",
    "---------- 2026-11-03 ----------",
    "[09:00] 我: 我是发起人",
    "[09:01] 甲一: 收到",
    "[09:02] 我: 再说一句",
    "[09:03] 乙二: 好的",
    "[09:04] 我: 第三句",
    "[09:05] 甲一: 明白",
  ];
  writeFileSync(join(dir, "两人小组.txt"), lines.join("\r\n"), "utf8");
}

type Store = ReturnType<typeof createPersonStore>;

/**
 * 导入一次并**显式提交**（pipeline 模式只写 staging + proposal）。
 * @param dir 导出目录
 * @param store 目标库
 * @returns 导入结果
 */
async function ingest(dir: string, store: Store) {
  const result = await ingestExport({
    store,
    dir,
    source_id: "w9-self-alias",
    proposalSink: { listPending: () => [], create: () => {}, accept: () => {} },
    chatCommitter: createChatMessageCommitter(store),
  } as never);

  store.commitStaged({
    batch_id: result.batch_id,
    conversation_id: CONVERSATION_ID,
    proposal_id: `p-${result.batch_id}`,
    now: NOW,
    conversation: {
      conversation_id: CONVERSATION_ID,
      platform: PLATFORM,
      kind: "group",
      title: "两人小组",
      owner_person_id: "me",
      member_count: 3,
    },
  } as never);

  return result;
}

/** 数 self 相关 alias 行数。 */
function selfAliasRows(store: Store) {
  return store.aliases.listAll().filter((a) => a.person_id === "me" && a.alias === "me");
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("self 消息归属（W-9 A+C）", () => {
  it("① 导入后：我的消息能被解析到 person_id='me'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w9-self-"));
    dirs.push(dir);
    makeExport(dir);
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });

    const result = await ingest(dir, store);

    expect(result.message_count).toBeGreaterThan(0);
    expect(store.messages.count({ person_id: "me" } as never)).toBeGreaterThan(0);
    store.close();
  });

  it("② self alias 落到 aliases 表，且用描述符给的 platform（不写死）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w9-self-"));
    dirs.push(dir);
    makeExport(dir);
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });

    await ingest(dir, store);

    const alias = store.aliases.findByUid(PLATFORM, "me");
    expect(alias).not.toBeNull();
    expect(alias?.person_id).toBe("me");
    expect(alias?.alias_kind).toBe("platform_uid");
    store.close();
  });

  it("③ 重复导入不产生重复 self alias（幂等，不递增）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w9-self-"));
    dirs.push(dir);
    makeExport(dir);
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });

    await ingest(dir, store);
    expect(selfAliasRows(store)).toHaveLength(1);
    await ingest(dir, store);
    await ingest(dir, store);
    expect(selfAliasRows(store)).toHaveLength(1);
    store.close();
  });

  it("④ 历史行自动解析：删掉 alias 后同一批行解析不到，补回后恢复", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w9-self-"));
    dirs.push(dir);
    makeExport(dir);
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });

    await ingest(dir, store);
    expect(store.messages.count({ person_id: "me" } as never)).toBeGreaterThan(0);

    const alias = store.aliases.findByUid(PLATFORM, "me");
    expect(alias).not.toBeNull();
    store.aliases.remove(alias!.alias_id, NOW);
    expect(store.messages.count({ person_id: "me" } as never)).toBe(0);

    await ingest(dir, store);
    expect(store.messages.count({ person_id: "me" } as never)).toBeGreaterThan(0);
    store.close();
  });

  it("⑤ 连续导入 3 次后：self alias 恰好 1 行、self person 恰好 1 行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w9-self-"));
    dirs.push(dir);
    makeExport(dir);
    const store = createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });

    await ingest(dir, store);
    await ingest(dir, store);
    await ingest(dir, store);

    expect(selfAliasRows(store)).toHaveLength(1);
    expect(store.listPersons().filter((p) => p.person_id === "me")).toHaveLength(1);
    store.close();
  });
});
