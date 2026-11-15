/**
 * B2 client 侧单测：`createRestDataPort`（`vi.stubGlobal('fetch')` 桩，不触网）。
 *
 * 覆盖：三方法 URL 拼接 / 路径编码 / 200 + null / 非 2xx 抛错 / 自定义 baseUrl /
 * accept: application/json 同 origin 相对路径。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRestDataPort,
  PersonLayerDegradedError,
} from "../src/client/rest-data-port.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 桩 fetch：返回可控的 { ok, status, json() }，记录调用参数（不依赖 jsdom 的 Response）。 */
function stubFetch(body: unknown = [], status = 200) {
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

describe("B2 client 侧：createRestDataPort", () => {
  it("listPersons({limit:2}) → fetch('/knowself-api/persons?limit=2')，返回 PersonRow[] 且带 accept header", async () => {
    const row = { person_id: "p1", display_name: "张三" };
    const fetchStub = stubFetch([row]);
    const port = createRestDataPort();

    await expect(port.listPersons({ limit: 2 })).resolves.toEqual([row]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe("/knowself-api/persons?limit=2");
    expect(init).toEqual({ headers: { accept: "application/json" } });
  });

  it("listPersons() 无 query → URL 不带 '?'", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestDataPort();
    await port.listPersons();
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/persons");
  });

  it("getPerson('a/b') → 路径编码 a%2Fb，且 200 + null 原样返回", async () => {
    const fetchStub = stubFetch(null);
    const port = createRestDataPort();
    await expect(port.getPerson("a/b")).resolves.toBeNull();
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/person/a%2Fb");
  });

  it("getPerson('p1') → 200 + PersonRow 原样透传", async () => {
    const row = { person_id: "p1", display_name: "张三" };
    stubFetch(row);
    const port = createRestDataPort();
    await expect(port.getPerson("p1")).resolves.toEqual(row);
  });

  it("timeline('p1', query) → 拼接全部 query 字段", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestDataPort();
    await port.timeline("p1", {
      from_date: "2026-01-01",
      to_date: "2026-02-01",
      min_importance: 2,
      limit: 5,
      offset: 1,
    });
    const url = fetchStub.mock.calls[0]![0];
    expect(url.startsWith("/knowself-api/person/p1/timeline?")).toBe(true);
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("from_date")).toBe("2026-01-01");
    expect(params.get("to_date")).toBe("2026-02-01");
    expect(params.get("min_importance")).toBe("2");
    expect(params.get("limit")).toBe("5");
    expect(params.get("offset")).toBe("1");
  });

  it("非 2xx（500）→ 三个方法均抛错", async () => {
    stubFetch({ error: "boom" }, 500);
    const port = createRestDataPort();
    await expect(port.listPersons()).rejects.toThrow("GET /knowself-api/persons → 500");
    await expect(port.getPerson("p1")).rejects.toThrow("→ 500");
    await expect(port.timeline("p1")).rejects.toThrow("→ 500");
  });

  it("自定义 baseUrl 生效（仍为相对路径，可切到宿主注入的 origin 前缀）", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestDataPort("/custom/api");
    await port.listPersons({ limit: 3 });
    expect(fetchStub.mock.calls[0]![0]).toBe("/custom/api/persons?limit=3");
  });
});

// ── §13.4：503 人物层降级专用错误（其它非 2xx 通用错误态零回退） ────────────
describe("§13.4 client 侧：503 人物层降级", () => {
  it("503 + {status:'degraded',reason,layer:'person'} → 三个方法均抛 PersonLayerDegradedError 且携带 reason", async () => {
    stubFetch(
      { status: "degraded", reason: "密钥未配置", layer: "person" },
      503,
    );
    const port = createRestDataPort();
    for (const call of [
      () => port.listPersons(),
      () => port.getPerson("p1"),
      () => port.timeline("p1"),
    ]) {
      try {
        await call();
        throw new Error("应当抛出 PersonLayerDegradedError");
      } catch (err) {
        expect(err).toBeInstanceOf(PersonLayerDegradedError);
        const degraded = err as PersonLayerDegradedError;
        expect(degraded.status).toBe("degraded");
        expect(degraded.layer).toBe("person");
        expect(degraded.reason).toBe("密钥未配置");
        expect(degraded.message).toContain("数据层未就绪");
      }
    }
  });

  it("503 但响应体不符合降级约定 → 保持既有通用错误 GET <url> → 503", async () => {
    stubFetch({ error: "service unavailable" }, 503);
    const port = createRestDataPort();
    await expect(port.listPersons()).rejects.toThrow(
      "GET /knowself-api/persons → 503",
    );
    await expect(port.listPersons()).rejects.not.toBeInstanceOf(
      PersonLayerDegradedError,
    );
  });

  it("404 / 500 仍走既有通用错误态（零回退）", async () => {
    stubFetch({ error: "not_found" }, 404);
    const port = createRestDataPort();
    await expect(port.getPerson("p1")).rejects.toThrow(
      "GET /knowself-api/person/p1 → 404",
    );
    stubFetch({ error: "boom" }, 500);
    await expect(port.timeline("p1")).rejects.toThrow(
      "GET /knowself-api/person/p1/timeline → 500",
    );
  });
});
