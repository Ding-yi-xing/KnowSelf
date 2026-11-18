import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createPersonStore, type PersonStore } from "../src/store";
import { makeTempDir, removeTempDir } from "./helpers";

const NOW = "2026-11-16T12:00:00+08:00";
let dir: string;
let store: PersonStore;

beforeEach(() => {
  dir = makeTempDir();
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

describe("会话直聊/群聊分类", () => {
  it("微信 UPSERT 以会话 ID 后缀为准：wxid → direct，@chatroom → group", () => {
    store.conversations.upsertFromCommit(
      { conversation_id: "wechat:wxid_baby", platform: "wechat", kind: "group", title: "宝宝" },
      NOW,
    );
    store.conversations.upsertFromCommit(
      { conversation_id: "wechat:123@chatroom", platform: "wechat", kind: "direct", title: "亲友群" },
      NOW,
    );
    expect(store.conversations.get("wechat:wxid_baby")?.kind).toBe("direct");
    expect(store.conversations.get("wechat:123@chatroom")?.kind).toBe("group");
  });

  it("非微信平台仍按传入 kind（不被后缀规则误改）", () => {
    store.conversations.upsertFromCommit(
      { conversation_id: "telegram:42", platform: "telegram", kind: "group", title: "TG 群" },
      NOW,
    );
    expect(store.conversations.get("telegram:42")?.kind).toBe("group");
  });
});
