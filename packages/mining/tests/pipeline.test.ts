/**
 * 挖掘管线总装测试（DESIGN-12 §3.6 流水线 + §4.1 纳入条件 + 不变量 #1/#2）。
 * 用内存 fake store 验证编排行为；真实 DB 的端到端（T1~T11）在 7b-7c。
 * 全部合成数据（人名只用 张三 / 李四），无真实聊天内容。
 */
import { describe, expect, it } from "vitest";
import type {
  ChatConversationRow,
  ChatMemberRow,
  GraphSnapshotRow,
  MentionRow,
  MetricUpsert,
  MiningMessageRow,
  PersonRow,
} from "@knowself/person-store";
import { GRAPH_SNAPSHOT_KEEP } from "../src/constants";
import { runMiningPipeline, type MiningPipelineStore } from "../src/pipeline";

const T0 = 1_700_000_000_000;
const NOW = "2026-09-22T10:00:00+08:00";
const DIRECT = "wechat:conv-direct";
const GROUP = "wechat:group-1";
let counter = 0;

function person(overrides: Partial<PersonRow> & { person_id: string }): PersonRow {
  return {
    subject_kind: "contact",
    display_name: overrides.person_id,
    remark: "",
    sort_key: "",
    avatar_ref: null,
    status: "active",
    merged_into: null,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: 0,
    conv_count: 0,
    ...overrides,
  } as PersonRow;
}

function conversation(
  conversationId: string,
  kind: ChatConversationRow["kind"],
  title: string,
): ChatConversationRow {
  return {
    conversation_id: conversationId,
    platform: "wechat",
    kind,
    title,
    owner_person_id: "me",
    member_count: 2,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: 0,
    source_ref: "",
    created_at: NOW,
    updated_at: NOW,
  };
}

function memberRow(conversationId: string, personId: string): ChatMemberRow {
  return {
    conversation_id: conversationId,
    person_id: personId,
    group_alias: "",
    role_in_group: "member",
    joined_at: null,
    left_at: null,
    is_active: true,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function msg(conversationId: string, senderPersonId: string, tsMs: number): MiningMessageRow {
  counter += 1;
  return {
    message_id: `m-${counter}`,
    conversation_id: conversationId,
    platform: "wechat",
    role: senderPersonId === "me" ? "me" : "other",
    sender_id: `uid-${senderPersonId}`,
    sender_person_id: senderPersonId,
    ts_ms: tsMs,
    msg_date: "2023-11-14",
    content: "合成文案",
    content_type: "text",
    reply_to: null,
    meta: "{}",
  };
}

interface FakeCalls {
  upserted: MetricUpsert[][];
  snapshots: Record<string, unknown>[];
  pruned: Record<string, unknown>[];
  intents: unknown[][];
}

function fakeStore(): { store: MiningPipelineStore; calls: FakeCalls } {
  const calls: FakeCalls = { upserted: [], snapshots: [], pruned: [], intents: [] };
  const persons = [
    person({ person_id: "person-zhangsan", display_name: "张三", last_msg_at: NOW }),
    person({ person_id: "me", display_name: "我", subject_kind: "self" }),
    person({
      person_id: "person-lisi",
      display_name: "李四",
      status: "merged",
      merged_into: "person-zhangsan",
    }),
  ];
  const conversations = [
    conversation(DIRECT, "direct", "张三"),
    conversation(GROUP, "group", "老同学群"),
  ];
  const messages: MiningMessageRow[] = [
    msg(DIRECT, "person-zhangsan", T0),
    msg(DIRECT, "me", T0 + 60_000),
    msg(DIRECT, "person-zhangsan", T0 + 120_000),
    msg(GROUP, "person-zhangsan", T0 + 180_000),
    msg(GROUP, "person-lisi", T0 + 240_000),
    msg(GROUP, "me", T0 + 300_000),
  ];
  const mentions: MentionRow[] = [
    {
      message_id: messages[4]?.message_id ?? "m-x",
      person_id: "me",
      mention_kind: "at",
      created_at: NOW,
    },
  ];

  const store: MiningPipelineStore = {
    listPersons: () => persons,
    conversations: {
      list: () => conversations,
      listForPerson: (personId) =>
        conversations.filter(
          (conv) =>
            conv.conversation_id === DIRECT ||
            (conv.conversation_id === GROUP && personId === "person-zhangsan"),
        ),
      listMembers: (conversationId) =>
        conversationId === DIRECT || conversationId === GROUP
          ? ["person-zhangsan", "me"].map((id) => memberRow(conversationId, id))
          : [],
    },
    messages: {
      stream: (q) => ({
        async *[Symbol.asyncIterator]() {
          const ids = q.conversation_ids;
          for (const message of messages) {
            if (q.scope_kind === "global") {
              if (ids !== undefined && !ids.includes(message.conversation_id)) continue;
            } else if (message.conversation_id !== q.scope_id) {
              continue;
            }
            yield message;
          }
        },
      }),
      readMentions: () => mentions,
    },
    metrics: {
      upsert: (rows) => {
        calls.upserted.push([...rows]);
        return { upserted: rows.length, skipped_locked: 0 };
      },
      list: () => [],
      latestGraphSnapshot: () => {
        const latest = calls.snapshots[calls.snapshots.length - 1];
        return latest === undefined ? null : (latest as unknown as GraphSnapshotRow);
      },
      insertGraphSnapshot: (row) => {
        const snapshotId = `snap-${calls.snapshots.length + 1}`;
        calls.snapshots.push({ snapshot_id: snapshotId, ...(row as unknown as Record<string, unknown>) });
        return { snapshot_id: snapshotId };
      },
      upsertIntents: (rows) => {
        calls.intents.push([...(rows as unknown as unknown[])]);
        return { upserted: rows.length };
      },
      pruneGraphSnapshots: (q) => {
        calls.pruned.push(q as unknown as Record<string, unknown>);
        return { deleted: 2 };
      },
    },
    getMeta: (key) => (key === "timezone" ? "Asia/Shanghai" : undefined),
  };
  return { store, calls };
}

describe("runMiningPipeline（§3.6 流水线）", () => {
  it("按 person × scope 编排：只处理 active 非 merged 的联系人（'me' 与 merged 不出指标行）", async () => {
    const { store } = fakeStore();
    const result = await runMiningPipeline({ store, now: NOW, write: false });
    expect(result.persons).toBe(1); // 张三（me 排除 / 李四 merged 排除）
    const personsWithRows = new Set(result.rows.map((row) => row.person_id));
    expect([...personsWithRows]).toEqual(["person-zhangsan"]);
    const scopes = new Set(result.rows.map((row) => `${row.scope_kind}:${row.scope_id}`));
    expect(scopes).toContain("global:");
    expect(scopes).toContain(`direct:${DIRECT}`);
    expect(scopes).toContain(`group:${GROUP}`);
  });

  it("价值打分接入：产出 value_score / value_rank / value_score_breakdown 三键", async () => {
    const { store } = fakeStore();
    const result = await runMiningPipeline({ store, now: NOW, write: false });
    const valueKeys = result.rows
      .filter((row) => row.scope_kind === "global" && row.metric_key.startsWith("value_"))
      .map((row) => row.metric_key)
      .sort();
    expect(valueKeys).toEqual(["value_rank", "value_score", "value_score_breakdown"]);
  });

  it("落库：单次 upsert + 一次图谱快照 + 意图行去重落库 + 按 GRAPH_SNAPSHOT_KEEP 裁剪", async () => {
    const { store, calls } = fakeStore();
    const result = await runMiningPipeline({ store, now: NOW });
    expect(calls.upserted).toHaveLength(1);
    expect(calls.upserted[0]).toHaveLength(result.rows.length);
    expect(result.upserted).toBe(result.rows.length);
    expect(calls.snapshots).toHaveLength(1);
    expect(result.snapshotId).toBe("snap-1");
    expect(calls.pruned[0]?.keep).toBe(GRAPH_SNAPSHOT_KEEP);
    expect(result.pruned).toBe(2);
    const payload = JSON.parse(String(calls.snapshots[0]?.payload_json)) as {
      nodes: unknown[];
      graph_version: string;
    };
    expect(payload.graph_version).toBe("mining-graph-v1");
    expect(payload.nodes.length).toBeGreaterThan(0);
    // §2.1 FR-9.3：全量 6 条消息各一行（跨 scope 去重），单次调用
    expect(calls.intents).toHaveLength(1);
    expect(calls.intents[0]).toHaveLength(6);
    expect(result.intentsWritten).toBe(6);
  });

  it("dry-run：write=false 时不写库", async () => {
    const { store, calls } = fakeStore();
    const result = await runMiningPipeline({ store, now: NOW, write: false });
    expect(calls.upserted).toHaveLength(0);
    expect(calls.snapshots).toHaveLength(0);
    expect(calls.pruned).toHaveLength(0);
    expect(calls.intents).toHaveLength(0);
    expect(result.upserted).toBe(0);
    expect(result.intentsWritten).toBe(0);
    expect(result.snapshotId).toBeNull();
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("确定性：同输入两次运行产出逐行一致", async () => {
    const first = fakeStore();
    const second = fakeStore();
    counter = 0;
    const a = await runMiningPipeline({ store: first.store, now: NOW, write: false });
    counter = 0;
    const b = await runMiningPipeline({ store: second.store, now: NOW, write: false });
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
  });

  it("增量（§10.2）：只算受影响 person × 受影响会话；本批贡献 >5% 时图谱全量重建", async () => {
    const { store, calls } = fakeStore();
    await runMiningPipeline({ store, now: NOW }); // 全量基线 → 落快照 snap-1
    const incremental = await runMiningPipeline({
      store,
      now: NOW,
      incremental: { conversation_ids: [DIRECT] },
    });
    const personIds = new Set(incremental.rows.map((row) => row.person_id));
    expect([...personIds]).toEqual(["person-zhangsan"]);
    const scopes = new Set(incremental.rows.map((row) => `${row.scope_kind}:${row.scope_id}`));
    expect(scopes).toContain("global:");
    expect(scopes).toContain(`direct:${DIRECT}`);
    expect(scopes).not.toContain(`group:${GROUP}`); // 群不在受影响会话内
    expect(incremental.persons).toBe(1);
    // DIRECT 片段贡献（co_presence=1）≥ 旧权重 2 的 5% → 全量重建并落新快照
    expect(calls.snapshots).toHaveLength(2);
    expect(incremental.snapshotId).toBe("snap-2");
  });

  it("增量复用：本批无贡献时不重建图谱、不落新快照", async () => {
    const { store, calls } = fakeStore();
    await runMiningPipeline({ store, now: NOW });
    const incremental = await runMiningPipeline({
      store,
      now: NOW,
      incremental: { conversation_ids: ["wechat:conv-empty"] },
    });
    expect(calls.snapshots).toHaveLength(1);
    expect(incremental.snapshotId).toBe("snap-1"); // 复用上一快照
    expect(incremental.rows).toHaveLength(0); // 空会话无受影响 person
  });
});
