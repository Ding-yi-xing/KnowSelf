import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "../src/middleware/cors";
import { requestLogger } from "../src/middleware/logger";

describe("corsMiddleware", () => {
  function makeApp() {
    const app = new Hono();
    app.use("*", corsMiddleware);
    app.get("/test", (c) => c.text("ok"));
    return app;
  }

  it("OPTIONS 预检请求返回 204 + 含 Access-Control-Allow-Origin 头", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("非 OPTIONS 请求附加 Access-Control-Allow-Origin 头", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("Origin 不在白名单时 GET 不附 CORS 头", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "http://evil.com" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("Tauri webview origin 被放行 (tauri://localhost)", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "OPTIONS",
      headers: { Origin: "tauri://localhost" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("Tauri webview origin 被放行 (http://tauri.localhost)", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "http://tauri.localhost" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://tauri.localhost");
  });

  it("Tauri webview origin 被放行 (https://tauri.localhost)", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "https://tauri.localhost" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://tauri.localhost");
  });

  it("Tauri 子域被放行 (http://app.tauri.localhost)", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "http://app.tauri.localhost" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://app.tauri.localhost");
  });

  it("任意端口 localhost 被放行", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "http://localhost:9527" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:9527");
  });

  it("任意端口 127.0.0.1 被放行", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "http://127.0.0.1:9527" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:9527");
  });

  it("不命中的 OPTIONS 也返回 204(不写 ACAO,浏览器自行拒绝;不让落到路由层 404)", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("未知 origin GET 不写 CORS 头", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("无 Origin 头的请求直通(curl/同源调用)", async () => {
    const app = makeApp();
    const res = await app.request("/test", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("非法 Origin 字符串安全降级", async () => {
    const app = makeApp();
    const res = await app.request("/test", {
      method: "GET",
      headers: { Origin: "not-a-url" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("requestLogger", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {
      /* suppress */
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  function makeApp() {
    const app = new Hono();
    app.use("*", requestLogger);
    app.get("/test", (c) => c.text("ok"));
    app.get("/error", () => new Response("err", { status: 500 }));
    app.get("/notfound", () => new Response("nf", { status: 404 }));
    return app;
  }

  it("请求被记录（包含 method / path / status / trace）", async () => {
    const app = makeApp();
    await app.request("/test");
    expect(spy).toHaveBeenCalledTimes(1);
    const log = spy.mock.calls[0][0] as string;
    expect(log).toContain("GET");
    expect(log).toContain("/test");
    expect(log).toContain("200");
    expect(log).toContain("trace=");
  });

  it("日志含 traceId", async () => {
    const app = makeApp();
    await app.request("/test");
    const log = spy.mock.calls[0][0] as string;
    expect(log).toMatch(/trace=[0-9a-f-]{36}/);
  });

  it("5xx 状态码仍被记录", async () => {
    const app = makeApp();
    await app.request("/error");
    const log = spy.mock.calls[0][0] as string;
    expect(log).toContain("500");
  });

  it("4xx 状态码仍被记录", async () => {
    const app = makeApp();
    await app.request("/notfound");
    const log = spy.mock.calls[0][0] as string;
    expect(log).toContain("404");
  });
});
