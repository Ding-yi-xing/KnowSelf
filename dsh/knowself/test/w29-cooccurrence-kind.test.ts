/**
 * W29 A1：`conversationKindOf` 注入后会话节点类型的判定（合成数据，不连任何库）。
 *
 * 放在 `dsh/knowself/test/` 是因为本波验收口径是
 * `cd dsh/knowself && npx vitest run --pool=forks`，该配置只收本目录下的 .test.ts 文件。
 *
 * 覆盖：
 *   ① `@chatroom` 群会话 → group，`wechat:wxid_xxx` 单聊 → direct；
 *   ② 不注入判定函数时全部保持 group（既有调用方零行为变化，
 *      对应 `packages/mining/tests/co-occurrence-community.test.ts:220` 的 group 断言）。
 */
import { describe, expect, it } from "vitest";
import { buildCoOccurrence } from "@knowself/mining";
import type { MiningMessageRow } from "@knowself/person-store";

const GROUP_ID = "wechat:88888888888@chatroom";
const DIRECT_ID = "wechat:wxid_00f3ez384bwp22";

/** 一条最小合成消息（字段与 `v_chat_messages` 投影同形）。 */
function msg(conversationId: string, messageId: string): MiningMessageRow {
  return {
    message_id: messageId,
    conversation_id: conversationId,
    platform: "wechat",
    role: "user",
    sender_id: "name:测试",
    sender_person_id: "p1",
    ts_ms: 1_700_000_000_000,
    msg_date: "2026-11-11",
    content: "你好",
    content_type: "text",
    reply_to: null,
    meta: "{}",
  };
}

/** 与 pipeline 注入的判定逐字一致。 */
const conversationKindOf = (id: string): "group" | "direct" =>
  id.endsWith("@chatroom") || id.includes("@//chatroom/") ? "group" : "direct";

function baseInput() {
  return {
    persons: [
      { person_id: "me", label: "我" },
      { person_id: "p1", label: "张三" },
    ],
    groups: [
      { conversation_id: GROUP_ID, label: "测试群" },
      { conversation_id: DIRECT_ID, label: "单聊·2wp2" },
    ],
    messagesByConversation: new Map<string, readonly MiningMessageRow[]>([
      [GROUP_ID, [msg(GROUP_ID, "m1"), msg(GROUP_ID, "m2")]],
      [DIRECT_ID, [msg(DIRECT_ID, "m3")]],
    ]),
    groupConversationIds: new Set([GROUP_ID, DIRECT_ID]),
  };
}

describe("W29 A1：conversationKindOf 会话节点类型判定", () => {
  it("@chatroom → group，wechat:wxid_xxx → direct（label 仍取 groups 传入值）", () => {
    const result = buildCoOccurrence({ ...baseInput(), conversationKindOf });
    const group = result.nodes.find((node) => node.id === GROUP_ID);
    const direct = result.nodes.find((node) => node.id === DIRECT_ID);
    expect(group?.kind).toBe("group");
    expect(group?.label).toBe("测试群");
    expect(direct?.kind).toBe("direct");
    expect(direct?.label).toBe("单聊·2wp2");
    // id / ref_id 不因类型判定而改变
    expect(direct?.ref_id).toBe(DIRECT_ID);
  });

  it("不注入判定函数 → 两类会话都保持 group（既有行为零变化）", () => {
    const result = buildCoOccurrence(baseInput());
    expect(result.nodes.find((node) => node.id === GROUP_ID)?.kind).toBe("group");
    expect(result.nodes.find((node) => node.id === DIRECT_ID)?.kind).toBe("group");
  });
});
