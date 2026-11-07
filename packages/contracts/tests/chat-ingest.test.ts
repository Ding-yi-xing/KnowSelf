import { describe, it, expect } from "vitest";
import type { ChatMessageCommitter, ChatMessageCommitInput } from "../src/chat-ingest";

const input: ChatMessageCommitInput = {
  proposal_id: "10000000-0000-0000-0000-000000000001",
  source_id: "20000000-0000-0000-0000-000000000002",
  target: {
    kind: "chat_message",
    batch_id: "30000000-0000-0000-0000-000000000003",
    conversation_id: "wechat:c1",
    message_ids: ["wechat:c1:1", "wechat:c1:2"],
    tier: "review",
    reason_codes: ["TIME_GAP"],
  },
  now: "2026-09-10T10:00:00+08:00",
};

describe("ChatMessageCommitter", () => {
  it("接口可由实现方满足，且 commit 幂等（重复调用 skipped>0 不抛错）", () => {
    const committed = new Set<string>();
    const committer: ChatMessageCommitter = {
      commit(i) {
        if (committed.has(i.proposal_id)) {
          return { committed: 0, skipped: i.target.message_ids.length };
        }
        committed.add(i.proposal_id);
        return { committed: i.target.message_ids.length, skipped: 0 };
      },
    };

    expect(committer.commit(input)).toEqual({ committed: 2, skipped: 0 });
    expect(committer.commit(input)).toEqual({ committed: 0, skipped: 2 });
  });

  it("target 只存引用与分层信息（载荷在 staging）", () => {
    expect(input.target.kind).toBe("chat_message");
    expect(input.target.message_ids.length).toBeLessThanOrEqual(2000);
    expect(["auto", "review"]).toContain(input.target.tier);
  });
});
