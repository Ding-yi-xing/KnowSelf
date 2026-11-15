/**
 * QA 独立回归补测（Task #2 / 严过关）—— B2 数据桥接的「错误路径 / 边界 / 契约自洽」。
 *
 * 与工程师交付的 `test/web-bridge.test.ts` / `test/rest-data-port.test.ts` **完全独立编写**
 * （不 import 其夹具、不复用其断言），目的是「独立证明」而不是重跑 happy path。
 * 只新增测试代码，不改任何源码 / 配置 / 文档。
 *
 * W2/T04 夹具适配：生产代码改为 `ctx.inject(["webServer", "connection"], cb)` 子 fiber，本文件桩 ctx
 * 独立补 `inject`（不复用工程师夹具）。语义等价迁移：旧「形状不符 → no-op + warn」
 * 在新设计下不可达，改为断言「依赖未就绪 → cb 不执行、未注册路由、不抛错、无 warn」；
 * 所有 400/404/500/200+null/编码/零写操作等既有断言**逐条保留、未弱化**。
 *
 * 覆盖：
 *   A. 400 参数校验矩阵（含 Number('') / Number(' ') 边界、非法枚举、非法百分号编码）
 *   B. 合法枚举字面量 / 数值边界放行并断言透传实参
 *   C. 非法 id 编码 → 400（不是 500、不触端口）
 *   D. 前缀边界 + 非 GET 方法 → 404，且数据端口绝不误触
 *   E. 统一 content-type / 404 / 500（三端点抛错）/ 200+null / disposer / 三级降级
 *   F. client encodeURIComponent ↔ 服务端 decodeURIComponent 闭环
 *   G. client REST 端口：URL 顺序与编码、undefined/null 跳过、非 2xx 完整 URL、
 *      accept 头、零写操作（无 method/body）、baseUrl 覆盖
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { PersonListQuery, PersonRow } from "@knowself/person-store";
import type { KnowselfServices } from "../src/services.js";
import { registerKnowselfWebBridge } from "../src/web-bridge.js";
import { createRestDataPort } from "../src/client/rest-data-port.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Node 侧夹具（独立实现，不依赖工程师的 makeHarness） ─────────────────────

interface CapturedRoute {
  kind: string;
  path: string;
  resource: (request: Request) => Promise<Response>;
}

const ROW = { person_id: "p1", display_name: "张三" } as unknown as PersonRow;
const EVENT = { event_id: "e1", title: "事件" };

interface BridgeOpts {
  noWebServer?: boolean;
  /** F3：不提供 `connection` 服务（桥应 fail-closed 不注册）。 */
  noConnection?: boolean;
  registerNotFunction?: boolean;
  loggerBroken?: boolean;
  throwOn?: "list" | "get" | "timeline";
}

function makeBridge(opts: BridgeOpts = {}) {
  const listSpy = vi.fn((): PersonRow[] => {
    if (opts.throwOn === "list") throw new Error("boom-list");
    return [ROW];
  });
  const getSpy = vi.fn((_id: string): PersonRow | null => {
    if (opts.throwOn === "get") throw new Error("boom-get");
    return null;
  });
  const timelineSpy = vi.fn((_id: string, _q?: unknown) => {
    if (opts.throwOn === "timeline") throw new Error("boom-timeline");
    return [EVENT];
  });

  const store = {
    listPersons: listSpy,
    getPerson: getSpy,
    events: { timeline: timelineSpy },
  } as unknown as KnowselfServices["personStore"];
  const services = { personStore: store } as unknown as KnowselfServices;

  const routes: CapturedRoute[] = [];
  let disposed = 0;
  let cbCalls = 0;
  let warnings = 0;
  const effectDisposers: Array<() => void> = [];
  const ctxObj: Record<string, unknown> = {};
  const webServerReady = !opts.noWebServer && !opts.registerNotFunction;
  const connectionReady = !opts.noConnection;
  if (!opts.noWebServer) {
    ctxObj.webServer = {
      register: opts.registerNotFunction
        ? 123
        : (route: CapturedRoute): (() => void) => {
            routes.push(route);
            return () => {
              disposed += 1;
            };
          },
    };
  }
  // F3：dsh `connection` 鉴权入口（本文件为「已认证」上下文 → 放行）。
  if (connectionReady) {
    ctxObj.connection = { requestRejection: (_request: Request) => undefined };
  }
  // logger 形状不符（"not-a-function"）在新设计下不再触发 getLogger 静默降级；
  // 保留该输入以验证「依赖未就绪时 cb 不执行、logger 根本不会被调用」。
  ctxObj.logger = opts.loggerBroken
    ? "not-a-function"
    : () => ({
        warn: () => {
          warnings += 1;
        },
        error: () => {},
        info: () => {},
      });

  // W2/T04：独立桩 inject，复刻真实 cordis「全有或全无」语义（F3 起依赖含 connection）。
  ctxObj.inject = (deps: string[], cb: (sub: unknown) => void) => {
    if (
      !webServerReady ||
      !connectionReady ||
      !deps.includes("webServer") ||
      !deps.includes("connection")
    ) {
      return { dispose: async () => {} };
    }
    cbCalls += 1;
    const sub = {
      webServer: ctxObj.webServer,
      connection: ctxObj.connection,
      effect: (fn: () => unknown) => {
        const result = fn();
        if (typeof result === "function") {
          effectDisposers.push(result as () => void);
        }
        return result;
      },
      logger: () => ({
        warn: () => {
          warnings += 1;
        },
        error: () => {},
        info: () => {},
      }),
    };
    cb(sub);
    return {
      dispose: async () => {
        // 不清空：保证多次 dispose 都能触发 register 提供的回收函数。
        for (const disposer of [...effectDisposers].reverse()) disposer();
      },
    };
  };

  const ctx = ctxObj as unknown as Context;
  const dispose = registerKnowselfWebBridge(ctx, services);

  return {
    ctx,
    routes,
    dispose,
    disposeCalls: () => disposed,
    listSpy,
    getSpy,
    timelineSpy,
    cbCalls: () => cbCalls,
    warnCalls: () => warnings,
    resource: (r: Request): Promise<Response> => routes[0]!.resource(r),
  };
}

const GET = (path: string): Request => new Request(`http://x${path}`);

async function expectErrorJson(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { error: string };
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(0);
  return body.error;
}

// ── A. 400 参数校验矩阵 ────────────────────────────────────────────────────

describe("QA-B2-A：400 参数校验矩阵（独立补测）", () => {
  const badCases: Array<[string, string]> = [
    ["limit=abc（非数字）", "/knowself-api/persons?limit=abc"],
    ["limit=-1（负数）", "/knowself-api/persons?limit=-1"],
    ["limit=1.5（小数）", "/knowself-api/persons?limit=1.5"],
    ["limit=（空串，Number('')===0 必须被 trim 拦截）", "/knowself-api/persons?limit="],
    ["limit=%20（空白，Number(' ')===0 必须被 trim 拦截）", "/knowself-api/persons?limit=%20"],
    ["limit=Infinity（非有限）", "/knowself-api/persons?limit=Infinity"],
    ["limit=NaN（非有限）", "/knowself-api/persons?limit=NaN"],
    ["offset=abc", "/knowself-api/persons?offset=abc"],
    ["offset=-1", "/knowself-api/persons?offset=-1"],
    ["offset=1.5", "/knowself-api/persons?offset=1.5"],
    ["offset=（空串）", "/knowself-api/persons?offset="],
    ["subject_kind=unknown（非法字面量）", "/knowself-api/persons?subject_kind=unknown"],
    ["status=unknown（非法字面量）", "/knowself-api/persons?status=unknown"],
    ["min_importance=abc", "/knowself-api/person/p1/timeline?min_importance=abc"],
    ["min_importance=-1", "/knowself-api/person/p1/timeline?min_importance=-1"],
    ["min_importance=1.5", "/knowself-api/person/p1/timeline?min_importance=1.5"],
    ["min_importance=（空串）", "/knowself-api/person/p1/timeline?min_importance="],
  ];

  it.each(badCases)("%s → 400 + {error}，且不触数据端口", async (_label: string, path: string) => {
    const b = makeBridge();
    const res = await b.resource(GET(path));
    await expectErrorJson(res, 400);
    expect(b.listSpy).not.toHaveBeenCalled();
    expect(b.timelineSpy).not.toHaveBeenCalled();
  });

  it("非法百分号编码 id（%E0%A4%A / %zz / %C0）→ 400（不得 500、不得崩溃、不触端口）", async () => {
    const b = makeBridge();
    for (const raw of ["%E0%A4%A", "%zz", "%C0"]) {
      const res = await b.resource(GET(`/knowself-api/person/${raw}`));
      const msg = await expectErrorJson(res, 400);
      expect(msg).toContain("编码非法");
    }
    expect(b.getSpy).not.toHaveBeenCalled();
  });
});

// ── B. 合法值放行并断言透传实参 ────────────────────────────────────────────

describe("QA-B2-B：合法枚举 / 数值边界（用 vi.fn 断言实参）", () => {
  it("subject_kind 的全部真实字面量（self / contact）放行且原样透传", async () => {
    // 领域库 packages/person-store/src/types.ts:10 → SubjectKind = "self" | "contact"
    const b = makeBridge();
    for (const sk of ["self", "contact"]) {
      const res = await b.resource(GET(`/knowself-api/persons?subject_kind=${sk}`));
      expect(res.status, sk).toBe(200);
      expect(b.listSpy).toHaveBeenLastCalledWith({ subject_kind: sk });
    }
  });

  it("status 的全部真实字面量（active / archived / merged）放行且原样透传", async () => {
    // 领域库 packages/person-store/src/types.ts:11 → PersonStatus = "active" | "archived" | "merged"
    const b = makeBridge();
    for (const st of ["active", "archived", "merged"]) {
      const res = await b.resource(GET(`/knowself-api/persons?status=${st}`));
      expect(res.status, st).toBe(200);
      expect(b.listSpy).toHaveBeenLastCalledWith({ status: st });
    }
  });

  it("五字段 query 完整透传（listPersons + timeline 各断言实参）", async () => {
    const b = makeBridge();
    const r1 = await b.resource(
      GET("/knowself-api/persons?subject_kind=contact&status=active&keyword=zhang&limit=2&offset=1"),
    );
    expect(r1.status).toBe(200);
    expect(b.listSpy).toHaveBeenCalledWith({
      subject_kind: "contact",
      status: "active",
      keyword: "zhang",
      limit: 2,
      offset: 1,
    });
    const r2 = await b.resource(
      GET("/knowself-api/person/p1/timeline?from_date=2026-01-01&to_date=2026-02-01&min_importance=2&limit=10&offset=3"),
    );
    expect(r2.status).toBe(200);
    expect(b.timelineSpy).toHaveBeenCalledWith("p1", {
      from_date: "2026-01-01",
      to_date: "2026-02-01",
      min_importance: 2,
      limit: 10,
      offset: 3,
    });
  });

  it("limit=0 / keyword=（空串）→ 200 且原样透传（0 与空串不是非法值）", async () => {
    const b = makeBridge();
    expect((await b.resource(GET("/knowself-api/persons?limit=0"))).status).toBe(200);
    expect(b.listSpy).toHaveBeenLastCalledWith({ limit: 0 });
    expect((await b.resource(GET("/knowself-api/persons?keyword="))).status).toBe(200);
    expect(b.listSpy).toHaveBeenLastCalledWith({ keyword: "" });
  });
});

// ── C/D. 前缀边界、非 GET 方法、契约自洽 ───────────────────────────────────

describe("QA-B2-C：前缀边界与非 GET 方法（不得误返回 200 数据）", () => {
  const boundaryPaths = [
    "/knowself-api", // 前缀自身：slice 得 ''
    "/knowself-apiXYZ", // 真实 prefix 规则下不应命中；slice 得 'XYZ'
    "/knowself-api/persons/", // 尾斜杠
    "/knowself-api/personsXYZ",
    "/knowself-api/person/", // 空 id
    "/knowself-api/person/p1/timeline/extra",
    "/knowself-api/unknown",
  ];

  it.each(boundaryPaths)("GET %s → 404 + {error}，且三端口均未调用", async (path: string) => {
    const b = makeBridge();
    const res = await b.resource(GET(path));
    await expectErrorJson(res, 404);
    expect(b.listSpy).not.toHaveBeenCalled();
    expect(b.getSpy).not.toHaveBeenCalled();
    expect(b.timelineSpy).not.toHaveBeenCalled();
  });

  it("非 GET（POST/PUT/DELETE/PATCH/HEAD）→ 404；即使带非法 query 也不误触参数校验", async () => {
    const b = makeBridge();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const res = await b.resource(
        new Request("http://x/knowself-api/persons?limit=abc", { method }),
      );
      await expectErrorJson(res, 404);
    }
    // GET 路径与 timeline 路径同样拒绝非 GET
    for (const method of ["POST", "HEAD"]) {
      const r2 = await b.resource(
        new Request("http://x/knowself-api/person/p1/timeline", { method }),
      );
      const r3 = await b.resource(
        new Request("http://x/knowself-api/person/p1", { method }),
      );
      await expectErrorJson(r2, 404);
      await expectErrorJson(r3, 404);
    }
    expect(b.listSpy).not.toHaveBeenCalled();
    expect(b.getSpy).not.toHaveBeenCalled();
    expect(b.timelineSpy).not.toHaveBeenCalled();
  });
});

// ── E. 响应语义与降级 ─────────────────────────────────────────────────────

describe("QA-B2-D：统一响应语义 / 500 / disposer / 降级", () => {
  it("200 / 400 / 404 / 500 四类响应都带 content-type: application/json", async () => {
    const okB = makeBridge();
    const okRes = await okB.resource(GET("/knowself-api/persons"));
    const badRes = await okB.resource(GET("/knowself-api/persons?limit=abc"));
    const nfRes = await okB.resource(GET("/knowself-api/nope"));
    const errB = makeBridge({ throwOn: "list" });
    const errRes = await errB.resource(GET("/knowself-api/persons"));
    for (const r of [okRes, badRes, nfRes, errRes]) {
      expect(r.headers.get("content-type")).toContain("application/json");
    }
    expect([okRes.status, badRes.status, nfRes.status, errRes.status]).toEqual([
      200, 400, 404, 500,
    ]);
  });

  it("三端点各自抛错 → 500 + {error: 'boom-*'}（不只是 listPersons）", async () => {
    for (const t of ["list", "get", "timeline"] as const) {
      const b = makeBridge({ throwOn: t });
      const path =
        t === "list" ? "/persons" : t === "get" ? "/person/p1" : "/person/p1/timeline";
      const res = await b.resource(GET(`/knowself-api${path}`));
      const msg = await expectErrorJson(res, 500);
      expect(msg, t).toContain(`boom-${t}`);
    }
  });

  it("GET /person/:id 未找到 → 200 + null（client 对齐）", async () => {
    const b = makeBridge();
    const res = await b.resource(GET("/knowself-api/person/missing"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toBeNull();
    expect(b.getSpy).toHaveBeenCalledWith("missing");
  });

  it("route.kind='prefix' / path='/knowself-api'，disposer 可回收且只触发一次", () => {
    const b = makeBridge();
    expect(b.routes).toHaveLength(1);
    expect(b.routes[0]!.kind).toBe("prefix");
    expect(b.routes[0]!.path).toBe("/knowself-api");
    expect(typeof b.routes[0]!.resource).toBe("function");
    expect(b.disposeCalls()).toBe(0);
    b.dispose();
    expect(b.disposeCalls()).toBe(1);
    b.dispose();
    expect(b.disposeCalls()).toBe(2);
  });

  it("依赖未就绪（webServer 缺席 / register 非函数 / connection 缺席 / logger 形状不符）→ cb 不执行、不抛、no-op disposer、无 warn", () => {
    for (const opts of [
      { noWebServer: true },
      { registerNotFunction: true },
      { noWebServer: true, loggerBroken: true },
      { noConnection: true },
    ]) {
      const b = makeBridge(opts);
      expect(b.routes).toHaveLength(0);
      expect(() => b.dispose()).not.toThrow();
      expect(b.disposeCalls()).toBe(0);
      expect(b.cbCalls()).toBe(0);
      expect(b.warnCalls()).toBe(0);
    }
  });

  it("真实 cordis Context（未 inject webServer）→ inject 全有或全无：cb 不执行、不抛、no-op disposer", async () => {
    const root = new Context();
    root.provide("tools", { register: () => () => {} });
    const store = {
      listPersons: () => [],
      getPerson: () => null,
      events: { timeline: () => [] },
    } as unknown as KnowselfServices["personStore"];
    const services = { personStore: store } as unknown as KnowselfServices;
    let dispose: () => void = () => {};
    expect(() => {
      dispose = registerKnowselfWebBridge(root, services);
    }).not.toThrow();
    expect(() => dispose()).not.toThrow();

    // 真实 cordis：依赖未就绪时 inject 回调永不执行（生产降级所依赖的前提）。
    let cordisCbCalled = false;
    const fiber = root.inject(["webServer"], () => {
      cordisCbCalled = true;
    });
    expect(cordisCbCalled).toBe(false);
    await fiber.dispose();
    expect(cordisCbCalled).toBe(false);
  });
});

// ── F. 编解码闭环 ─────────────────────────────────────────────────────────

describe("QA-B2-E：client ↔ server 路径编解码闭环", () => {
  it("/person/a%2Fb → getPerson('a/b')；/person/a%25b → getPerson('a%b')", async () => {
    const b = makeBridge();
    expect((await b.resource(GET("/knowself-api/person/a%2Fb"))).status).toBe(200);
    expect(b.getSpy).toHaveBeenLastCalledWith("a/b");
    expect((await b.resource(GET("/knowself-api/person/a%25b"))).status).toBe(200);
    expect(b.getSpy).toHaveBeenLastCalledWith("a%b");
  });

  it("特殊字符 id（含 / ? # % 空格 中文）经 encodeURIComponent 后服务端还原原串", async () => {
    const id = "a/b?c#d%e 中文";
    const b = makeBridge();
    const res = await b.resource(GET(`/knowself-api/person/${encodeURIComponent(id)}`));
    expect(res.status).toBe(200);
    expect(b.getSpy).toHaveBeenCalledWith(id);
  });
});

// ── G. client REST 端口 ───────────────────────────────────────────────────

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

describe("QA-B2-F：client REST 端口（URL / 编码 / 错误 / 零写操作）", () => {
  it("listPersons 五字段 query 按固定顺序拼接，特殊字符正确编码", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestDataPort();
    await port.listPersons({
      subject_kind: "contact",
      status: "active",
      keyword: "张 三",
      limit: 2,
      offset: 1,
    });
    const url = fetchStub.mock.calls[0]![0] as string;
    expect(url).toBe(
      "/knowself-api/persons?subject_kind=contact&status=active&keyword=%E5%BC%A0+%E4%B8%89&limit=2&offset=1",
    );
  });

  it("timeline 五字段 query 按固定顺序拼接（含日期与 min_importance）", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestDataPort();
    await port.timeline("p1", {
      from_date: "2026-01-01",
      to_date: "2026-02-01",
      min_importance: 2,
      limit: 5,
      offset: 1,
    });
    expect(fetchStub.mock.calls[0]![0]).toBe(
      "/knowself-api/person/p1/timeline?from_date=2026-01-01&to_date=2026-02-01&min_importance=2&limit=5&offset=1",
    );
  });

  it("undefined / null query 值被跳过，不产生 undefined=... 或 null=...", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestDataPort();
    await port.listPersons({
      keyword: "a",
      limit: undefined,
      offset: null,
      subject_kind: undefined,
    } as unknown as PersonListQuery);
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/persons?keyword=a");
  });

  it("getPerson 特殊字符 id → 百分号编码（a%2Fb / a%25b / 中文空格）", async () => {
    const fetchStub = stubFetch(null);
    const port = createRestDataPort();
    await port.getPerson("a/b");
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/person/a%2Fb");
    await port.getPerson("a%b");
    expect(fetchStub.mock.calls[1]![0]).toBe("/knowself-api/person/a%25b");
    await port.getPerson("中 文");
    expect(fetchStub.mock.calls[2]![0]).toBe(
      "/knowself-api/person/%E4%B8%AD%20%E6%96%87",
    );
  });

  it("非 2xx 抛错且消息含完整 URL（baseUrl + path + query）", async () => {
    stubFetch({ error: "boom" }, 503);
    const port = createRestDataPort("/custom/api");
    await expect(port.listPersons({ limit: 2 })).rejects.toThrow(
      "GET /custom/api/persons?limit=2 → 503",
    );
    await expect(port.timeline("a/b", { limit: 1 })).rejects.toThrow(
      "GET /custom/api/person/a%2Fb/timeline?limit=1 → 503",
    );
    await expect(port.getPerson("p1")).rejects.toThrow(
      "GET /custom/api/person/p1 → 503",
    );
  });

  it("GET + accept: application/json，且零写操作（无 method / body）", async () => {
    const fetchStub = stubFetch([]);
    const port = createRestDataPort();
    await port.listPersons({ limit: 1 });
    const init = fetchStub.mock.calls[0]![1];
    expect(init).toEqual({ headers: { accept: "application/json" } });
    const serialized = JSON.stringify(init);
    expect(serialized).not.toContain("method");
    expect(serialized).not.toContain("body");
  });

  it("200 + null 原样透传；无 query 时 URL 不带 '?'", async () => {
    const fetchStub = stubFetch(null);
    const port = createRestDataPort();
    await expect(port.getPerson("p1")).resolves.toBeNull();
    expect(fetchStub.mock.calls[0]![0]).toBe("/knowself-api/person/p1");
    await port.listPersons();
    expect(fetchStub.mock.calls[1]![0]).toBe("/knowself-api/persons");
  });
});
