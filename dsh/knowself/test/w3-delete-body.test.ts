/**
 * 批次 1 缺陷 1：**DELETE 允许没有 body / 没有 Content-Type**。
 *
 * 起因：主理人在真实数据上验 `DELETE /write/person/:id` 时只带了 `x-knowself-write`，
 * 回 415。他判断这是 "API 形状问题，不是调用姿势问题" —— 对：delete 语义上可以没有载荷，
 * curl / fetch / 各种 SDK 默认都不会给 DELETE 加 JSON 头。
 *
 * 本文件把三种情形钉死：
 *   A. DELETE 无 Content-Type、无 body → **放行**（进 dispatch）
 *   B. DELETE 显式给非 JSON 的 Content-Type（如表单 text/plain）→ 仍 415（防跨站表单）
 *   C. POST 无 Content-Type → 仍 415（既有一致性，不能因为本次放宽而回退）
 */
import { describe, expect, it, vi } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { createWriteHandler } from "../src/write-bridge.js";

/** 构造最小 handler 型请求；`omitContentType` 时不带 content-type 头。 */
function makeReq(options: { method: string; path: string; contentType?: string; body?: string }) {
  const headers: Record<string, string> = { "x-knowself-write": "1" };
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  const text = options.body ?? "";
  const chunks = text === "" ? [] : [new TextEncoder().encode(text)];
  return {
    method: options.method,
    url: `/knowself-api/write${options.path}`,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** 捕获响应。 */
function makeRes() {
  const state: { status?: number; body?: string } = {};
  return {
    state,
    writeHead(status: number) {
      state.status = status;
    },
    end(body?: string) {
      state.body = body;
    },
  };
}

/**
 * 跑一次写桥。
 * @param req 请求桩
 */
async function run(req: ReturnType<typeof makeReq>) {
  const deps = {
    // 空 services：守卫通过后会进 dispatch，未知路径 → 404（足以证明"没被 415 拦下"）
    services: {} as unknown as KnowselfServices,
    requestRejection: vi.fn(() => undefined),
    log: { error: vi.fn() },
  };
  const res = makeRes();
  await createWriteHandler(deps)(req, res);
  return { status: res.state.status, body: res.state.body };
}

describe("批次 1 缺陷 1 · DELETE 的 body/Content-Type", () => {
  it("A. 只有 x-knowself-write、无 Content-Type、无 body → 放行（不再 415）", async () => {
    const { status } = await run(makeReq({ method: "DELETE", path: "/person/abc" }));
    expect(status).not.toBe(415);
    // 进到了 dispatch：未知人物路径在空 services 下走 503/404，总之不是守卫层的错误码
    expect([200, 400, 404, 503]).toContain(status);
  });

  it("B. DELETE 带 text/plain（表单可伪造的类型）→ 仍 415", async () => {
    const { status } = await run(
      makeReq({ method: "DELETE", path: "/person/abc", contentType: "text/plain", body: "x" }),
    );
    expect(status).toBe(415);
  });

  it("C. POST 无 Content-Type → 仍 415（既有行为不回退）", async () => {
    const { status } = await run(makeReq({ method: "POST", path: "/persons", body: '{"display_name":"x"}' }));
    expect(status).toBe(415);
  });

  it("D. DELETE 显式带 application/json + {} → 也放行（老调用姿势继续可用）", async () => {
    const { status } = await run(
      makeReq({ method: "DELETE", path: "/person/abc", contentType: "application/json", body: "{}" }),
    );
    expect(status).not.toBe(415);
  });
});
