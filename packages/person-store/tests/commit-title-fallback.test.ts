/**
 * 会话标题的**落库兜底**（W-9/C2-② 的第二层）。
 *
 * 为什么单测要落在 `commitStaged` 上：
 * `chat-ingest` 已经在 `normalize` 里把「头部缺 `# 显示名`」兜底成 `conversation_key`，
 * 但**插件侧的 committer 不传 `conversation` 元数据**（只传 batch/conversation/proposal/now），
 * 于是 `resolveConversation()` 走缺省分支 `existing?.title ?? ""` —— 新建会话被写成空串。
 * 真机就这么复现过：DB 里 `title = ""`，mining 的群节点 label 靠下游 fallback 才没炸。
 *
 * 这条测试盯的是"落库那一刻 title 就不是空串"，与 `normalize.test.ts` 那条互补：
 * 一个验产出端，一个验持久化端，缺任何一条都可能再退化。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "../src/store";
import type { StagingInsert } from "../src/types-ingest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = "2026-11-12T10:00:00+08:00";
const LATER = "2026-11-12T11:00:00+08:00";

let store: PersonStore;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "knowself-commit-title-"));
  store = createPersonStore({ dbPath: join(dbDir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

/** 造一行 staging（`sender_name` 可空，用于顺带验证人名不会被这里改写）。 */
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

describe("commitStaged · 会话标题兜底（C2-②）", () => {
  it("不传 conversation 元数据 + 新会话 → title 兜底成 conversation_key，不是空串", () => {
    const convId = "wechat:55555555555@chatroom";
    store.staging.beginBatch({
      batch_id: "b-title",
      platform: "wechat",
      extractor: "tarry9110",
      tool_version: "v1",
      now: NOW,
    });
    store.staging.stageMessages({
      batch_id: "b-title",
      conversation_id: convId,
      rows: [row("t-1"), row("t-2", { ts_ms: 1_700_000_060_000 })],
      now: NOW,
    });

    // 关键：**不传** conversation（复刻插件侧 committer 的真实调用方式）
    store.commitStaged({ batch_id: "b-title", conversation_id: convId, proposal_id: "p-title", now: LATER });

    const conversation = store.conversations.get(convId);
    expect(conversation).not.toBeNull();
    expect(conversation?.title).toBe("55555555555@chatroom");
    expect((conversation?.title ?? "").trim()).not.toBe("");
  });

  it("已有非空标题时保持不变（兜底不得覆盖真实标题）", () => {
    const convId = "wechat:66666666666@chatroom";
    store.conversations.upsertFromCommit(
      { conversation_id: convId, platform: "wechat", kind: "group", title: "老同学群" },
      NOW,
    );
    store.staging.beginBatch({
      batch_id: "b-title-2",
      platform: "wechat",
      extractor: "tarry9110",
      tool_version: "v1",
      now: NOW,
    });
    store.staging.stageMessages({
      batch_id: "b-title-2",
      conversation_id: convId,
      rows: [row("t-3")],
      now: NOW,
    });
    store.commitStaged({ batch_id: "b-title-2", conversation_id: convId, proposal_id: "p-title-2", now: LATER });

    expect(store.conversations.get(convId)?.title).toBe("老同学群");
  });

  it("显式传入 conversation 时以显式值为准（兜底只在缺省分支生效）", () => {
    const convId = "wechat:77777777777@chatroom";
    store.staging.beginBatch({
      batch_id: "b-title-3",
      platform: "wechat",
      extractor: "tarry9110",
      tool_version: "v1",
      now: NOW,
    });
    store.staging.stageMessages({
      batch_id: "b-title-3",
      conversation_id: convId,
      rows: [row("t-4")],
      now: NOW,
    });
    store.commitStaged({
      batch_id: "b-title-3",
      conversation_id: convId,
      proposal_id: "p-title-3",
      now: LATER,
      conversation: {
        conversation_id: convId,
        platform: "wechat",
        kind: "group",
        title: "显式标题",
        member_count: 2,
        first_msg_at: NOW,
        last_msg_at: NOW,
      },
    });

    expect(store.conversations.get(convId)?.title).toBe("显式标题");
  });
});
