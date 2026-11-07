/**
 * mining 集成测试（DESIGN-12 §11.2 的 T1 / T2 / T3 / T4 / T5 / T6 / T9 / T11 子集）。
 * 真实 persons.sqlite 临时库（`encryption: { mode: "none" }`），种子数据全部合成。
 * 未覆盖：T8 gold 集（需 §5.5 分层盲标工单）/ T10 性能（1 万条 golden 对照，独立批次）—— 见 `docs/units/mining/status.md`。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersonStore,
  type MetricRow,
  type MetricUpsert,
  type PersonStore,
} from "@knowself/person-store";
import { exportMining, type MiningExportStore } from "../src/export-api";
import { runMiningPipeline } from "../src/pipeline";
import { getGraphSnapshot, getPersonMetrics, getRanking, type MiningReadStore } from "../src/read";
import type { ScoreWeights } from "../src/value-scorer";

const NOW = "2026-09-22T10:00:00+08:00";
const LATER = "2026-09-22T11:00:00+08:00";
const T0 = 1_700_000_000_000;
const DIRECT = "wechat:conv-direct";
const GROUP = "wechat:group-1";
const ME_UID = "wxid_me";
const ZHANGSAN_UID = "wxid_zhangsan";
const LISI_UID = "wxid_lisi";

/** §3.5 指标字典在 global scope 下的全部键（#1~#27 去掉 group-only 三键，加 #28 三键）。 */
const GLOBAL_KEYS = [
  "msg_count_me",
  "msg_count_other",
  "msg_count_total",
  "active_day_count",
  "session_count",
  "session_count_one_sided",
  "sessions_cross_day",
  "session_duration_total_ms",
  "session_duration_p50_ms",
  "session_msg_p50",
  "active_duration_total_ms",
  "initiative_count_me",
  "initiative_count_other",
  "initiative_ratio_me",
  "initiative_ratio_other",
  "reply_latency_p50_ms",
  "reply_latency_p90_ms",
  "reply_latency_mean_ms",
  "reply_latency_censored_count",
  "my_reply_latency_p50_ms",
  "reply_rate",
  "response_rate_other",
  "active_hour_hist",
  "intent_dist",
  "value_score",
  "value_rank",
  "value_score_breakdown",
];

let dir = "";
let store: PersonStore;
let zhangsanId = "";
let lisiId = "";

/** 结果行取值（`MetricUpsert`，无行返回 undefined）。 */
function resultValue(
  rows: readonly MetricUpsert[],
  personId: string,
  scopeKind: string,
  scopeId: string,
  metricKey: string,
): unknown {
  return rows.find(
    (row) =>
      row.person_id === personId &&
      row.scope_kind === scopeKind &&
      row.scope_id === scopeId &&
      row.metric_key === metricKey,
  )?.metric_value;
}

/** DB 行全量可比串（含 produced_by / computed_at，T5 逐字节比较用）。 */
function dbRowString(row: MetricRow): string {
  return `${row.person_id}|${row.scope_kind}|${row.scope_id}|${row.period}|${row.period_key}|${row.metric_key}|${row.metric_value}|${row.metric_value_json}|${row.produced_by}|${row.computed_at}`;
}

interface Seed {
  /** 追加到群聊的第三方消息条数（T6 用）。 */
  thirdPartyInGroup?: number;
  /** 追加到群聊的「张三→me」双人片段数（T3 复用路径用：把 (张三,me) 边的既有权重堆大，使受影响会话贡献 ≤5%）。 */
  extraSessionsInGroup?: number;
}

function seed(input: Seed = {}): void {
  zhangsanId = store.ensurePersonForUid({
    platform: "wechat",
    platform_uid: ZHANGSAN_UID,
    display_name: "张三",
    now: NOW,
  }).person_id;
  lisiId = store.ensurePersonForUid({
    platform: "wechat",
    platform_uid: LISI_UID,
    display_name: "李四",
    now: NOW,
  }).person_id;
  // 我的平台 uid 必须解析到 'me'，否则回复延迟样本会落到第三方（§3.3.4）
  if (store.aliases.findByUid("wechat", ME_UID) === null) {
    store.aliases.insert(
      {
        alias_id: "alias-me",
        person_id: "me",
        platform: "wechat",
        alias_kind: "platform_uid",
        alias: ME_UID,
        normalized: ME_UID,
        source: "manual",
      },
      NOW,
    );
  }
  store.conversations.upsertFromCommit(
    { conversation_id: DIRECT, platform: "wechat", kind: "direct", title: "张三" },
    NOW,
  );
  store.conversations.upsertFromCommit(
    { conversation_id: GROUP, platform: "wechat", kind: "group", title: "老同学群" },
    NOW,
  );

  const messages = [
    { id: "m-1", conv: DIRECT, uid: ZHANGSAN_UID, role: "other" as const, ts: T0 },
    { id: "m-2", conv: DIRECT, uid: ME_UID, role: "me" as const, ts: T0 + 60_000 },
    { id: "m-3", conv: DIRECT, uid: ZHANGSAN_UID, role: "other" as const, ts: T0 + 120_000 },
    { id: "m-4", conv: DIRECT, uid: ME_UID, role: "me" as const, ts: T0 + 180_000 },
    { id: "m-5", conv: GROUP, uid: ZHANGSAN_UID, role: "other" as const, ts: T0 + 240_000 },
    { id: "m-6", conv: GROUP, uid: ME_UID, role: "me" as const, ts: T0 + 300_000 },
    { id: "m-7", conv: GROUP, uid: ZHANGSAN_UID, role: "other" as const, ts: T0 + 360_000 },
  ];
  for (let i = 0; i < (input.thirdPartyInGroup ?? 0); i += 1) {
    messages.push({
      id: `m-third-${i}`,
      conv: GROUP,
      uid: LISI_UID,
      role: "other" as const,
      ts: T0 + 400_000 + i * 1_000,
    });
  }
  // 每个双人片段 = 张三 / me / 张三 / me 四条（间隔 60s），把双向 direct_reply 与
  // co_presence 的既有权重堆大；片段间间隔 2,000,000 > SESSION_GAP，彼此独立
  for (let i = 0; i < (input.extraSessionsInGroup ?? 0); i += 1) {
    const base = T0 + 4_000_000 + i * 2_000_000;
    messages.push(
      {
        id: `m-extra-${i}-a`, conv: GROUP, uid: ZHANGSAN_UID, role: "other" as const, ts: base,
      },
      {
        id: `m-extra-${i}-b`, conv: GROUP, uid: ME_UID, role: "me" as const, ts: base + 60_000,
      },
      {
        id: `m-extra-${i}-c`, conv: GROUP, uid: ZHANGSAN_UID, role: "other" as const, ts: base + 120_000,
      },
      {
        id: `m-extra-${i}-d`, conv: GROUP, uid: ME_UID, role: "me" as const, ts: base + 180_000,
      },
    );
  }
  store.messages.insertOrIgnore(
    messages.map((message) => ({
      message_id: message.id,
      conversation_id: message.conv,
      platform: "wechat",
      sender_id: message.uid,
      role: message.role,
      ts_ms: message.ts,
      msg_date: "2023-11-14",
      content: "合成文案",
      content_type: "text",
      batch_id: "batch-1",
      ingested_at: NOW,
    })),
  );
  // `listForPerson` 走 chat_members：真实库由落档事务填充；本测试直插消息，故显式补成员
  const memberships: { conversation_id: string; person_id: string }[] = [
    { conversation_id: DIRECT, person_id: zhangsanId },
    { conversation_id: DIRECT, person_id: "me" },
    { conversation_id: GROUP, person_id: zhangsanId },
    { conversation_id: GROUP, person_id: lisiId },
    { conversation_id: GROUP, person_id: "me" },
  ];
  for (const membership of memberships) {
    store.conversations.upsertMember({ ...membership, is_active: true }, NOW);
  }
  store.conversations.recomputeMemberStats(DIRECT, NOW);
  store.conversations.recomputeMemberStats(GROUP, NOW);
}

function freshStore(): void {
  dir = mkdtempSync(join(tmpdir(), "knowself-mining-"));
  store = createPersonStore({
    dbPath: join(dir, "persons.sqlite"),
    encryption: { mode: "none" },
  });
}

beforeEach(freshStore);

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("T1 端到端键集覆盖（真实库）", () => {
  it("global scope 产出 §3.5 全部 27 个键（含 value_* 三键）", async () => {
    seed();
    const result = await runMiningPipeline({ store, now: NOW });
    expect(result.persons).toBe(2); // 张三 + 李四（'me' 自身排除）
    const zsKeys = new Set(
      result.rows
        .filter((row) => row.scope_kind === "global" && row.person_id === zhangsanId)
        .map((row) => row.metric_key),
    );
    for (const key of GLOBAL_KEYS) expect(zsKeys, key).toContain(key);
    expect(zsKeys.size).toBe(GLOBAL_KEYS.length);
  });

  it("读路径经视图：alias 解析生效（回复延迟样本非空）", async () => {
    seed();
    const result = await runMiningPipeline({ store, now: NOW, write: false });
    const p50 = result.rows.find(
      (row) =>
        row.scope_kind === "global" &&
        row.person_id === zhangsanId &&
        row.metric_key === "reply_latency_p50_ms",
    );
    expect(p50?.metric_value).not.toBeNull();
  });
});

describe("T2 幂等与人工优先", () => {
  it("同输入两次重算逐行一致", async () => {
    seed();
    const first = await runMiningPipeline({ store, now: NOW });
    const second = await runMiningPipeline({ store, now: NOW });
    const normalize = (rows: typeof first.rows): string =>
      JSON.stringify(
        rows
          .map(
            (row) =>
              `${row.person_id}|${row.scope_kind}|${row.scope_id}|${row.metric_key}|${row.metric_value}`,
          )
          .sort(),
      );
    expect(normalize(second.rows)).toBe(normalize(first.rows));
  });

  it("manual_locked=1 的行不被自动重算覆盖（FR-8.6）", async () => {
    seed();
    await runMiningPipeline({ store, now: NOW });
    const key = {
      person_id: zhangsanId,
      scope_kind: "global" as const,
      scope_id: "",
      period: "all" as const,
      period_key: "",
      metric_key: "msg_count_other",
    };
    const existing = store.metrics.get(key);
    expect(existing).not.toBeNull();
    store.metrics.setManualLocked(String(existing?.metric_id), true, NOW);

    // 追加消息 → 未锁定行会变，锁定行必须保持原值
    seed({ thirdPartyInGroup: 3 });
    const rerun = await runMiningPipeline({ store, now: LATER });
    const locked = store.metrics.get(key);
    expect(locked?.metric_value).toBe(existing?.metric_value);
    expect(locked?.manual_locked).toBe(true);
    expect(rerun.skippedLocked).toBeGreaterThanOrEqual(1);
  });
});

describe("T6 群聊归因（M2 不变量，真实库）", () => {
  it("第三方消息不改变 (me, 张三) 主指标", async () => {
    seed();
    const base = await runMiningPipeline({ store, now: NOW, write: false });
    const baseRows = base.rows;
    const baseZhangId = zhangsanId; // 重建库后 id 会变，必须显式捕获

    store.close();
    rmSync(dir, { recursive: true, force: true });
    freshStore();
    seed({ thirdPartyInGroup: 5 });
    const newZhangId = zhangsanId;
    const withThirdParty = await runMiningPipeline({ store, now: NOW, write: false });

    const pick = (
      rows: typeof baseRows,
      personId: string,
      scopeKind: string,
      metricKey: string,
    ): unknown =>
      rows.find(
        (row) =>
          row.scope_kind === scopeKind &&
          row.person_id === personId &&
          row.metric_key === metricKey,
      )?.metric_value;
    for (const metricKey of [
      "msg_count_me",
      "msg_count_other",
      "msg_count_total",
      "initiative_count_other",
    ]) {
      expect(pick(withThirdParty.rows, newZhangId, "global", metricKey)).toBe(
        pick(baseRows, baseZhangId, "global", metricKey),
      );
    }
    expect(pick(baseRows, baseZhangId, "group", "msg_count_third_party")).toBe(0);
    expect(pick(withThirdParty.rows, newZhangId, "group", "msg_count_third_party")).toBe(5);
  });
});

describe("T3 增量重算（追加 100 条）", () => {
  it("单方消息：仅受影响 person/scope 变化，其余行（含 computed_at）不变；图谱复用不重落", async () => {
    // 20 个群聊双人片段把 (张三,me) 双向边权重堆大：受影响会话 DIRECT 的既有贡献
    // （co_presence 1 / direct_reply 各向 2·1）占比 ≤5% → §10.2 step 4 判定复用
    seed({ extraSessionsInGroup: 20 });
    await runMiningPipeline({ store, now: NOW });
    const before = store.metrics.list({});

    // 追加 100 条张三单方消息：首条与旧消息间隔 > SESSION_GAP（新片段），
    // 内部间隔 60s（同一片段、单一发送者）→ 不产生任何新共现边 → step 4 判定复用
    store.messages.insertOrIgnore(
      Array.from({ length: 100 }, (_, i) => ({
        message_id: `m-append-${i}`,
        conversation_id: DIRECT,
        platform: "wechat",
        sender_id: ZHANGSAN_UID,
        role: "other" as const,
        ts_ms: T0 + 2_000_000 + i * 60_000,
        msg_date: "2023-11-14",
        content: "合成文案",
        content_type: "text",
        batch_id: "batch-2",
        ingested_at: LATER,
      })),
    );
    const snapshotsBefore = store.metrics.listGraphSnapshots({});

    const result = await runMiningPipeline({
      store,
      now: LATER,
      incremental: { conversation_ids: [DIRECT] },
    });

    // 受影响：张三 direct / global 行重算（+100 条「对方」消息；global 另含群聊 40 条）
    expect(resultValue(result.rows, zhangsanId, "direct", DIRECT, "msg_count_other")).toBe(102);
    expect(resultValue(result.rows, zhangsanId, "global", "", "msg_count_other")).toBe(144);

    // 逐行对照：唯一变化 = 张三 global / direct 行；李四与张三 group 行连 computed_at 都不变
    const beforeMap = new Map(before.map((row) => [dbRowString(row), true]));
    const after = store.metrics.list({});
    for (const row of after) {
      if (beforeMap.has(dbRowString(row))) continue;
      expect(
        row.person_id === zhangsanId &&
          (row.scope_kind === "global" ||
            (row.scope_kind === "direct" && row.scope_id === DIRECT)),
        `意外变化行：${dbRowString(row)}`,
      ).toBe(true);
    }
    const zsGlobal = after.find(
      (row) =>
        row.person_id === zhangsanId && row.scope_kind === "global" && row.metric_key === "msg_count_other",
    );
    expect(zsGlobal?.computed_at).toBe(LATER);
    const zsGroup = after.find(
      (row) =>
        row.person_id === zhangsanId && row.scope_kind === "group" && row.metric_key === "msg_count_other",
    );
    expect(zsGroup?.computed_at).toBe(NOW);

    // 图谱复用：快照数不变，snapshotId 指向上一快照
    expect(store.metrics.listGraphSnapshots({})).toHaveLength(snapshotsBefore.length);
    expect(result.snapshotId).toBe(snapshotsBefore[0]?.snapshot_id);
  });

  it("新成员发消息 → 新节点触发图谱全量重建并落新快照；其余 person 不动", async () => {
    seed();
    await runMiningPipeline({ store, now: NOW });
    const snapshotsBefore = store.metrics.listGraphSnapshots({}).length;

    const qianqiId = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_qianqi",
      display_name: "钱七",
      now: LATER,
    }).person_id;
    const NEW_DIRECT = "wechat:conv-qianqi";
    store.conversations.upsertFromCommit(
      { conversation_id: NEW_DIRECT, platform: "wechat", kind: "direct", title: "钱七" },
      LATER,
    );
    store.conversations.upsertMember(
      { conversation_id: NEW_DIRECT, person_id: qianqiId, is_active: true },
      LATER,
    );
    store.conversations.upsertMember(
      { conversation_id: NEW_DIRECT, person_id: "me", is_active: true },
      LATER,
    );
    store.conversations.recomputeMemberStats(NEW_DIRECT, LATER);
    store.messages.insertOrIgnore([
      {
        message_id: "m-qianqi-1",
        conversation_id: NEW_DIRECT,
        platform: "wechat",
        sender_id: "wxid_qianqi",
        role: "other",
        ts_ms: T0 + 10_000_000,
        msg_date: "2023-11-14",
        content: "合成文案",
        content_type: "text",
        batch_id: "batch-3",
        ingested_at: LATER,
      },
    ]);

    const result = await runMiningPipeline({
      store,
      now: LATER,
      incremental: { conversation_ids: [NEW_DIRECT] },
    });

    expect(result.persons).toBe(1); // 仅钱七受影响
    expect(resultValue(result.rows, qianqiId, "global", "", "msg_count_other")).toBe(1);
    // 新节点 → 全量重建并落新快照（KEEP=10，两份都在）
    const snaps = store.metrics.listGraphSnapshots({});
    expect(snaps).toHaveLength(snapshotsBefore + 1);
    expect(result.snapshotId).toBe(snaps[0]?.snapshot_id);
    // 其余 person 完全未动：张三 global msg_count_other 仍为 4 且 computed_at 不变
    const zs = store.metrics
      .list({})
      .find(
        (row) =>
          row.person_id === zhangsanId && row.scope_kind === "global" && row.metric_key === "msg_count_other",
      );
    expect(zs?.metric_value).toBe(4);
    expect(zs?.computed_at).toBe(NOW);
  });
});

describe("T4 批次回滚后重算", () => {
  it("已回滚批次的消息不参与任何指标（v_chat_messages 语义）", async () => {
    // 人物 / 别名 / 会话；DIRECT 的消息走真实落档路径（staging → commitStaged）
    zhangsanId = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: ZHANGSAN_UID,
      display_name: "张三",
      now: NOW,
    }).person_id;
    lisiId = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: LISI_UID,
      display_name: "李四",
      now: NOW,
    }).person_id;
    if (store.aliases.findByUid("wechat", ME_UID) === null) {
      store.aliases.insert(
        {
          alias_id: "alias-me",
          person_id: "me",
          platform: "wechat",
          alias_kind: "platform_uid",
          alias: ME_UID,
          normalized: ME_UID,
          source: "manual",
        },
        NOW,
      );
    }
    store.conversations.upsertFromCommit(
      { conversation_id: DIRECT, platform: "wechat", kind: "direct", title: "张三" },
      NOW,
    );
    store.conversations.upsertFromCommit(
      { conversation_id: GROUP, platform: "wechat", kind: "group", title: "老同学群" },
      NOW,
    );

    // 群消息：独立批次（不参与回滚），直插 + 显式补成员
    store.messages.insertOrIgnore([
      {
        message_id: "m-5", conversation_id: GROUP, platform: "wechat", sender_id: ZHANGSAN_UID,
        role: "other", ts_ms: T0 + 240_000, msg_date: "2023-11-14", content: "合成文案",
        content_type: "text", batch_id: "batch-static", ingested_at: NOW,
      },
      {
        message_id: "m-6", conversation_id: GROUP, platform: "wechat", sender_id: ME_UID,
        role: "me", ts_ms: T0 + 300_000, msg_date: "2023-11-14", content: "合成文案",
        content_type: "text", batch_id: "batch-static", ingested_at: NOW,
      },
      {
        message_id: "m-7", conversation_id: GROUP, platform: "wechat", sender_id: ZHANGSAN_UID,
        role: "other", ts_ms: T0 + 360_000, msg_date: "2023-11-14", content: "合成文案",
        content_type: "text", batch_id: "batch-static", ingested_at: NOW,
      },
    ]);
    for (const personId of [zhangsanId, lisiId, "me"]) {
      store.conversations.upsertMember(
        { conversation_id: GROUP, person_id: personId, is_active: true },
        NOW,
      );
    }
    store.conversations.recomputeMemberStats(GROUP, NOW);

    // DIRECT 四消息：staging → commitStaged（真实落档路径，成员关系由落档事务填充）
    store.staging.beginBatch({
      batch_id: "batch-t4",
      platform: "wechat",
      extractor: "test",
      tool_version: "1",
      now: NOW,
    });
    store.staging.stageMessages({
      batch_id: "batch-t4",
      conversation_id: DIRECT,
      now: NOW,
      rows: [
        { message_id: "m-1", platform: "wechat", sender_id: ZHANGSAN_UID, sender_name: "张三", role: "other", ts_ms: T0, msg_date: "2023-11-14", content: "合成文案", content_type: "text", reply_to: null, meta: "{}" },
        { message_id: "m-2", platform: "wechat", sender_id: ME_UID, sender_name: "我", role: "me", ts_ms: T0 + 60_000, msg_date: "2023-11-14", content: "合成文案", content_type: "text", reply_to: null, meta: "{}" },
        { message_id: "m-3", platform: "wechat", sender_id: ZHANGSAN_UID, sender_name: "张三", role: "other", ts_ms: T0 + 120_000, msg_date: "2023-11-14", content: "合成文案", content_type: "text", reply_to: null, meta: "{}" },
        { message_id: "m-4", platform: "wechat", sender_id: ME_UID, sender_name: "我", role: "me", ts_ms: T0 + 180_000, msg_date: "2023-11-14", content: "合成文案", content_type: "text", reply_to: null, meta: "{}" },
      ],
    });
    store.commitStaged({
      batch_id: "batch-t4",
      conversation_id: DIRECT,
      proposal_id: "proposal-test",
      now: NOW,
      conversation: { conversation_id: DIRECT, platform: "wechat", kind: "direct", title: "张三" },
    });

    // 回滚前：直聊 2 + 群 2 = 4 条「对方」、直聊 2 + 群 1 = 3 条「我」
    const run1 = await runMiningPipeline({ store, now: NOW, write: false });
    expect(resultValue(run1.rows, zhangsanId, "global", "", "msg_count_other")).toBe(4);
    expect(resultValue(run1.rows, zhangsanId, "global", "", "msg_count_me")).toBe(3);

    store.revertBatch({ batch_id: "batch-t4", now: LATER });

    // 回滚后：DIRECT 四条全部消失（不参与任何指标）
    const run2 = await runMiningPipeline({ store, now: LATER, write: false });
    expect(resultValue(run2.rows, zhangsanId, "global", "", "msg_count_other")).toBe(2);
    expect(resultValue(run2.rows, zhangsanId, "global", "", "msg_count_me")).toBe(1);
    expect(resultValue(run2.rows, zhangsanId, "global", "", "msg_count_total")).toBe(3);
    expect(
      run2.rows.some(
        (row) => row.person_id === zhangsanId && row.scope_kind === "direct" && row.scope_id === DIRECT,
      ),
    ).toBe(false);
  });
});

describe("意图落库（§2.1 FR-9.3 / P1-4 收尾）", () => {
  it("write 跑完整条消息各有一行（含 me 的消息），produced_by 为意图规则版本位，重跑幂等", async () => {
    seed();
    const result = await runMiningPipeline({ store, now: NOW });
    expect(result.intentsWritten).toBe(7); // seed 共 7 条消息，跨 scope 去重后 7 行
    const rows = store.metrics.listIntents({});
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.produced_by).toBe("mining:intent-rule-v1");
      expect(row.computed_at).toBe(NOW);
    }
    // me 的消息也有意图行（落库对象是全部消息，`intent_dist` 才只统计对方）
    const meRow = rows.find((row) => row.message_id === "m-2");
    expect(meRow).toBeDefined();

    const again = await runMiningPipeline({ store, now: NOW });
    expect(again.intentsWritten).toBe(7);
    expect(store.metrics.listIntents({})).toHaveLength(7);
  });
});

describe("T5 版本重建（改 produced_by）", () => {
  const normalize = (rows: readonly MetricRow[]): string[] =>
    rows.map(dbRowString).sort();

  it("整层删除后同参数重算逐字节一致", async () => {
    seed();
    await runMiningPipeline({ store, now: NOW });
    const first = store.metrics.list({});
    expect(first.length).toBeGreaterThan(0);

    // 整层重建：清空非锁定行（D3：deleteByProducedBy 只删 produced_by 不符且未锁定的行）
    const deleted = store.metrics.deleteByProducedBy({ produced_by_not: "mining:rebuild-test" });
    expect(deleted.deleted).toBe(first.length);
    expect(store.metrics.list({})).toHaveLength(0);

    await runMiningPipeline({ store, now: NOW });
    expect(normalize(store.metrics.list({}))).toEqual(normalize(first));
  });

  it("权重版本提升只改 produced_by，数值逐字节不变；重建回默认版本复原", async () => {
    seed();
    await runMiningPipeline({ store, now: NOW });
    const baseline = store.metrics.list({});
    const v1Value = baseline.find(
      (row) => row.person_id === zhangsanId && row.metric_key === "value_score",
    );
    expect(v1Value?.produced_by).toMatch(/^mining:score-v1\+[0-9a-f]{8}$/);

    // 同数值、不同版本 → 只有价值行的 produced_by 版本位变化
    const bumped: ScoreWeights = {
      version: "score-v2-test",
      weights: {
        f_freq: 0.2, f_recency: 0.2, f_initiative: 0.1, f_responsiveness: 0.1,
        f_reciprocity: 0.1, f_depth: 0.1, f_business: 0.1, f_network: 0.1,
      },
    };
    await runMiningPipeline({ store, now: NOW, weights: bumped });
    const afterBump = store.metrics.list({});
    const v2Value = afterBump.find(
      (row) => row.person_id === zhangsanId && row.metric_key === "value_score",
    );
    expect(v2Value?.produced_by).toMatch(/^mining:score-v2-test\+[0-9a-f]{8}$/);
    expect(v2Value?.metric_value).toBe(v1Value?.metric_value);
    // 非价值行 produced_by 不随权重版本变化
    const msgRow = afterBump.find(
      (row) => row.person_id === zhangsanId && row.metric_key === "msg_count_other",
    );
    expect(msgRow?.produced_by).toBe("mining:metrics-v1");

    // 重建回默认权重 → 与基线逐字节一致
    store.metrics.deleteByProducedBy({ produced_by_not: "mining:score-v2-test" });
    await runMiningPipeline({ store, now: NOW });
    expect(normalize(store.metrics.list({}))).toEqual(normalize(baseline));
  });
});

describe("T9 依赖矩阵（静态守卫）", () => {
  it("packages/mining/src 只依赖 contracts / config / person-store，且不直连数据库", () => {
    const srcDir = join(process.cwd(), "packages", "mining", "src");
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
    const allowed = new Set(["@knowself/contracts", "@knowself/config", "@knowself/person-store"]);
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      for (const match of content.matchAll(/from\s+"(@knowself\/[a-z-]+)"/g)) {
        expect(allowed.has(String(match[1])), `${file} → ${String(match[1])}`).toBe(true);
      }
      expect(content, file).not.toContain("new Database(");
      expect(content, file).not.toContain("better-sqlite3");
    }
  });
});

describe("T11 PII 守卫（静态守卫）", () => {
  it("mining 测试 fixture 不含手机号 / 身份证 / 邮箱 / 真实 wxid", () => {
    const testsDir = join(process.cwd(), "packages", "mining", "tests");
    const files = readdirSync(testsDir).filter((name) => name.endsWith(".ts"));
    const patterns: { name: string; re: RegExp }[] = [
      { name: "手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
      { name: "身份证", re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
      { name: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
    ];
    for (const file of files) {
      const content = readFileSync(join(testsDir, file), "utf8");
      for (const { name, re } of patterns) {
        expect(re.test(content), `${file} 含 ${name}`).toBe(false);
      }
      // 真实 wxid 是随机串（数字字母混杂）；合成占位是词典词或连写，故判据取「随机性特征」
      for (const match of content.matchAll(/wxid_[A-Za-z0-9_-]{8,}/g)) {
        const tail = String(match[0]).slice("wxid_".length);
        const digits = (tail.match(/\d/g) ?? []).length;
        const letters = (tail.match(/[A-Za-z]/g) ?? []).length;
        const looksRandom = digits >= 3 && letters >= 3;
        expect(looksRandom, `${file} 含疑似真实 wxid：${String(match[0])}`).toBe(false);
      }
    }
  });
});

describe("读层对真实门面（7c-1：§8.5 读函数 + 注入面结构兼容）", () => {
  it("真实 PersonStore 满足 MiningReadStore，且三个读函数在真实库上返回管线产出", async () => {
    seed();
    await runMiningPipeline({ store, now: NOW });

    // 编译期断言：真实门面必须结构兼容读层注入面（7c-2 路由层据此接线；不兼容则此处编译失败）
    const readStore: MiningReadStore = store;

    // ── A1 图谱快照 ──
    const graph = getGraphSnapshot(readStore);
    expect(graph).not.toBeNull();
    expect(graph!.snapshot.graph_version).toBeTruthy();
    expect(graph!.snapshot.nodes.length).toBeGreaterThan(0);
    expect(graph!.snapshot.edges.length).toBeGreaterThan(0);

    // 诱导子图不变量在真实载荷上成立：边两端必在返回节点集内
    const filtered = getGraphSnapshot(readStore, { min_interaction: 1 })!.snapshot;
    const keptIds = new Set(filtered.nodes.map((node) => node.id));
    for (const edge of filtered.edges) {
      expect(keptIds.has(edge.source) && keptIds.has(edge.target), edge.id).toBe(true);
    }

    // ── R2 人物指标 ──
    const metrics = getPersonMetrics(readStore, zhangsanId);
    expect(metrics.rows.length).toBeGreaterThan(0);
    expect(metrics.rows.every((row) => row.person_id === zhangsanId)).toBe(true);
    const onlyCount = getPersonMetrics(readStore, zhangsanId, { keys: ["msg_count_other"] });
    expect(onlyCount.rows.length).toBeGreaterThan(0);
    expect(onlyCount.rows.every((row) => row.metric_key === "msg_count_other")).toBe(true);

    // ── R3 价值榜单 ──
    const ranking = getRanking(readStore);
    const valueRankRows = store.metrics.list({
      scope_kind: "global",
      scope_id: "",
      metric_keys: ["value_rank"],
    });
    // 榜单人数与库中 value_rank 行一致（不硬编码人数）
    expect(ranking.rows.map((row) => row.person_id).sort()).toEqual(
      valueRankRows.map((row) => row.person_id).sort(),
    );
    // display_name 已 join（不是裸 person_id）
    expect(ranking.rows.every((row) => row.display_name.length > 0)).toBe(true);
    expect(ranking.rows.find((row) => row.person_id === zhangsanId)?.display_name).toBe("张三");
    // rank 升序
    const ranks = ranking.rows.map((row) => row.value_rank ?? 0);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // top 截断在真实库上生效
    expect(getRanking(readStore, { top: 1 }).rows).toHaveLength(1);
  });
});

describe("导出对真实门面（7c-1b：§8.5-R4 exportMining + 注入面结构兼容）", () => {
  it("真实 PersonStore 满足 MiningExportStore，三形态导出取到管线真实产出", async () => {
    seed();
    await runMiningPipeline({ store, now: NOW });

    // 编译期断言：真实门面必须结构兼容导出注入面（7c-2 路由层据此接线；不兼容则此处编译失败）
    const exportStore: MiningExportStore = store;

    const outDir = join(dir, "export-out");
    const result = exportMining(exportStore, { export_kind: "graph", outDir, now: NOW });

    // ── 信封计数取自真实库（不硬编码人数） ──
    expect(result.envelope.generated_at).toBe(NOW);
    expect(result.envelope.counts.persons).toBe(store.listPersons().length);
    expect(result.envelope.counts.conversations).toBe(store.conversations.list().length);
    expect(result.envelope.counts.messages).toBe(store.messages.count());
    expect(result.envelope.counts.messages).toBeGreaterThan(0);

    // ── 落盘：§7.1 三形态真实写出且内容非空 ──
    expect(result.written).toContain("report.md");
    expect(result.written).toContain("data.json");
    expect(result.written).toContain("index.md");
    for (const relative of result.written) {
      expect(readFileSync(join(outDir, relative), "utf8").length, relative).toBeGreaterThan(0);
    }

    // ── data.json（§7.2 信封 + metrics / ranking / graph）取自真实库 ──
    const data = JSON.parse(readFileSync(join(outDir, "data.json"), "utf8")) as {
      envelope: { counts: { messages: number; persons: number; conversations: number } };
      metrics: readonly { person_id: string; display_name: string }[];
      graph: { nodes: readonly { id: string }[] } | null;
      ranking: readonly { person_id: string; display_name: string; value_rank: number }[];
    };

    expect(data.envelope.counts).toEqual(result.envelope.counts);
    // §7.1 要求 2：不以内部 id 作唯一标识，必须带 display_name
    expect(data.metrics.find((row) => row.person_id === zhangsanId)?.display_name).toBe("张三");
    // 榜单来自真实 value_* 行（管线 7b-7d 产出），非空且含张三
    expect(data.ranking.length).toBeGreaterThan(0);
    expect(data.ranking.some((row) => row.person_id === zhangsanId)).toBe(true);
    // export_kind='graph' → 图谱进导出，且含 'me' 节点（§4.1：self 也是节点）
    expect(data.graph).not.toBeNull();
    expect(data.graph!.nodes.map((node) => node.id)).toContain("me");

    // ── markdown 快照（§7.1 第三形态）：人物 / 群 / 图谱文档齐备 ──
    expect(result.written.some((path) => path.startsWith("persons/"))).toBe(true);
    // 文件名净化：`wechat:group-1` 的 `:` 在 Windows 路径非法 → `_`
    expect(result.written).toContain("groups/wechat_group-1.md");
    expect(result.written).toContain("graph/communities.md");
    // index.md 的群索引 / 人物索引用 display_name（非内部 id）
    const index = readFileSync(join(outDir, "index.md"), "utf8");
    expect(index).toContain("老同学群");
    expect(index).toContain("张三");
  });

  it("write=false 不落盘，且与落盘版信封逐字段一致（确定性）", async () => {
    seed();
    await runMiningPipeline({ store, now: NOW });

    const exportStore: MiningExportStore = store;
    const dry = exportMining(exportStore, { export_kind: "weekly", write: false, now: NOW });
    const wet = exportMining(exportStore, {
      export_kind: "weekly",
      outDir: join(dir, "export-out-2"),
      now: NOW,
    });

    expect(dry.written).toEqual([]);
    expect(dry.outDir).toBeNull();
    expect(dry.envelope).toEqual(wet.envelope);
    expect(dry.files).toEqual(wet.files);
  });
});
