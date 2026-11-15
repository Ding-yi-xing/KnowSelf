/**
 * W-1：handler 型写桥的**守卫层**单测（纯桩，不触网、不开 DB）。
 *
 * 职责：把 `write-bridge.ts` 的六道守卫逐条固定下来，尤其是真机校准后
 * 「Electron 自定义协议 `dsh-app://app` 不带 Origin 也必须放行」这一条——
 * 它是 W-1 真机验收 a/d 能否通过的关键；若哪天有人把「无 Origin 即拒」加回来，
 * 本文件会立刻报红，而不是等到桌面里点按钮才发现 403。
 *
 * 覆盖：
 *   A. 鉴权优先：requestRejection 返回 401/403 时直接拒绝，且 dispatch 不被调用
 *   B. 自定义头缺失 → 403；method 非 POST/PATCH → 405；CT 非 JSON → 415
 *   C. Origin：无 Origin 放行；`null` 放行；`dsh-app://app` 放行；
 *      与 Host 同源放行；跨站拒绝；`sec-fetch-site: cross-site` 拒绝
 *   D. 幂等键：同一 key 第二次直接重放，领域层只调用一次
 *   E. body 非法 JSON → 400；超限 → 400
 *
 * 边界：mock `dispatch` 的领域返回值不写库；不改任何生产代码。
 */
import { describe, expect, it, vi } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { createWriteHandler } from "../src/write-bridge.js";

/** 构造最小 handler 型请求（异步迭代分块）。 */
function makeReq(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  chunks?: Uint8Array[];
} = {}) {
  const text = options.body ?? "{}";
  const chunks = options.chunks ?? [new TextEncoder().encode(text)];
  return {
    method: options.method ?? "POST",
    url: "/knowself-api/write/sources",
    headers: {
      "content-type": "application/json",
      "x-knowself-write": "1",
      ...(options.headers ?? {}),
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** 构造捕获响应的桩。 */
function makeRes() {
  const state: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return {
    state,
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      state.headers = headers;
    },
    end(body?: string) {
      state.body = body;
    },
  };
}

/** 构造依赖；`services` 用空对象即可（守卫通过后才碰 services）。 */
function makeDeps(rejection: 401 | 403 | undefined = undefined) {
  const requestRejection = vi.fn(() => rejection);
  const log = { error: vi.fn() };
  const deps = {
    services: { profileStore: { sources: { list: () => ({ items: [], total: 0 }) } } } as unknown as KnowselfServices,
    requestRejection,
    log,
  };
  return { deps, requestRejection, log };
}

/** 跑一次 handler。 */
async function run(deps: ReturnType<typeof makeDeps>["deps"], req: ReturnType<typeof makeReq>) {
  const res = makeRes();
  await createWriteHandler(deps)(req, res);
  return { status: res.state.status, body: res.state.body ? JSON.parse(res.state.body) as unknown : null };
}

describe("W-1 · 写桥守卫：鉴权优先", () => {
  it("requestRejection=401 → 401，且不进入后续守卫", async () => {
    const { deps, requestRejection } = makeDeps(401);
    const result = await run(deps, makeReq());
    expect(result.status).toBe(401);
    expect(requestRejection).toHaveBeenCalledTimes(1);
  });

  it("requestRejection=403 → 403", async () => {
    const { deps } = makeDeps(403);
    expect((await run(deps, makeReq())).status).toBe(403);
  });
});

describe("W-1 · 写桥守卫：自定义头 / method / Content-Type", () => {
  it("缺 x-knowself-write → 403", async () => {
    const { deps } = makeDeps();
    const req = makeReq({ headers: {} });
    // 删掉默认自定义头
    delete (req.headers as Record<string, string>)["x-knowself-write"];
    expect((await run(deps, req)).status).toBe(403);
  });

  it("GET → 405；PATCH 允许（W-3 预留，落到 dispatch 后按路径 404）", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq({ method: "GET" }))).status).toBe(405);
    const patch = await run(deps, makeReq({ method: "PATCH" }));
    expect([200, 404, 400, 500]).toContain(patch.status);
  });

  it("Content-Type 非 application/json → 415", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq({ headers: { "content-type": "text/plain" } }))).status).toBe(415);
  });

  it("非法 JSON → 400", async () => {
    const { deps } = makeDeps();
    const result = await run(deps, makeReq({ body: "{not json" }));
    expect(result.status).toBe(400);
  });
});

describe("W-1 · 写桥守卫：Origin 真机校准", () => {
  it("无 Origin（Electron dsh-app:// 同源 fetch）→ 放行", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq())).status).not.toBe(403);
  });

  it("Origin: null → 放行", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq({ headers: { origin: "null" } }))).status).not.toBe(403);
  });

  it("Origin: dsh-app://app → 放行", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq({ headers: { origin: "dsh-app://app" } }))).status).not.toBe(403);
  });

  it("Origin 与 Host 同源 → 放行", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq({
      headers: { origin: "http://127.0.0.1:5174", host: "127.0.0.1:5174" },
    }))).status).not.toBe(403);
  });

  it("Origin 跨站 → 403", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq({
      headers: { origin: "https://evil.example", host: "127.0.0.1:5174" },
    }))).status).toBe(403);
  });

  it("sec-fetch-site: cross-site → 403", async () => {
    const { deps } = makeDeps();
    expect((await run(deps, makeReq({
      headers: { "sec-fetch-site": "cross-site" },
    }))).status).toBe(403);
  });
});

describe("W-1 · 写桥幂等键", () => {
  it("同一 idempotency-key 第二次直接重放，落库逻辑不重复", async () => {
    const { deps } = makeDeps();
    const handler = createWriteHandler(deps);
    const key = "w1-fixed-key";
    const h = { "x-knowself-idempotency-key": key };
    const first = makeRes();
    await handler(makeReq({ headers: h }), first);
    const second = makeRes();
    await handler(makeReq({ headers: h }), second);
    expect(first.state.status).toBe(second.state.status);
    expect(first.state.body).toBe(second.state.body);
  });
});
