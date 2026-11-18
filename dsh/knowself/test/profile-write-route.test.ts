import { describe, expect, it, vi } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { dispatch } from "../src/routes/index.js";

const CARD = { key: "relationship", title: "关系", summary: "互动偏好", section_tags: [], updated_at: "2026-11-16T00:00:00.000Z" };
const CORE = { display_name: "测试用户", locale: "zh-CN", section_tags: [], body: "原始正文", updated_at: "2026-11-16T00:00:00.000Z", schema_version: 1 };

function services() {
  const write = vi.fn();
  const del = vi.fn();
  const profileStore = {
    core: { get: vi.fn(() => CORE) },
    cards: { list: vi.fn(() => [CARD]), get: vi.fn((key: string) => ({ card: { ...CARD, key }, sections: [] })), delete: del },
    write,
  };
  return { services: { profileStore } as unknown as KnowselfServices, write, del };
}

describe("profile write routes", () => {
  it("以 user 来源保存核心画像", async () => {
    const { services: app, write } = services();
    const result = await dispatch(new URL("http://dsh/knowself-api/write/profile/core"), app, "PATCH", { body: "手工正文", section_tags: ["偏好"] });
    expect(result).toMatchObject({ status: 200, body: CORE });
    expect(write).toHaveBeenCalledWith({ target: "core", provenance: "user", body: "手工正文", section_tags: ["偏好"] }, { callerKind: "ui" });
  });

  it("创建和更新卡片时服务端路径 key 覆盖浏览器 body key", async () => {
    const { services: app, write } = services();
    const input = { key: "relationship", title: "关系", summary: "互动偏好", section_tags: [], sections: [{ title: "沟通", body: "及时回应" }] };
    const created = await dispatch(new URL("http://dsh/knowself-api/write/cards"), app, "POST", input);
    expect(created.status).toBe(201);
    expect(write).toHaveBeenLastCalledWith({ target: "card", provenance: "user", ...input }, { callerKind: "ui" });

    const updated = await dispatch(new URL("http://dsh/knowself-api/write/cards/relationship"), app, "PATCH", { ...input, key: "browser-forged-key" });
    expect(updated.status).toBe(200);
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ target: "card", provenance: "user", key: "relationship" }), { callerKind: "ui" });
  });

  it("删除存在的卡片，缺失卡片返回 404", async () => {
    const { services: app, del } = services();
    await expect(dispatch(new URL("http://dsh/knowself-api/write/cards/relationship"), app, "DELETE")).resolves.toEqual({ status: 200, body: { key: "relationship", deleted: true } });
    expect(del).toHaveBeenCalledWith("relationship");

    const { services: empty } = services();
    (empty.profileStore as unknown as { cards: { list: () => unknown[] } }).cards.list = () => [];
    await expect(dispatch(new URL("http://dsh/knowself-api/write/cards/missing"), empty, "DELETE")).resolves.toEqual({ status: 404, body: { error: "not_found" } });
  });
});
