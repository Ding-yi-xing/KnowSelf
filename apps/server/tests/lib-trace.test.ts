import { describe, it, expect } from "vitest";
import { newTraceId, getTraceId } from "../src/lib/trace";
import { Hono } from "hono";

describe("newTraceId", () => {
  it("返回符合 UUID v4 格式的字符串", () => {
    const id = newTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("两次 newTraceId 返回不同值", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
  });
});

describe("getTraceId", () => {
  it("在 Hono context 未设置时返回 'unknown'", async () => {
    const app = new Hono();
    app.get("/test", (c) => {
      const id = getTraceId(c);
      return c.json({ traceId: id });
    });
    const res = await app.request("/test");
    const body = (await res.json()) as { traceId: string };
    expect(body.traceId).toBe("unknown");
  });
});
