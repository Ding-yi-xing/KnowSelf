/**
 * 派生层三仓库测试（DESIGN-13 §3.3 / §3.4 / §3.8）：
 * relationships / events / metrics 的核心语义——manual_locked 避让（§6.2 规则 2）、
 * 重建删除（D3）、意图幂等、快照保留策略。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonStore, type PersonStore } from "../src/index";

const NOW = "2026-09-10T10:00:00+08:00";
const P_A = "person-a";
const P_B = "person-b";

let dir: string;
let store: PersonStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "knowself-derive-"));
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
  // relationships / person_metrics 等表有 persons 外键，先 seed 两个合成人物
  store.persons.insert({ person_id: P_A, subject_kind: "contact", display_name: "甲" }, NOW);
  store.persons.insert({ person_id: P_B, subject_kind: "contact", display_name: "乙" }, NOW);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("relationships（§3.3）", () => {
  it("upsertAuto 新建后按唯一键更新，不产生重复行", () => {
    const first = store.relationships.upsertAuto(
      { counterpart_id: P_A, scope_kind: "global", closeness: 0.7 },
      { produced_by: "mining:rel-v1", now: NOW },
    );
    expect(first.skipped_locked).toBe(false);

    store.relationships.upsertAuto(
      { counterpart_id: P_A, scope_kind: "global", closeness: 0.9, relation_type: "client" },
      { produced_by: "mining:rel-v1", now: NOW },
    );
    const rows = store.relationships.listBySubject("me", { min_closeness: 0.8 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closeness).toBe(0.9);
    expect(rows[0]?.relation_type).toBe("client");
    expect(rows[0]?.source).toBe("auto");
    expect(rows[0]?.manual_locked).toBe(false);
  });

  it("manual_locked=1 时 auto 写跳过并回报", () => {
    const created = store.relationships.upsertAuto(
      { counterpart_id: P_A, scope_kind: "global" },
      { produced_by: "mining:rel-v1", now: NOW },
    );
    store.relationships.updateManual(created.relation_id, { note: "人工锁定" }, NOW);

    const blocked = store.relationships.upsertAuto(
      { counterpart_id: P_A, scope_kind: "global", closeness: 0.99 },
      { produced_by: "mining:rel-v1", now: NOW },
    );
    expect(blocked.skipped_locked).toBe(true);
    expect(store.relationships.get({
      subject_id: "me", counterpart_id: P_A, scope_kind: "global", scope_id: "",
    })?.closeness).toBe(0.5);
  });

  it("replaceScope 删非锁定 auto 行、保留锁定行、插新行并回报 skipped_locked", () => {
    const lockedOne = store.relationships.upsertAuto(
      { counterpart_id: P_A, scope_kind: "global" },
      { produced_by: "mining:rel-v0", now: NOW },
    );
    store.relationships.updateManual(lockedOne.relation_id, { note: "锁" }, NOW);
    store.relationships.upsertAuto(
      { counterpart_id: P_B, scope_kind: "global" },
      { produced_by: "mining:rel-v0", now: NOW },
    );

    const result = store.relationships.replaceScope({
      scope_kind: "global",
      scope_id: "",
      rows: [{ counterpart_id: P_A, scope_kind: "global" }],
      produced_by: "mining:rel-v1",
    });
    expect(result.replaced).toBe(1); // 只删了 P_B 的未锁行
    expect(result.skipped_locked).toBe(2); // 存量锁行 + 新行撞锁各 1
    const remain = store.relationships.listByScope({ scope_kind: "global", scope_id: "" });
    expect(remain).toHaveLength(1);
    expect(remain[0]?.counterpart_id).toBe(P_A);
  });

  it("countByType 按 subject 过滤统计", () => {
    store.relationships.upsertAuto(
      { counterpart_id: P_A, scope_kind: "global", relation_type: "client" },
      { produced_by: "x", now: NOW },
    );
    store.relationships.upsertAuto(
      { counterpart_id: P_B, scope_kind: "global", relation_type: "friend" },
      { produced_by: "x", now: NOW },
    );
    expect(store.relationships.countByType("me").client).toBe(1);
    expect(store.relationships.countByType("me").friend).toBe(1);
  });
});

describe("events / person_facts（§3.4）", () => {
  it("insertManual 直接锁定；upsertAuto 幂等且遇锁跳过", () => {
    const manual = store.events.insertManual(
      { person_id: P_A, title: "手动事件", event_date: "2026-09-01" },
      NOW,
    );
    expect(manual.manual_locked).toBe(true);
    expect(manual.source_kind).toBe("manual");

    const blocked = store.events.upsertAuto(
      { event_id: manual.event_id, title: "想覆盖", event_date: "2026-09-01" },
      { produced_by: "mining:events-v1", now: NOW },
    );
    expect(blocked.skipped_locked).toBe(true);
    expect(store.events.get(manual.event_id)?.title).toBe("手动事件");

    const autoId = "fixed-auto-event";
    const first = store.events.upsertAuto(
      { event_id: autoId, person_id: P_A, title: "v1", event_date: "2026-09-02" },
      { produced_by: "mining:events-v1", now: NOW },
    );
    store.events.upsertAuto(
      { event_id: autoId, person_id: P_A, title: "v2", event_date: "2026-09-02" },
      { produced_by: "mining:events-v1", now: NOW },
    );
    expect(first.event_id).toBe(autoId);
    expect(store.events.get(autoId)?.title).toBe("v2");
  });

  it("deleteByProducedBy 只删非锁定的异版本行", () => {
    store.events.upsertAuto(
      { event_id: "e1", title: "旧版", event_date: "2026-09-01" },
      { produced_by: "mining:events-v1", now: NOW },
    );
    const kept = store.events.upsertAuto(
      { event_id: "e2", title: "新版", event_date: "2026-09-02" },
      { produced_by: "mining:events-v2", now: NOW },
    );
    store.events.setManualLocked(kept.event_id, true, NOW);

    const result = store.events.deleteByProducedBy({ produced_by_not: "mining:events-v2" });
    expect(result.deleted).toBe(1);
    expect(store.events.get("e1")).toBeNull();
    expect(store.events.get("e2")?.title).toBe("新版");
  });

  it("listFacts / upsertFacts：稳定 fact_id 幂等，锁定跳过回报", () => {
    store.events.upsertFacts([
      { fact_id: "f1", person_id: P_A, fact_kind: "topic", fact_value: "钓鱼", produced_by: "v1" },
      { fact_id: "f2", person_id: P_B, fact_kind: "topic", fact_value: "健身", produced_by: "v1" },
    ]);
    store.events.upsertFacts([
      { fact_id: "f1", person_id: P_A, fact_kind: "topic", fact_value: "海钓", produced_by: "v2" },
    ]);
    expect(store.events.listFacts({ person_id: P_A })[0]?.fact_value).toBe("海钓");
    expect(store.events.listFacts({ fact_kind: "topic" })).toHaveLength(2);

    store.events.setFactManualLocked("f1", true, NOW);
    const blocked = store.events.upsertFacts([
      { fact_id: "f1", person_id: P_A, fact_kind: "topic", fact_value: "覆盖失败", produced_by: "v3" },
    ]);
    expect(blocked.skipped_locked).toBe(1);
    expect(blocked.upserted).toBe(0);
    expect(store.events.listFacts({ person_id: P_A })[0]?.fact_value).toBe("海钓");
  });
});

describe("metrics（§3.8）", () => {
  it("upsert 按六元唯一键更新；locked 跳过并回报", () => {
    const key = { person_id: P_A, scope_kind: "global" as const, scope_id: "", period: "all" as const, period_key: "", metric_key: "msg_count" };
    store.metrics.upsert([
      { ...key, metric_value: 10, produced_by: "mining:metrics-v1", computed_at: NOW },
    ]);
    store.metrics.upsert([
      { ...key, metric_value: 12, produced_by: "mining:metrics-v1", computed_at: NOW },
    ]);
    const row = store.metrics.get(key);
    expect(row?.metric_value).toBe(12);

    store.metrics.setManualLocked(row!.metric_id, true, NOW);
    const blocked = store.metrics.upsert([
      { ...key, metric_value: 99, produced_by: "mining:metrics-v1", computed_at: NOW },
    ]);
    expect(blocked.skipped_locked).toBe(1);
    expect(store.metrics.get(key)?.metric_value).toBe(12);
  });

  it("deleteByProducedBy 不删锁定行", () => {
    store.metrics.upsert([
      {
        person_id: P_A, scope_kind: "global", metric_key: "a", metric_value: 1,
        produced_by: "old", computed_at: NOW,
      },
      {
        person_id: P_B, scope_kind: "global", metric_key: "b", metric_value: 2,
        produced_by: "new", computed_at: NOW,
      },
    ]);
    const locked = store.metrics.get({
      person_id: P_B, scope_kind: "global", scope_id: "", period: "all", period_key: "",
      metric_key: "b",
    });
    store.metrics.setManualLocked(locked!.metric_id, true, NOW);
    const result = store.metrics.deleteByProducedBy({ produced_by_not: "new" });
    expect(result.deleted).toBe(1);
    expect(store.metrics.list({})).toHaveLength(1);
  });

  it("intents 以 message_id 幂等；按版本位删除", () => {
    // chat_message_intents.message_id 外键指向 chat_messages（DESIGN-12 §5.3），先 seed 会话与消息
    store.conversations.upsertFromCommit(
      { conversation_id: "conv-1", platform: "wechat", kind: "direct", title: "t" },
      NOW,
    );
    for (const [messageId, ts] of [["m1", 1000], ["m2", 2000]] as const) {
      store.messages.insertOrIgnore([
        {
          message_id: messageId, conversation_id: "conv-1", platform: "wechat",
          sender_id: "wxid_aaaaaaaaaaaa22", role: "other", ts_ms: ts,
          msg_date: "2026-09-01", batch_id: "b1", ingested_at: NOW,
        },
      ]);
    }
    store.metrics.upsertIntents([
      { message_id: "m1", intent: "consult", confidence: 0.9, matched_rules: "[\"dict\"]", produced_by: "v1", computed_at: NOW },
      { message_id: "m2", intent: "other", produced_by: "v1", computed_at: NOW },
    ]);
    store.metrics.upsertIntents([
      { message_id: "m1", intent: "after_sales", confidence: 0.8, produced_by: "v2", computed_at: NOW },
    ]);
    expect(store.metrics.listIntents({ min_confidence: 0.7 })).toHaveLength(1);
    expect(store.metrics.listIntents({ intent: "after_sales" })[0]?.message_id).toBe("m1");
    expect(store.metrics.deleteIntentsByProducedBy({ produced_by_not: "v2" }).deleted).toBe(1);
    expect(store.metrics.listIntents({})).toHaveLength(1);
  });

  it("graph snapshots：latest 取最新，prune 保留最近 keep 份", () => {
    for (let i = 1; i <= 3; i += 1) {
      store.metrics.insertGraphSnapshot({
        graph_kind: "cooccurrence",
        payload_json: `{"v":${i}}`,
        computed_at: `2026-09-0${i}T00:00:00Z`,
      });
    }
    expect(store.metrics.latestGraphSnapshot({
      graph_kind: "cooccurrence", scope_kind: "global", scope_id: "",
    })?.payload_json).toBe('{"v":3}');

    const pruned = store.metrics.pruneGraphSnapshots({
      graph_kind: "cooccurrence", scope_kind: "global", scope_id: "", keep: 2,
    });
    expect(pruned.deleted).toBe(1);
    expect(store.metrics.listGraphSnapshots({})).toHaveLength(2);
    expect(store.metrics.listGraphSnapshots({})[0]?.payload_json).toBe('{"v":3}');
  });
});
