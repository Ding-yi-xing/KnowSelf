/**
 * M3：`createRestProfilePort` 单测（`vi.stubGlobal('fetch')` 桩，不触网）。
 *
 * 核心断言是**错误语义三分**（05 §14 约束 4）：
 *   401 → `SessionExpiredError`（面板提示重开 dsh web）
 *   503 + 降级体 → `DegradedError`（携带 reason / layer，面板显示「数据层未就绪」+ 重试）
 *   其它非 2xx → 普通 `Error`（`GET <url> → <status>`，通用错误态）
 * 其余覆盖 URL 拼接（layer 参数、key/日期编码）与 200 原样透传。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRestProfilePort,
  DegradedError,
  SessionExpiredError,
} from "../src/client/profile-port.js";

/** 桩 fetch：返回可控的 { ok, status, json() }，记录调用参数（不依赖 jsdom 的 Response）。 */
function stubFetch(body: unknown = null, status = 200) {
  const fn = vi.fn(async (_input: string, _init?: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M3 profile port：URL 拼接与 200 透传", () => {
  it("getProfileCore → GET /knowself-api/profile/core，返回原样对象", async () => {
    const core = { display_name: "测试用户", locale: "zh-CN", section_tags: [], body: "正文" };
    const fetchStub = stubFetch(core);
    const port = createRestProfilePort();

    await expect(port.getProfileCore()).resolves.toEqual(core);
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/profile/core");
    expect(fetchStub.mock.calls[0]![1]).toEqual({ headers: { accept: "application/json" } });
  });

  it("listCards() 不带 layer → URL 无 '?'；listCards('L2') → ?layer=L2", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestProfilePort();

    await port.listCards();
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/cards");

    await port.listCards("L2");
    expect(fetchStub.mock.calls[1]![0]).toBe("/knowself-api/cards?layer=L2");
  });

  it("getCard 对 key 做路径编码；listJournalDates / getJournal 路径正确", async () => {
    const fetchStub = stubFetch({});
    const port = createRestProfilePort();

    await port.getCard("a/b");
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/cards/a%2Fb");

    await port.listJournalDates();
    expect(fetchStub.mock.calls[1]![0]).toBe("/knowself-api/journal");

    await port.getJournal("2026-05-30");
    expect(fetchStub.mock.calls[2]![0]).toBe("/knowself-api/journal/2026-05-30");
  });

  it("自定义 baseUrl 生效", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestProfilePort("/x-api");
    await port.listCards();
    expect(fetchStub.mock.calls[0]![0]).toBe("/x-api/cards");
  });

  it("画像 CRUD 一律走写通道，且核心保存不携带浏览器外的写入字段", async () => {
    const fetchStub = stubFetch({ ok: true });
    const port = createRestProfilePort();

    await port.saveProfileCore({ body: "手工维护", section_tags: ["偏好"] });
    await port.createCard({ key: "relationship", title: "关系", summary: "互动偏好", section_tags: [], sections: [{ title: "沟通", body: "及时回应" }] });
    await port.saveCard("relationship", { key: "ignored-by-server", title: "关系", summary: "已编辑", section_tags: [], sections: [{ title: "沟通", body: "及时回应" }] });
    await port.deleteCard("relationship");

    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/write/profile/core");
    expect(fetchStub.mock.calls[0]![1]).toMatchObject({ method: "PATCH", headers: { "x-knowself-write": "1" } });
    expect(JSON.parse((fetchStub.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ body: "手工维护", section_tags: ["偏好"] });
    expect(fetchStub.mock.calls[1]![0]).toBe("/knowself-api/write/cards");
    expect(fetchStub.mock.calls[1]![1]).toMatchObject({ method: "POST", headers: { "x-knowself-idempotency-key": expect.any(String) } });
    expect(fetchStub.mock.calls[2]![0]).toBe("/knowself-api/write/cards/relationship");
    expect(fetchStub.mock.calls[2]![1]).toMatchObject({ method: "PATCH" });
    expect(fetchStub.mock.calls[3]![0]).toBe("/knowself-api/write/cards/relationship");
    expect(fetchStub.mock.calls[3]![1]).toMatchObject({ method: "DELETE" });
  });
});

describe("M3 profile port：错误语义三分", () => {
  it("401 → SessionExpiredError（消息提示重开 dsh web）", async () => {
    stubFetch("dsh web authentication required", 401);
    const port = createRestProfilePort();

    await expect(port.getProfileCore()).rejects.toBeInstanceOf(SessionExpiredError);
    // 消息里必须带可执行的指引（面板直接展示）
    await expect(port.getProfileCore()).rejects.toThrow("会话已失效，请重新打开 dsh web");
  });

  it("503 + 降级体 → DegradedError（携带 reason 与 layer）", async () => {
    stubFetch({ status: "degraded", reason: "密钥未配置", layer: "core" }, 503);
    const port = createRestProfilePort();

    const err = await port.listCards().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect((err as DegradedError).reason).toBe("密钥未配置");
    expect((err as DegradedError).layer).toBe("core");
    expect((err as DegradedError).message).toBe("数据层未就绪：密钥未配置");
  });

  it("503 但响应体不是降级体 → 通用 Error（不误报「数据层未就绪」）", async () => {
    stubFetch({ nope: true }, 503);
    const port = createRestProfilePort();

    const err = await port.listJournalDates().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DegradedError);
    expect((err as Error).message).toBe("GET /knowself-api/journal → 503");
  });

  it("404（卡片不存在）→ 通用 Error，含完整 URL 与状态码", async () => {
    stubFetch({ error: "not_found" }, 404);
    const port = createRestProfilePort();

    await expect(port.getCard("nope")).rejects.toThrow(
      "GET /knowself-api/cards/nope → 404",
    );
  });

  it("500 → 通用 Error（与降级态区分）", async () => {
    stubFetch({ error: "boom" }, 500);
    const port = createRestProfilePort();

    const err = await port.getJournal("2026-05-30").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DegradedError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
  });
});
