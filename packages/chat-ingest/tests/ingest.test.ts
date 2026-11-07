import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "@knowself/person-store";
import {
  createChatMessageCommitter,
  type ChatMessageCommitterLike,
} from "../src/committer";
import { isChatIngestError } from "../src/errors";
import { ingestExport, type IngestProposalSink } from "../src/index";
import type { ChatIngestProposalDraft, PendingProposalRef } from "../src/proposal";
import { defaultExportDir, makeExportDir, NOW } from "./fixtures";

const SINGLE_CONV = "wechat:wxid_aaaaaaaaaaaa22";
const GROUP_CONV = "wechat:12345678901@chatroom";

let dir: string;
let store: PersonStore;
const scratch: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-chat-ingest-db-"));
  scratch.push(dir);
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ingestExport（端到端：reader → normalize → staging → commit）", () => {
  it("两个会话全部落档，会话缓存与联系人同步建立", async () => {
    const result = await ingestExport({ store, dir: defaultExportDir(), now: NOW });

    expect(result.conversation_count).toBe(2);
    expect(result.message_count).toBe(13);
    expect(result.committed).toBe(13);
    expect(result.skipped).toBe(0);
    expect(result.issues.filter((issue) => issue.code === "SENDER_UNKNOWN")).toHaveLength(1);

    expect(store.messages.count()).toBe(13);
    expect(store.messages.count({ conversation_id: SINGLE_CONV })).toBe(5);
    expect(store.messages.count({ conversation_id: GROUP_CONV })).toBe(8);

    const single = store.conversations.get(SINGLE_CONV);
    expect(single?.title).toBe("张三");
    expect(single?.kind).toBe("direct");
    expect(single?.member_count).toBe(2);
    expect(single?.msg_count).toBe(5);

    const group = store.conversations.get(GROUP_CONV);
    expect(group?.title).toBe("测试群");
    expect(group?.kind).toBe("group");
    expect(group?.member_count).toBe(4);

    expect(store.aliases.resolvePersonId("wechat", "name:张三")).not.toBeNull();
    expect(store.aliases.resolvePersonId("wechat", "name:王五")).not.toBeNull();
    expect(store.staging.getBatch(result.batch_id)?.status).toBe("succeeded");
    // legacy 路径（未注入 sink）没有适配器告警，字段仍须显式给值（不留"有字段没值"）
    expect(result.warnings).toEqual([]);
  });

  it("二次摄入幂等：chat_messages 不增行（L2 主键去重）", async () => {
    const first = await ingestExport({ store, dir: defaultExportDir(), now: NOW });
    const second = await ingestExport({ store, dir: defaultExportDir(), now: NOW });

    expect(first.batch_id).not.toBe(second.batch_id);
    expect(store.messages.count()).toBe(13);
    expect(store.messages.count({ conversation_id: GROUP_CONV })).toBe(8);
    expect(store.conversations.get(GROUP_CONV)?.msg_count).toBe(8);
  });

  it("only 关键字只摄入命中的会话", async () => {
    const result = await ingestExport({ store, dir: defaultExportDir(), now: NOW, only: ["张三"] });
    expect(result.conversation_count).toBe(1);
    expect(store.messages.count({ conversation_id: SINGLE_CONV })).toBe(5);
    expect(store.messages.count({ conversation_id: GROUP_CONV })).toBe(0);
  });

  it("非聊天目录抛 EXPORT_FORMAT_UNKNOWN", async () => {
    const empty = makeExportDir({ "note.md": "not a chat" });
    let thrown: unknown = null;
    try {
      await ingestExport({ store, dir: empty, now: NOW });
    } catch (cause) {
      thrown = cause;
    }
    expect(isChatIngestError(thrown)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
//  新增（加法式）：完整管线 —— Tier 判定 / 游标过滤 / proposal / committer
// ──────────────────────────────────────────────────────────────────────────

const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";
const TS = new Date("2024-01-02T13:45:00+08:00").getTime();

/** 与 `SINGLE_TXT` 同内容，但带**平台消息 ID**（无 `ID_FALLBACK`，可判 Tier A）。 */
const SINGLE_JSON = {
  conversation_key: "wxid_aaaaaaaaaaaa22",
  title: "张三",
  kind: "单聊",
  messages: [
    { message_id: "1", ts_ms: TS, sender_id: "name:张三", sender_name: "张三", role: "other", content: "你好", content_type: "text" },
    { message_id: "2", ts_ms: TS + 30_000, sender_name: "我", role: "me", content: "在的", content_type: "text" },
    { message_id: "3", ts_ms: TS + 60_000, sender_id: "name:张三", sender_name: "张三", role: "other", content: "[图片]", content_type: "image" },
    { message_id: "4", ts_ms: TS + 120_000, sender_name: "我", role: "me", content: "收到", content_type: "text" },
    { message_id: "5", ts_ms: TS + 180_000, sender_id: "name:张三", sender_name: "张三", role: "other", content: "结尾", content_type: "text" },
  ],
};

function jsonExportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-chat-ingest-json-"));
  scratch.push(dir);
  writeFileSync(join(dir, "single.json"), JSON.stringify(SINGLE_JSON), "utf8");
  return dir;
}

/** 内存版 proposal 适配器：create 记草稿；accept 走真实的 ChatMessageCommitter。 */
interface MemorySink extends IngestProposalSink {
  created: ChatIngestProposalDraft[];
  accepted: string[];
}

function memorySink(committer: ChatMessageCommitterLike): MemorySink {
  const created: ChatIngestProposalDraft[] = [];
  const accepted: string[] = [];
  const decided = new Set<string>();
  return {
    created,
    accepted,
    listPending(input: { conversation_id: string }): readonly PendingProposalRef[] {
      // §6.5（2A）：按会话作用域查，不按 batch 过滤（重跑必然换 batch_id）。
      return created
        .filter(
          (proposal) =>
            !decided.has(proposal.id) &&
            proposal.target.conversation_id === input.conversation_id,
        )
        .map((proposal) => ({
          proposal_id: proposal.id,
          message_ids: proposal.target.message_ids,
        }));
    },
    create(proposal: ChatIngestProposalDraft): void {
      created.push(proposal);
    },
    accept(proposalId: string): void {
      const proposal = created.find((item) => item.id === proposalId);
      if (proposal === undefined) throw new Error(`proposal 不存在: ${proposalId}`);
      committer.commit({
        proposal_id: proposalId,
        source_id: proposal.source_id,
        target: proposal.target,
        now: NOW,
      });
      decided.add(proposalId);
      accepted.push(proposalId);
    },
  };
}

function seedAlias(): void {
  store.ensurePersonForUid({
    platform: "wechat",
    platform_uid: "name:张三",
    display_name: "张三",
    now: NOW,
  });
}

describe("ingestExport — pipeline 模式（DESIGN-11 §6.3 / §5.2 / §6.5）", () => {
  it("Tier A 也必须经 proposal → accept → committer；不直接 INSERT", async () => {
    seedAlias();
    const sink = memorySink(createChatMessageCommitter(store));
    const result = await ingestExport({
      store,
      dir: jsonExportDir(),
      now: NOW,
      reader: "json",
      source_id: SOURCE_ID,
      proposalSink: sink,
      chatCommitter: createChatMessageCommitter(store),
      tierConfig: { auto_ok: [SINGLE_CONV] },
      only: ["张三"],
    });

    expect(result.mode).toBe("pipeline");
    expect(result.conversation_count).toBe(1);
    expect(result.message_count).toBe(5);
    expect(result.tier).toEqual({ auto: 1, review: 0 });
    expect(result.committed).toBe(5);
    expect(result.skipped).toBe(0);

    // 走的是 proposal（哪怕 Tier A）
    expect(sink.created).toHaveLength(1);
    expect(sink.accepted).toHaveLength(1);
    expect(sink.created[0]?.target.kind).toBe("chat_message");
    expect(sink.created[0]?.target.tier).toBe("auto");
    expect(sink.created[0]?.target.reason_codes).toEqual([]);
    expect(sink.created[0]?.produced_by_provider).toBe("chat-ingest:rule-v1");
    expect(sink.created[0]?.source_id).toBe(SOURCE_ID);

    expect(result.proposals).toEqual({
      created: 1,
      accepted: 1,
      queued: 0,
      reused: 0,
      skipped_messages: 0,
    });
    expect(store.messages.count({ conversation_id: SINGLE_CONV })).toBe(5);
  });

  it("批 2 / 1B′ 两态①：会话不存在且无预授权 → ID_FALLBACK 保留（保守）", async () => {
    const sink = memorySink(createChatMessageCommitter(store));
    const result = await ingestExport({
      store,
      dir: defaultExportDir(),
      now: NOW,
      source_id: SOURCE_ID,
      proposalSink: sink,
      chatCommitter: createChatMessageCommitter(store),
      only: ["测试群"],
    });

    expect(result.tier).toEqual({ auto: 0, review: 1 });
    expect(sink.created[0]?.target.reason_codes).toContain("ID_FALLBACK");
  });

  it("批 2 / 1B′ 两态②：auto_ok 命中 + 结构合法的 sha1 派生 ID → 自动落档", async () => {
    // 直接锁住本轮修复：本机 `data/chat-ingest/` 不存在，auto_ok 文件缺失时
    // 用户路径应是「首次导入 → 接受一次 → 之后自动」，不需要编辑任何配置文件。
    seedAlias();
    const sink = memorySink(createChatMessageCommitter(store));
    const result = await ingestExport({
      store,
      dir: defaultExportDir(),
      now: NOW,
      source_id: SOURCE_ID,
      proposalSink: sink,
      chatCommitter: createChatMessageCommitter(store),
      tierConfig: { auto_ok: [SINGLE_CONV] },
      only: ["张三"],
    });

    expect(result.tier).toEqual({ auto: 1, review: 0 });
    expect(result.committed).toBeGreaterThan(0);
    expect(sink.created[0]?.target.reason_codes).not.toContain("ID_FALLBACK");
    expect(sink.created[0]?.reasoning).toContain("rule_version=chat-tier-v2");
  });

  it("Tier B 进队列、不落档；staging 保留载荷与 reason_codes", async () => {
    const sink = memorySink(createChatMessageCommitter(store));
    const result = await ingestExport({
      store,
      dir: defaultExportDir(),
      now: NOW,
      source_id: SOURCE_ID,
      proposalSink: sink,
      chatCommitter: createChatMessageCommitter(store),
      // 批 2 / 1B′：auto_ok 命中 ⇒ trusted_ingest=true ⇒ 结构合法的 sha1 派生 ID 被豁免；
      // 未解析发送者 / 成员表未知仍命中，因此整体仍是 Tier B。
      tierConfig: { auto_ok: [GROUP_CONV] },
      only: ["测试群"],
    });

    expect(result.tier).toEqual({ auto: 0, review: 1 });
    expect(result.committed).toBe(0);
    expect(result.proposals.created).toBe(1);
    expect(result.proposals.queued).toBe(1);
    expect(result.proposals.accepted).toBe(0);
    expect(sink.accepted).toHaveLength(0);
    expect(store.messages.count()).toBe(0);

    const proposal = sink.created[0];
    expect(proposal?.target.tier).toBe("review");
    expect(proposal?.target.message_ids).toHaveLength(8);
    expect(proposal?.target.reason_codes).not.toContain("ID_FALLBACK");
    expect(proposal?.target.reason_codes).toContain("SENDER_UNRESOLVED");
    expect(proposal?.target.reason_codes).toContain("GROUP_MEMBER_UNKNOWN");
    expect(proposal?.reasoning).toContain("rule_version=chat-tier-v2");

    const staged = store.staging.listStaged({ batch_id: result.batch_id, conversation_id: GROUP_CONV });
    expect(staged).toHaveLength(8);
    expect(staged.every((row) => row.tier === "review")).toBe(true);
    expect(staged.every((row) => row.proposal_id === null)).toBe(true);
  });

  it("二次运行被增量游标全部过滤（游标只进不退，§5.2 / §6.5）", async () => {
    seedAlias();
    const making = () => ({
      store,
      dir: jsonExportDir(),
      now: NOW,
      reader: "json" as const,
      source_id: SOURCE_ID,
      chatCommitter: createChatMessageCommitter(store),
      tierConfig: { auto_ok: [SINGLE_CONV] },
    });

    const first = await ingestExport({ ...making(), proposalSink: memorySink(createChatMessageCommitter(store)) });
    const secondSink = memorySink(createChatMessageCommitter(store));
    const second = await ingestExport({ ...making(), proposalSink: secondSink });

    expect(first.committed).toBe(5);
    expect(second.proposals.created).toBe(0);
    expect(second.cursor_filtered).toBe(5);
    expect(store.messages.count({ conversation_id: SINGLE_CONV })).toBe(5);
    expect(secondSink.created).toHaveLength(0);
  });

  it("适配器告警经 drainWarnings 透出到 result.warnings，且每轮只取一次", async () => {
    seedAlias();
    const base = memorySink(createChatMessageCommitter(store));
    let takeCount = 0;
    const sink: IngestProposalSink = {
      ...base,
      drainWarnings: (): readonly string[] => {
        takeCount += 1;
        return takeCount === 1 ? ["待整理积压 6000 条，本次去重可能不完整"] : [];
      },
    };

    const result = await ingestExport({
      store,
      dir: jsonExportDir(),
      now: NOW,
      reader: "json",
      source_id: SOURCE_ID,
      proposalSink: sink,
      chatCommitter: createChatMessageCommitter(store),
      tierConfig: { auto_ok: [SINGLE_CONV] },
      only: ["张三"],
    });

    expect(result.warnings).toEqual(["待整理积压 6000 条，本次去重可能不完整"]);
    // 「每轮只取一次」：两个会话也只在整轮结束时 drain 一回
    expect(takeCount).toBe(1);
  });

  it("只注入 proposalSink 或只注入 chatCommitter → 明确报错（不静默降级）", async () => {
    const sink = memorySink(createChatMessageCommitter(store));
    let thrown: unknown = null;
    try {
      await ingestExport({
        store,
        dir: jsonExportDir(),
        now: NOW,
        reader: "json",
        source_id: SOURCE_ID,
        proposalSink: sink,
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(isChatIngestError(thrown)).toBe(true);
    if (isChatIngestError(thrown)) expect(thrown.code).toBe("INVALID_TARGET_REF");
  });
});
