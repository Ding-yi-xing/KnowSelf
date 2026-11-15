/**
 * B2 Node 侧单测：`registerKnowselfWebBridge`（桩服务 / 桩 webServer，不触网、不开 DB）。
 *
 * W2/T04 夹具适配：生产代码改为 `ctx.inject(["webServer", "connection"], cb)` 子 fiber，桩 ctx 相应
 * 补 `inject(deps, cb)`。真实 cordis 的 `inject` 是「全有或全无」——依赖未就绪时
 * **不调用 cb**、不抛错（2026-11-09 实测 `new Context().inject(['webServer'], cb)`：
 * cb called = false）。桩严格复刻该语义，并让 `fiber.dispose()` 级联调用
 * `sub.effect` 收集的 disposer，保持既有 `disposeCalls()` 断言成立。
 *
 * F3（鉴权）：桩 ctx 另提供 `connection: { requestRejection }`（默认放行 undefined），
 * 使「鉴权 → 路由 → 降级 → 200」的顺序可被断言；未提供 connection 的用例断言桥不注册。
 *
 * 覆盖：prefix 路由形状、disposer 回收、依赖未就绪降级、三端点 200 + 形状 + query 透传、
 *       200 + null、id 百分号编码闭环、未知路径 404、port 抛错 500、非法参数 400、
 *       非法 id 编码 400；外加 3 条子 fiber 专项（cb 执行条件、级联回收、sub.webServer 使用）。
 *
 * 说明：`Request` / `Response` 用 Node 内置 Fetch（undici）全局对象；
 * 直接调捕获到的 `route.resource(request)`，等价于绕开 webServer 的 prefix 分发。
 * 桩 ctx 不 import 任何 `@deepseek-ai/dsh-host-webserver` 运行时包。
 */
import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { PersonRow } from "@knowself/person-store";
import type { KnowselfServices } from "../src/services.js";
import { registerKnowselfWebBridge } from "../src/web-bridge.js";

/** 捕获到的 resource 型路由（测试局部形状，不依赖 ambient 契约）。 */
interface CapturedRoute {
  kind: string;
  path: string;
  resource: (request: Request) => Promise<Response>;
}

const ROW = {
  person_id: "p1",
  display_name: "张三",
  subject_kind: "contact",
  status: "active",
  profile_json: "{}",
} as unknown as PersonRow;

const EVENT = {
  event_id: "e1",
  event_date: "2026-01-01",
  title: "初次见面",
  summary: "示例",
  importance: 3,
};

interface HarnessOptions {
  withWebServer?: boolean;
  /** F3：`connection` 服务是否就绪（缺省 true）。缺省/缺席时桥不注册（fail-closed）。 */
  withConnection?: boolean;
  registerIsFunction?: boolean;
  withLogger?: boolean;
  throwOnList?: boolean;
  listRows?: PersonRow[];
  personRow?: PersonRow | null;
  events?: unknown[];
  /** F3：`requestRejection` 固定判决（默认 undefined = 放行）。 */
  rejection?: 401 | 403 | undefined;
  /** F3：按请求返回判决（优先级高于 `rejection`）。 */
  requestRejection?: (request: Request) => 401 | 403 | undefined;
  /** F3：人物层是否存在（缺省 true；false 时 services 无 personStore → 状态码 503）。 */
  withPersonStore?: boolean;
  automationStatus?: { getStatus(): unknown };
}

interface Harness {
  ctx: Context;
  services: KnowselfServices;
  routes: CapturedRoute[];
  disposeCalls: () => number;
  listSpy: unknown;
  getSpy: unknown;
  timelineSpy: unknown;
  /** `ctx.inject` 被调用次数。 */
  injectCalls: () => number;
  /** `inject` 回调被实际执行次数（依赖未就绪时应为 0）。 */
  cbCalls: () => number;
  /** 每次 inject 收到的依赖数组。 */
  injectDeps: () => string[][];
  /** logger.warn 被调用次数（新设计要求降级路径无 warn）。 */
  warnCalls: () => number;
  /** F3：`connection.requestRejection` 收到的请求（断言鉴权先于一切业务）。 */
  rejectionCalls: () => Request[];
}

/**
 * 构造桩：personStore 三方法用 vi.fn（可断言透传参数、可制造抛错），
 * webServer 只提供 register（捕获 route + 返回可观测 disposer）。
 *
 * W2/T04：`ctx` 补 `inject(deps, cb)` —— 依赖就绪时构造 `sub`（含
 * `webServer` / `effect` / `logger`）并调用 `cb(sub)`，返回 Fiber-like 对象；
 * 未就绪时不调用 `cb`，返回 dispose 为空操作的 Fiber-like 对象。
 */
function makeHarness(opts: HarnessOptions = {}): Harness {
  const {
    withWebServer = true,
    withConnection = true,
    registerIsFunction = true,
    withLogger = true,
  } = opts;

  const listSpy = vi.fn(() => {
    if (opts.throwOnList) throw new Error("boom-store");
    return opts.listRows ?? [ROW];
  });
  const getSpy = vi.fn((id: string) => {
    if (opts.personRow !== undefined) return opts.personRow;
    return id === "p1" ? ROW : null;
  });
  const timelineSpy = vi.fn(() => opts.events ?? [EVENT]);

  // createPersonStoreDataPort 内部访问 store.events.timeline（不是 store.timeline）。
  const store = {
    listPersons: listSpy,
    getPerson: getSpy,
    events: { timeline: timelineSpy },
  } as unknown as KnowselfServices["personStore"];
  // F3：withPersonStore=false 时构造「人物层降级」的 services（无 personStore + degraded）。
  const services = (
    opts.withPersonStore === false
      ? {
          degraded: {
            missing: ["person"],
            reasons: ["人物层装配失败（createPersonStore）：密钥未配置"],
          },
        }
      : { personStore: store }
  ) as unknown as KnowselfServices;

  const routes: CapturedRoute[] = [];
  let disposed = 0;
  let injectCalls = 0;
  let cbCalls = 0;
  let warnings = 0;
  const injectDeps: string[][] = [];
  const rejectionCalls: Request[] = [];
  const effectDisposers: Array<() => void> = [];

  const register = (route: CapturedRoute): (() => void) => {
    routes.push(route);
    return () => {
      disposed += 1;
    };
  };

  // F3：dsh `connection` 服务桩——记录收到的请求并返回既定判决。
  const requestRejection = (request: Request): 401 | 403 | undefined => {
    rejectionCalls.push(request);
    if (opts.requestRejection !== undefined) return opts.requestRejection(request);
    return opts.rejection;
  };

  const ctxObject: Record<string, unknown> = {};
  const webServerReady = withWebServer && registerIsFunction;
  if (withWebServer) {
    ctxObject.webServer = { register: registerIsFunction ? register : 123 };
  }
  if (withConnection) {
    ctxObject.connection = { requestRejection };
  }
  if (withLogger) {
    ctxObject.logger = () => ({
      warn: () => {
        warnings += 1;
      },
      error: () => {},
      info: () => {},
    });
  }

  ctxObject.inject = (deps: string[], cb: (sub: unknown) => void) => {
    injectCalls += 1;
    injectDeps.push(deps);
    // 真实 cordis「全有或全无」：任一必需依赖缺席 → cb 永不执行。
    const depsReady =
      webServerReady &&
      deps.includes("webServer") &&
      withConnection &&
      deps.includes("connection");
    if (!depsReady) {
      return { dispose: async () => {} };
    }
    cbCalls += 1;
    const sub = {
      webServer: ctxObject.webServer,
      connection: ctxObject.connection,
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
        // 级联回收 sub.effect 收集的 disposer（不清空，保证每次 dispose 都触发）。
        for (const disposer of [...effectDisposers].reverse()) disposer();
      },
    };
  };

  return {
    ctx: ctxObject as unknown as Context,
    services,
    routes,
    disposeCalls: () => disposed,
    listSpy,
    getSpy,
    timelineSpy,
    injectCalls: () => injectCalls,
    cbCalls: () => cbCalls,
    injectDeps: () => injectDeps,
    warnCalls: () => warnings,
    rejectionCalls: () => rejectionCalls,
  };
}

/** 挂载桥并取出 resource；webServer 必须可用（否则视为测试夹具错误）。 */
function mount(opts: HarnessOptions = {}): {
  h: Harness;
  resource: (request: Request) => Promise<Response>;
  dispose: () => void;
} {
  const h = makeHarness(opts);
  const dispose = registerKnowselfWebBridge(h.ctx, h.services, opts.automationStatus);
  const route = h.routes[0];
  if (route === undefined) throw new Error("route 未注册（预期 webServer 可用）");
  return { h, resource: route.resource, dispose };
}

describe("B2 Node 侧：registerKnowselfWebBridge 注册与降级", () => {
  it("注册 kind='prefix' / path='/knowself-api' 的 resource 路由，返回可调用 disposer", () => {
    const h = makeHarness();
    const dispose = registerKnowselfWebBridge(h.ctx, h.services);
    expect(h.routes).toHaveLength(1);
    expect(h.routes[0]!.kind).toBe("prefix");
    expect(h.routes[0]!.path).toBe("/knowself-api");
    expect(typeof h.routes[0]!.resource).toBe("function");
    expect(typeof dispose).toBe("function");
    expect(h.injectCalls()).toBe(1);
    expect(h.cbCalls()).toBe(1);
  });

  it("返回的 disposer 调用后触发 webServer.register 提供的回收函数", () => {
    const h = makeHarness();
    const dispose = registerKnowselfWebBridge(h.ctx, h.services);
    expect(h.disposeCalls()).toBe(0);
    dispose();
    expect(h.disposeCalls()).toBe(1);
  });

  it("依赖未就绪（webServer 缺席，连 logger 都没有）→ cb 不执行、不抛、no-op disposer、无 warn", () => {
    const h = makeHarness({ withWebServer: false, withLogger: false });
    let dispose: () => void = () => {};
    expect(() => {
      dispose = registerKnowselfWebBridge(h.ctx, h.services);
    }).not.toThrow();
    expect(h.routes).toHaveLength(0);
    expect(() => dispose()).not.toThrow();
    expect(h.disposeCalls()).toBe(0);
    expect(h.injectCalls()).toBe(1);
    expect(h.cbCalls()).toBe(0);
    expect(h.warnCalls()).toBe(0);
  });

  it("依赖未就绪（register 不是函数）→ cb 不执行、不抛、no-op disposer、无 warn", () => {
    const h = makeHarness({ registerIsFunction: false });
    const dispose = registerKnowselfWebBridge(h.ctx, h.services);
    expect(h.routes).toHaveLength(0);
    expect(() => dispose()).not.toThrow();
    expect(h.disposeCalls()).toBe(0);
    expect(h.injectCalls()).toBe(1);
    expect(h.cbCalls()).toBe(0);
    expect(h.warnCalls()).toBe(0);
  });

  it("真实 cordis Context（未 inject webServer）→ inject 全有或全无，不抛、no-op disposer", async () => {
    // 复现 A1 挂载测试的 ctx：真实 `new Context()` 只 provide 了 tools/systemPrompt/settings。
    // W2 起不再依赖 try/catch 兜底，而是真实 cordis inject 的「依赖未就绪则不执行 cb」。
    const root = new Context();
    root.provide("tools", { register: () => () => {} });
    const h = makeHarness({ withWebServer: false, withLogger: false });
    let dispose: () => void = () => {};
    expect(() => {
      dispose = registerKnowselfWebBridge(root, h.services);
    }).not.toThrow();
    expect(() => dispose()).not.toThrow();

    // 直接验证真实 cordis 的 inject 语义（生产代码降级所依赖的前提）。
    let cordisCbCalled = false;
    const fiber = root.inject(["webServer"], () => {
      cordisCbCalled = true;
    });
    expect(cordisCbCalled).toBe(false);
    await fiber.dispose();
    expect(cordisCbCalled).toBe(false);
  });

  // ── W2/T04 新增：子 fiber 专项覆盖 ────────────────────────────────────────
  it("子 fiber：cb 执行条件为 deps 含 'webServer'+'connection' 且依赖就绪，且只执行一次", () => {
    const h = makeHarness();
    registerKnowselfWebBridge(h.ctx, h.services);
    expect(h.injectCalls()).toBe(1);
    expect(h.cbCalls()).toBe(1);
    expect(h.injectDeps()).toEqual([["webServer", "connection"]]);
  });

  it("F3 fail-closed：connection 缺席 → cb 不执行、桥不注册（宁可 404 也不裸奔）", () => {
    const h = makeHarness({ withConnection: false });
    const dispose = registerKnowselfWebBridge(h.ctx, h.services);
    expect(h.injectCalls()).toBe(1);
    expect(h.cbCalls()).toBe(0);
    expect(h.routes).toHaveLength(0);
    expect(() => dispose()).not.toThrow();
    expect(h.disposeCalls()).toBe(0);
    expect(h.warnCalls()).toBe(0);
  });

  it("子 fiber：fiber.dispose 级联回收 sub.effect 收集的 register disposer", () => {
    const h = makeHarness();
    const dispose = registerKnowselfWebBridge(h.ctx, h.services);
    expect(h.cbCalls()).toBe(1);
    expect(h.disposeCalls()).toBe(0);
    dispose();
    expect(h.disposeCalls()).toBe(1);
  });

  it("子 fiber：路由经 sub.webServer.register 注册（非 ctx 顶层直接注册）", () => {
    const h = makeHarness();
    registerKnowselfWebBridge(h.ctx, h.services);
    expect(h.cbCalls()).toBe(1);
    expect(h.routes).toHaveLength(1);
    expect(h.routes[0]!.path).toBe("/knowself-api");
    expect(typeof h.routes[0]!.resource).toBe("function");
  });
});

describe("B2 Node 侧：三端点 200 + 形状 + query 透传", () => {
  it("GET /persons → 200 + PersonRow[]，listPersons 收到完整 PersonListQuery", async () => {
    const { h, resource } = mount();
    const res = await resource(
      new Request(
        "http://x/knowself-api/persons?subject_kind=contact&status=active&keyword=zhang&limit=2&offset=1",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual([ROW]);
    expect(h.listSpy).toHaveBeenCalledWith({
      subject_kind: "contact",
      status: "active",
      keyword: "zhang",
      limit: 2,
      offset: 1,
    });
  });

  it("GET /persons（无 query）→ 200 + 空数组，listPersons({})", async () => {
    const { h, resource } = mount({ listRows: [] });
    const res = await resource(new Request("http://x/knowself-api/persons"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
    expect(h.listSpy).toHaveBeenCalledWith({});
  });

  it("GET /person/p1 → 200 + PersonRow，getPerson('p1')", async () => {
    const { h, resource } = mount();
    const res = await resource(new Request("http://x/knowself-api/person/p1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(ROW);
    expect(h.getSpy).toHaveBeenCalledWith("p1");
  });

  it("GET /person/missing → 200 + null（未找到按契约返回 200 + null）", async () => {
    const { resource } = mount();
    const res = await resource(new Request("http://x/knowself-api/person/missing"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toBeNull();
  });

  it("GET /person/a%2Fb → getPerson('a/b')（client ↔ server 路径编码闭环）", async () => {
    const { h, resource } = mount();
    const res = await resource(new Request("http://x/knowself-api/person/a%2Fb"));
    expect(res.status).toBe(200);
    expect(h.getSpy).toHaveBeenCalledWith("a/b");
  });

  it("GET /person/p1/timeline → 200 + EventRow[]，timeline 透传完整 query", async () => {
    const { h, resource } = mount();
    const res = await resource(
      new Request(
        "http://x/knowself-api/person/p1/timeline?from_date=2026-01-01&to_date=2026-02-01&min_importance=2&limit=10&offset=3",
      ),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([EVENT]);
    expect(h.timelineSpy).toHaveBeenCalledWith("p1", {
      from_date: "2026-01-01",
      to_date: "2026-02-01",
      min_importance: 2,
      limit: 10,
      offset: 3,
    });
  });

  it("未知路径 GET /knowself-api/unknown → 404 + {error}", async () => {
    const { resource } = mount();
    const res = await resource(new Request("http://x/knowself-api/unknown"));
    expect(res.status).toBe(404);
    // §13.4：404 响应体由 `{error:"not found"}` 改为 `{error:"not_found"}`（仅未知路径）。
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("已认证 GET /automation/wechat-import-status → 200 + 注入的运行状态", async () => {
    const snapshot = {
      mode: "active",
      task_id: "ingest",
      entries: [{ id: "wechat-main", state: "succeeded" }],
    };
    const getStatus = vi.fn(() => snapshot);
    const { resource } = mount({ automationStatus: { getStatus } });
    const res = await resource(
      new Request("http://x/knowself-api/automation/wechat-import-status"),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(snapshot);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});

describe("B2 Node 侧：错误与参数校验", () => {
  it("port 抛错 → 500 + {error: 'boom-store'}", async () => {
    const { resource } = mount({ throwOnList: true });
    const res = await resource(new Request("http://x/knowself-api/persons"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "boom-store" });
  });

  it("非法参数（limit=abc / subject_kind=unknown / offset=-1 / min_importance=1.5）→ 400 + {error}", async () => {
    const { resource } = mount();
    const cases = [
      "http://x/knowself-api/persons?limit=abc",
      "http://x/knowself-api/persons?subject_kind=unknown",
      "http://x/knowself-api/persons?offset=-1",
      "http://x/knowself-api/person/p1/timeline?min_importance=1.5",
    ];
    for (const url of cases) {
      const res = await resource(new Request(url));
      expect(res.status, url).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    }
  });

  it("非法 id 百分号编码（%zz）→ 400 + {error}", async () => {
    const { resource } = mount();
    const res = await resource(new Request("http://x/knowself-api/person/%zz"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("编码非法");
  });
});

/**
 * F3（P1 安全）：`/knowself-api/*` 绕过 dsh 会话鉴权 → 桥必须自行调用
 * `connection.requestRejection(request)`，且**鉴权先于一切**（路由分发 / 参数校验 /
 * 降级判断 / 业务取数）。
 */
describe("F3 鉴权闸门：connection.requestRejection 先于一切", () => {
  it("requestRejection → undefined（已认证）→ 200 + 正常数据", async () => {
    const { h, resource } = mount({ requestRejection: () => undefined });
    const res = await resource(new Request("http://x/knowself-api/persons?limit=3"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([ROW]);
    expect(h.rejectionCalls()).toHaveLength(1);
    expect(h.listSpy).toHaveBeenCalledWith({ limit: 3 });
  });

  it("requestRejection → 401（未认证）→ 401，响应体不含任何人物字段，业务端口零调用", async () => {
    const { h, resource } = mount({ requestRejection: () => 401 });
    const res = await resource(new Request("http://x/knowself-api/persons?limit=3"));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("authentication required");
    // 零泄漏：不含人物字段与降级原因
    expect(text).not.toContain("display_name");
    expect(text).not.toContain("profile_json");
    expect(text).not.toContain("degraded");
    expect(h.listSpy).not.toHaveBeenCalled();
    expect(h.getSpy).not.toHaveBeenCalled();
    expect(h.timelineSpy).not.toHaveBeenCalled();
  });

  it("requestRejection → 403（Host/Origin 围栏）→ 403 + forbidden", async () => {
    const { resource } = mount({ requestRejection: () => 403 });
    const res = await resource(new Request("http://x/knowself-api/persons"));
    expect(res.status).toBe(403);
    await expect(res.text()).resolves.toBe("forbidden\n");
  });

  it("未认证 + 人物层降级（personStore 缺失）→ 401（不是 503，证明鉴权先于降级判断）", async () => {
    // 同一份「人物层降级」services：未认证 401，已认证才轮到 503。
    const authed = mount({ withPersonStore: false, rejection: undefined });
    const degraded = await authed.resource(
      new Request("http://x/knowself-api/persons"),
    );
    expect(degraded.status).toBe(503);

    const unauthed = mount({ withPersonStore: false, rejection: 401 });
    const res = await unauthed.resource(
      new Request("http://x/knowself-api/persons"),
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    // 未认证方不得看到 degraded.reason
    expect(text).not.toContain("人物层装配失败");
    expect(text).not.toContain("degraded");
  });

  it("未认证 + 未知路径 → 401（鉴权优先于 404，不泄露路径语义）", async () => {
    const { resource } = mount({ rejection: 401 });
    const res = await resource(new Request("http://x/knowself-api/unknown-path"));
    expect(res.status).toBe(401);
  });

  it("未认证自动化状态请求 → 401 且不调用状态提供器", async () => {
    const getStatus = vi.fn(() => ({ mode: "active", entries: [] }));
    const { resource } = mount({
      rejection: 401,
      automationStatus: { getStatus },
    });
    const res = await resource(
      new Request("http://x/knowself-api/automation/wechat-import-status"),
    );
    expect(res.status).toBe(401);
    expect(getStatus).not.toHaveBeenCalled();
  });
});
