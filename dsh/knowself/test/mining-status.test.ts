/**
 * W-9 A4：`GET /mining/status` 测试（真库 `:memory:`，不触网）。
 *
 * 这个端点是图谱空态三判定的唯一数据源，所以断言的是**三种判据字段**本身：
 * 「有没有快照」「有多少消息/会话/人」，而不是文案。
 */
import { describe, expect, it } from "vitest";
import { createPersonStore } from "@knowself/person-store";
import type { KnowselfServices } from "../src/services.js";
import { handleMiningStatusRoute } from "../src/routes/mining-status.js";

/** 造一个内存 persons 库（mode none，无需密钥）。 */
function makeStore() {
  return createPersonStore({ dbPath: ":memory:", encryption: { mode: "none" } });
}

/** 包一个最小 ctx。 */
function ctxOf(services: Partial<KnowselfServices>, method = "GET", path = "/mining/status") {
  return { path, method, services } as never;
}

describe("GET /mining/status（W-9 A4）", () => {
  it("没有任何数据：has_snapshot=false，三项计数为真实值", async () => {
    const store = makeStore();
    const result = handleMiningStatusRoute(ctxOf({ personStore: store }));

    expect(result?.status).toBe(200);
    const body = result?.body as Record<string, unknown>;
    expect(body.has_snapshot).toBe(false);
    expect(body.snapshot_id).toBeNull();
    expect(body.node_count).toBe(0);
    expect(body.edge_count).toBe(0);
    expect(body.chat_message_count).toBe(0);
    expect(body.chat_conversation_count).toBe(0);
    // 新库自带 self 一行
    expect(body.person_count).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("有会话与消息、但从未挖掘：消息/会话数如实报出，has_snapshot 仍为 false", () => {
    const store = makeStore();
    const now = "2026-11-12T00:00:00.000Z";
    store.conversations.upsertFromCommit(
      {
        conversation_id: "c1",
        platform: "other",
        kind: "group",
        title: "三人小组",
        owner_person_id: "me",
        member_count: 4,
      },
      now,
    );
    store.messages.insertOrIgnore(
      [0, 1, 2].map((i) => ({
        message_id: `m${i}`,
        conversation_id: "c1",
        platform: "other" as const,
        sender_id: `u${i}`,
        role: "other" as const,
        ts_ms: Date.parse(`2026-11-12T00:0${i}:00.000Z`),
        msg_date: "2026-11-12",
        content: `第 ${i} 条`,
        content_type: "text" as const,
        reply_to: null,
        meta: "{}",
        batch_id: "b1",
        ingested_at: now,
      })),
    );

    const body = handleMiningStatusRoute(ctxOf({ personStore: store }))?.body as Record<string, unknown>;
    expect(body.chat_conversation_count).toBe(1);
    expect(body.chat_message_count).toBe(3);
    expect(body.has_snapshot).toBe(false); // 有数据但没挖掘过 → 前端该给「开始挖掘」
    store.close();
  });

  it("人物层降级 → 503 degraded(layer=person)", () => {
    const result = handleMiningStatusRoute(ctxOf({}));
    expect(result?.status).toBe(503);
    expect(result?.body).toMatchObject({ status: "degraded", layer: "person" });
  });

  it("非本路径 / 非 GET → undefined（交给 404，不抢占既有路由）", () => {
    const store = makeStore();
    expect(handleMiningStatusRoute(ctxOf({ personStore: store }, "GET", "/mining/other"))).toBeUndefined();
    expect(handleMiningStatusRoute(ctxOf({ personStore: store }, "POST"))).toBeUndefined();
    store.close();
  });
});
