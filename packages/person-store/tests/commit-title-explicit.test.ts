/**
 * W-31 回归锁：会话标题必须来自**解析阶段已知的真名**，而不是回落成群号。
 *
 * ## 背景（真机现象）
 * 图谱面板 64 个群节点 label 100% 是 `1248517133@chatroom` 这种群号、0 个真名。
 * 逐层查下来问题不在解析侧：对 `wx-export-full` 的 69 个群文件直接跑
 * `normalizeConversation()`，58 个得到真名（其余 11 个是导出文件本身就没写群名）。
 * 断点落在**落档边界**：插件侧走 `ChatMessageCommitter` →
 * `store.commitStaged({ batch_id, conversation_id, proposal_id, now })`，
 * 只带 id 不带标题，于是 `resolveConversation()` 回落到
 * `conversation_id.replace(/^[^:]+:/, "")` = 群号，写进 `chat_conversations.title`，
 * 而 mining 的群节点 label 直接取该字段（`pipeline.ts: groupLabels`）。
 *
 * ## 本文件的职责
 * 锁住"显式给出 `conversation_title` 时以它为准"这一层（person-store 侧），
 * 与 `commit-title-fallback.test.ts`（缺省时必须回落、不得写空串）互补：
 *   - 那条保证**不崩**（空串会撞 `GraphSnapshotSchema.min(1)`）；
 *   - 这条保证**不丢真名**（真名已知却被群号覆盖）。
 * 两条一起才构成完整契约，缺任一条都可能再退化。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonStore, type PersonStore } from "../src/store";
import type { StagingInsert } from "../src/types-ingest";

const NOW = "2026-11-12T10:00:00+08:00";
const LATER = "2026-11-12T11:00:00+08:00";
const GROUP_ID = "wechat:48021051990@chatroom";
const GROUP_TITLE = "2022级软件技术3班家长群";

let store: PersonStore;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "knowself-commit-title-explicit-"));
  store = createPersonStore({ dbPath: join(dbDir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

/** 造一行 staging。 */
function row(messageId: string, over: Partial<StagingInsert> = {}): StagingInsert {
  return {
    message_id: messageId,
    platform: "wechat",
    sender_id: "wxid_a",
    sender_name: "张三",
    role: "other",
    ts_ms: 1_700_000_000_000,
    msg_date: "2026-11-12",
    content: "hi",
    content_type: "text",
    reply_to: null,
    meta: "{}",
    ...over,
  };
}

/** 建批次 + 落 staging（两个用例共用的前置）。 */
function stageConversation(batchId: string, conversationId: string, messageIds: string[]): void {
  store.staging.beginBatch({
    batch_id: batchId,
    platform: "wechat",
    extractor: "tarry9110",
    tool_version: "v1",
    now: NOW,
  });
  store.staging.stageMessages({
    batch_id: batchId,
    conversation_id: conversationId,
    rows: messageIds.map((id, index) =>
      row(id, { ts_ms: 1_700_000_000_000 + index * 60_000 }),
    ),
    now: NOW,
  });
}

describe("commitStaged · 显式会话标题（W-31）", () => {
  it("新会话 + 显式 conversation_title → title 是真名，不是群号", () => {
    stageConversation("b-w31-1", GROUP_ID, ["w31-1", "w31-2"]);

    store.commitStaged({
      batch_id: "b-w31-1",
      conversation_id: GROUP_ID,
      proposal_id: "p-w31-1",
      now: LATER,
      conversation_title: GROUP_TITLE,
    });

    const conversation = store.conversations.get(GROUP_ID);
    expect(conversation).not.toBeNull();
    expect(conversation?.title).toBe(GROUP_TITLE);
    expect(conversation?.title).not.toBe("48021051990@chatroom");
  });

  it("既有标题是群号（历史脏数据）+ 显式 conversation_title → 被回填成真名", () => {
    // 复刻历史库状态：旧逻辑把 conversation_id 去前缀写成了 title
    store.conversations.upsertFromCommit(
      { conversation_id: GROUP_ID, platform: "wechat", kind: "group", title: "48021051990@chatroom" },
      NOW,
    );
    stageConversation("b-w31-2", GROUP_ID, ["w31-3"]);

    store.commitStaged({
      batch_id: "b-w31-2",
      conversation_id: GROUP_ID,
      proposal_id: "p-w31-2",
      now: LATER,
      conversation_title: GROUP_TITLE,
    });

    expect(store.conversations.get(GROUP_ID)?.title).toBe(GROUP_TITLE);
  });

  it("conversation_title 是空白 / 缺省 → 仍回落 conversation_key（不得写空串）", () => {
    stageConversation("b-w31-3", GROUP_ID, ["w31-4"]);

    store.commitStaged({
      batch_id: "b-w31-3",
      conversation_id: GROUP_ID,
      proposal_id: "p-w31-3",
      now: LATER,
      conversation_title: "   ",
    });

    const title = store.conversations.get(GROUP_ID)?.title ?? "";
    expect(title).toBe("48021051990@chatroom");
    expect(title.trim()).not.toBe("");
  });
});
