import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createChatMessageCommitter } from "@knowself/chat-ingest";
import { createPersonStore } from "@knowself/person-store";
import { createProfileStore, type ProfileStore } from "@knowself/profile-store";
import type {
  ChatMessageCommitter,
  ChatMessageCommitInput,
  ChatMessageRejecter,
  ChatMessageRejectInput,
  IngestionProposal,
  ProposalStatus,
} from "@knowself/contracts";
import { acceptProposal, editProposal, rejectProposal } from "../src/proposals";
import { InvalidTargetRefError } from "../src/errors";

const NOW = "2026-09-10T10:00:00.000Z";
const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";
const PROPOSAL_ID = "20000000-0000-0000-0000-000000000001";
const BATCH_ID = "10000000-0000-0000-0000-000000000001";
const CONV_ID = "wechat:wxid_aaaaaaaaaaaa22";

/** 与 `IngestionProposal` 契约一致的 chat_message proposal（DESIGN-11 §7.2 #1）。 */
function chatProposal(): IngestionProposal {
  return {
    id: PROPOSAL_ID,
    source_id: SOURCE_ID,
    target: {
      kind: "chat_message",
      batch_id: BATCH_ID,
      conversation_id: CONV_ID,
      message_ids: ["wechat:wxid_aaaaaaaaaaaa22:1", "wechat:wxid_aaaaaaaaaaaa22:2"],
      tier: "auto",
      reason_codes: [],
    },
    proposed_body: "会话：张三\n消息条数：2",
    reasoning: "tier=auto; rule_version=chat-tier-v1; reason_codes=[]",
    source_excerpts: [],
    produced_by_provider: "chat-ingest:rule-v1",
    status: "pending",
    user_edited_body: null,
    created_at: NOW,
    decided_at: null,
  };
}

interface MockStore extends ProfileStore {
  current: IngestionProposal;
}

/**
 * 结构化 mock（与 `proposals.test.ts` 同做法）：
 * chat_message 分支只关心「提交器被正确调用 + proposal 状态机 + 不写 profile」，
 * 不依赖 profile.sqlite 的 DDL（见 status.md「遗留」：`ingestion_proposals.target_kind`
 * 的 CHECK 约束尚未包含 `chat_message`，需要一条加法式迁移）。
 */
function mockStore(): MockStore {
  let current = chatProposal();
  const store = {
    current,
    core: {} as never,
    cards: {} as never,
    journal: {} as never,
    sources: {
      updateStatus: vi.fn(),
      list: vi.fn(() => ({ items: [], total: 0 })),
      get: vi.fn(),
      insert: vi.fn(),
      updateError: vi.fn(),
      updateNote: vi.fn(),
      countByStatus: vi.fn(() => ({})),
      latestDistillAt: vi.fn(() => null),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    proposals: {
      insertMany: vi.fn(),
      listBySource: vi.fn(() => [current]),
      listByStatus: vi.fn(() => [current]),
      countByStatus: vi.fn(() => ({ pending: 1 })),
      get: vi.fn(() => current),
      decide: vi.fn((_id: string, decision: { decision: string; body?: string }, now: string) => {
        const status: ProposalStatus =
          decision.decision === "accept"
            ? "accepted"
            : decision.decision === "edit"
              ? "edited"
              : "rejected";
        current = {
          ...current,
          status,
          user_edited_body: decision.body ?? null,
          decided_at: now,
        };
        store.current = current;
        return current;
      }),
    },
    links: {
      insert: vi.fn(),
      listForProfile: vi.fn(() => ({ links: [], sources: [] })),
      listForSource: vi.fn(() => []),
    },
    events: {} as never,
    write: vi.fn(),
    transaction: vi.fn(<T,>(fn: () => T): T => fn()),
    exportProfile: vi.fn() as never,
    exportProfileBuffer: vi.fn() as never,
    close: vi.fn(),
  };
  return store as unknown as MockStore;
}

function spyCommitter(): ChatMessageCommitter & { calls: ChatMessageCommitInput[] } {
  const calls: ChatMessageCommitInput[] = [];
  return {
    calls,
    commit(input: ChatMessageCommitInput) {
      calls.push(input);
      return { committed: input.target.message_ids.length, skipped: 0 };
    },
  };
}

/** 批 1.5：与 spyCommitter 对称的拒绝器 spy。 */
function spyRejecter(): ChatMessageRejecter & { calls: ChatMessageRejectInput[] } {
  const calls: ChatMessageRejectInput[] = [];
  return {
    calls,
    reject(input: ChatMessageRejectInput) {
      calls.push(input);
      return { rejected: input.target.message_ids.length };
    },
  };
}

describe("acceptProposal — chat_message 分支（DESIGN-11 §7.2 #4 / §7.4）", () => {
  it("未注入 chatCommitter → 明确抛 INVALID_TARGET_REF（不静默成功）", () => {
    const store = mockStore();
    let thrown: unknown = null;
    try {
      acceptProposal({ store, now: () => NOW }, PROPOSAL_ID);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(InvalidTargetRefError);
    expect((thrown as InvalidTargetRefError).code).toBe("INVALID_TARGET_REF");
    expect(store.proposals.get(PROPOSAL_ID).status).toBe("pending");
    // 未落档、未写 profile
    expect(store.write).not.toHaveBeenCalled();
  });

  it("注入提交器 → 先 commit 再改状态；不写 profile / 不建 profile_sources 关联", () => {
    const store = mockStore();
    const committer = spyCommitter();
    const result = acceptProposal({ store, now: () => NOW, chatCommitter: committer }, PROPOSAL_ID);

    expect(result.status).toBe("accepted");
    expect(result.decided_at).toBe(NOW);
    expect(committer.calls).toHaveLength(1);
    expect(committer.calls[0]).toEqual({
      proposal_id: PROPOSAL_ID,
      source_id: SOURCE_ID,
      target: chatProposal().target,
      now: NOW,
    });
    // §7.4：chat_message 不写 profile，也不写 profile_sources 关联
    expect(store.write).not.toHaveBeenCalled();
    expect(store.links.insert).not.toHaveBeenCalled();
  });

  it("提交器抛错 → proposal 保持 pending（可重试；committer 自身幂等）", () => {
    const store = mockStore();
    const committer: ChatMessageCommitter = {
      commit: vi.fn(() => {
        throw new Error("commit failed");
      }),
    };
    expect(() =>
      acceptProposal({ store, now: () => NOW, chatCommitter: committer }, PROPOSAL_ID),
    ).toThrow("commit failed");
    expect(store.proposals.get(PROPOSAL_ID).status).toBe("pending");
  });

  it("非 pending 的 chat proposal → ProposalNotPendingError", () => {
    const store = mockStore();
    const committer = spyCommitter();
    acceptProposal({ store, now: () => NOW, chatCommitter: committer }, PROPOSAL_ID);
    expect(() =>
      acceptProposal({ store, now: () => NOW, chatCommitter: committer }, PROPOSAL_ID),
    ).toThrow();
  });
});

describe("editProposal / rejectProposal — chat_message 分支", () => {
  it("edit：commit 后置 edited，user_edited_body 只改摘要", () => {
    const store = mockStore();
    const committer = spyCommitter();
    const result = editProposal(
      { store, now: () => NOW, chatCommitter: committer },
      PROPOSAL_ID,
      "修正后的摘要",
    );
    expect(result.status).toBe("edited");
    expect(result.user_edited_body).toBe("修正后的摘要");
    expect(committer.calls).toHaveLength(1);
  });

  it("reject：调拒绝器、不调提交器、不落档（批 1.5）", () => {
    const store = mockStore();
    const committer = spyCommitter();
    const rejecter = spyRejecter();
    const result = rejectProposal(
      { store, now: () => NOW, chatCommitter: committer, chatRejecter: rejecter },
      PROPOSAL_ID,
    );
    expect(result.status).toBe("rejected");
    expect(committer.calls).toHaveLength(0);
    expect(rejecter.calls).toHaveLength(1);
    expect(rejecter.calls[0]?.target.message_ids).toEqual(chatProposal().target.message_ids);
  });

  it("未注入 chatRejecter → 明确抛 INVALID_TARGET_REF（不静默成功）", () => {
    const store = mockStore();
    const committer = spyCommitter();
    // 只注入 committer 不算完成装配：拒绝仍会「只改 proposal 状态」，
    // 被拒内容会在后续 accept 时被 commitStaged 一并落档。
    expect(() =>
      rejectProposal({ store, now: () => NOW, chatCommitter: committer }, PROPOSAL_ID),
    ).toThrow(InvalidTargetRefError);
    expect(committer.calls).toHaveLength(0);
    expect(store.current.status).toBe("pending"); // 状态未被误改
  });
});

/**
 * 真实 profile.sqlite 集成：验证 `target_kind='chat_message'` 能落库
 * （依赖 `profile-store` 的 V3 加法式迁移 `ensureProposalTargetKindConstraint`，DESIGN-11 §7.2 #1）。
 */
describe("chat_message proposal — 真实 profile.sqlite", () => {
  function realStore() {
    const store = createProfileStore({
      dbPath: ":memory:",
      sourcesDir: "unused",
      exportsDir: "unused",
    });
    store.sources.insert({
      id: SOURCE_ID,
      kind: "file",
      original_name: "chat-export",
      mime_type: "text/plain",
      file_path: null,
      url: null,
      extracted_text: "chat export",
      truncated: false,
      char_count: 11,
      user_note: "",
      user_tags: [],
      status: "pending_review",
      metadata: {},
      created_at: NOW,
      last_ingested_at: null,
      last_error: null,
    });
    return store;
  }

  it("可插入并 accept：状态 accepted、不写 profile_sources", () => {
    const store = realStore();
    store.proposals.insertMany([chatProposal()]);
    const committer = spyCommitter();

    const result = acceptProposal({ store, now: () => NOW, chatCommitter: committer }, PROPOSAL_ID);

    expect(result.status).toBe("accepted");
    expect(committer.calls).toHaveLength(1);
    expect(store.proposals.get(PROPOSAL_ID).target.kind).toBe("chat_message");
    expect(store.links.listForSource(SOURCE_ID)).toHaveLength(0);
    store.close();
  });

  it("未注入提交器时真实库也一样明确报错", () => {
    const store = realStore();
    store.proposals.insertMany([chatProposal()]);
    expect(() => acceptProposal({ store, now: () => NOW }, PROPOSAL_ID)).toThrow(
      InvalidTargetRefError,
    );
    expect(store.proposals.get(PROPOSAL_ID).status).toBe("pending");
    store.close();
  });

  it("人物提交成功而 profile 决议失败后，重开两个 SQLite 重试不会重复消息", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowself-chat-proposal-recovery-"));
    const profileDbPath = join(dir, "profile.sqlite");
    const personsDbPath = join(dir, "persons.sqlite");
    const openProfile = () =>
      createProfileStore({
        dbPath: profileDbPath,
        sourcesDir: join(dir, "sources"),
        exportsDir: join(dir, "exports"),
      });

    let profileStore = openProfile();
    let personStore = createPersonStore({
      dbPath: personsDbPath,
      encryption: { mode: "none" },
    });

    try {
      profileStore.sources.insert({
        id: SOURCE_ID,
        kind: "file",
        original_name: "chat-export",
        mime_type: "text/plain",
        file_path: null,
        url: null,
        extracted_text: "chat export",
        truncated: false,
        char_count: 11,
        user_note: "",
        user_tags: [],
        status: "pending_review",
        metadata: {},
        created_at: NOW,
        last_ingested_at: null,
        last_error: null,
      });
      profileStore.proposals.insertMany([chatProposal()]);

      personStore.staging.beginBatch({
        batch_id: BATCH_ID,
        platform: "wechat",
        extractor: "test",
        tool_version: "test",
        now: NOW,
      });
      personStore.staging.stageMessages({
        batch_id: BATCH_ID,
        conversation_id: CONV_ID,
        now: NOW,
        rows: chatProposal().target.message_ids.map((message_id, index) => ({
          message_id,
          platform: "wechat" as const,
          sender_id: "wxid_sender",
          sender_name: "张三",
          role: "other" as const,
          ts_ms: 1_000 + index,
          msg_date: "2026-09-10",
          content: `message ${index + 1}`,
          content_type: "text" as const,
          reply_to: null,
          meta: "{}",
        })),
      });

      const decideSpy = vi
        .spyOn(profileStore.proposals, "decide")
        .mockImplementation(() => {
          throw new Error("profile decision write failed");
        });
      const firstCommitter = createChatMessageCommitter(personStore);

      expect(() =>
        acceptProposal(
          { store: profileStore, now: () => NOW, chatCommitter: firstCommitter },
          PROPOSAL_ID,
        ),
      ).toThrow("profile decision write failed");
      expect(personStore.messages.count({ conversation_id: CONV_ID })).toBe(2);
      expect(profileStore.proposals.get(PROPOSAL_ID).status).toBe("pending");
      decideSpy.mockRestore();

      // 模拟进程在跨库窗口退出：两边均关闭后重新打开，再执行同一 proposal。
      profileStore.close();
      personStore.close();
      profileStore = openProfile();
      personStore = createPersonStore({
        dbPath: personsDbPath,
        encryption: { mode: "none" },
      });

      const result = acceptProposal(
        {
          store: profileStore,
          now: () => NOW,
          chatCommitter: createChatMessageCommitter(personStore),
        },
        PROPOSAL_ID,
      );

      expect(result.status).toBe("accepted");
      expect(personStore.messages.count({ conversation_id: CONV_ID })).toBe(2);
      expect(profileStore.proposals.get(PROPOSAL_ID).status).toBe("accepted");
      expect(profileStore.sources.get(SOURCE_ID).status).toBe("completed");
    } finally {
      personStore.close();
      profileStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
