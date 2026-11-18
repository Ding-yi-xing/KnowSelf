import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createWechatAssistRepo } from "../src/repository/wechat-assist";

let db: ProfileDb;

beforeEach(() => {
  db = openProfileDb(":memory:");
});

afterEach(() => {
  db.raw.close();
});

describe("reply corrections", () => {
  it("stores corrections per contact and reads them back", () => {
    const repo = createWechatAssistRepo(db);
    repo.appendReplyCorrection("wxid_a", { wrong: "太正式", right: "我一般说「行吧」" });
    repo.appendReplyCorrection("wxid_b", { wrong: "爱用啊", right: "我从不用啊" });
    repo.appendReplyCorrection("wxid_a", { layer: "Layer 1", wrong: "每条三句", right: "我一次只发一句" });

    expect(repo.listReplyCorrections("wxid_a").map((item) => item.wrong)).toEqual(["太正式", "每条三句"]);
    expect(repo.listReplyCorrections("wxid_a")[1]?.layer).toBe("Layer 1");
    expect(repo.listReplyCorrections("wxid_b")).toHaveLength(1);
    expect(repo.listReplyCorrections("wxid_missing")).toEqual([]);
  });

  it("keeps only the latest 20 corrections so the prompt cannot grow forever", () => {
    const repo = createWechatAssistRepo(db);
    for (let index = 0; index < 25; index += 1) {
      repo.appendReplyCorrection("wxid_a", { wrong: `旧${index}`, right: `新${index}` });
    }
    const all = repo.listReplyCorrections("wxid_a");
    expect(all).toHaveLength(20);
    expect(all[0]?.wrong).toBe("旧5");
    expect(all[19]?.wrong).toBe("旧24");
  });
});
