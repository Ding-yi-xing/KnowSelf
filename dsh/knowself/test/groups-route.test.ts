import { describe, expect, it, vi } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { dispatch } from "../src/routes/index.js";

const GROUP = {
  conversation_id: "wechat:g1@chatroom",
  platform: "wechat",
  kind: "group",
  title: "测试群",
  owner_person_id: "me",
  member_count: 5,
  first_msg_at: "2026-07-01T00:00:00.000Z",
  last_msg_at: "2026-07-02T00:00:00.000Z",
  msg_count: 3,
  source_ref: "{}",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-02T00:00:00.000Z",
};

const MESSAGES = [
  { message_id: "m1", conversation_id: GROUP.conversation_id, sender_name: "甲", role: "other", ts_ms: 1, msg_date: "2026-07-01", content: "一", content_type: "text" },
  { message_id: "m2", conversation_id: GROUP.conversation_id, sender_name: "乙", role: "other", ts_ms: 2, msg_date: "2026-07-02", content: "二", content_type: "text" },
  { message_id: "m3", conversation_id: GROUP.conversation_id, sender_name: "我", role: "me", ts_ms: 3, msg_date: "2026-07-02", content: "三", content_type: "text" },
];

function makeServices(): KnowselfServices {
  return {
    personStore: {
      conversations: {
        list: vi.fn(() => [GROUP]),
        get: vi.fn((id: string) => (id === GROUP.conversation_id ? GROUP : null)),
      },
      messages: {
        count: vi.fn(() => MESSAGES.length),
        list: vi.fn(() => MESSAGES),
      },
    },
  } as unknown as KnowselfServices;
}

describe("群聊只读路由", () => {
  it("GET /groups 返回群目录", async () => {
    const result = await dispatch(new URL("http://dsh/knowself-api/groups"), makeServices());
    expect(result.status).toBe(200);
    expect((result.body as unknown[]).length).toBe(1);
  });

  it("GET /group/:id 返回群行；直聊 id 返回 404", async () => {
    const services = makeServices();
    const hit = await dispatch(new URL(`http://dsh/knowself-api/group/${encodeURIComponent(GROUP.conversation_id)}`), services);
    expect(hit.status).toBe(200);
    const miss = await dispatch(new URL("http://dsh/knowself-api/group/missing"), services);
    expect(miss.status).toBe(404);
  });

  it("GET /group/:id/timeline 返回最新优先的消息", async () => {
    const result = await dispatch(
      new URL(`http://dsh/knowself-api/group/${encodeURIComponent(GROUP.conversation_id)}/timeline?limit=3`),
      makeServices(),
    );
    expect(result.status).toBe(200);
    const rows = result.body as Array<{ content: string }>;
    expect(rows.map((row) => row.content)).toEqual(["三", "二", "一"]);
  });

  it("人物层缺失 → 503 降级", async () => {
    const result = await dispatch(new URL("http://dsh/knowself-api/groups"), {} as KnowselfServices);
    expect(result.status).toBe(503);
  });
});
