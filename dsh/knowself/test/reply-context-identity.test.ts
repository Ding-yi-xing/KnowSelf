import { describe, expect, it } from "vitest";
import { resolveHistoryContactId } from "../src/reply-context-identity.js";

const conversations = [
  { conversation_id: "wechat:wxid_bob", contact_id: "person-uuid-bob" },
  { conversation_id: "wechat:wxid_alice", contact_id: "person-uuid-alice" },
];

describe("reply context identity", () => {
  it("resolves the person_id used by the history repo from the conversation anchor", () => {
    expect(resolveHistoryContactId(conversations, "wechat:wxid_bob")).toBe("person-uuid-bob");
  });

  it("returns undefined when the conversation is not a direct chat", () => {
    expect(resolveHistoryContactId(conversations, "wechat:1234@chatroom")).toBeUndefined();
  });

  it("does not depend on the task's transport username", () => {
    // 任务上存的是微信 username（transport 侧），历史库要的是 person_id；
    // 两者混用会让每轮都 CONTACT_CONVERSATION_MISMATCH（2026-11-17 实际踩过）。
    const taskContactId = "wxid_bob";
    expect(conversations.some((row) => row.contact_id === taskContactId)).toBe(false);
    expect(resolveHistoryContactId(conversations, `wechat:${taskContactId}`)).toBe("person-uuid-bob");
  });

  it("handles an empty conversation list", () => {
    expect(resolveHistoryContactId([], "wechat:wxid_bob")).toBeUndefined();
  });
});
