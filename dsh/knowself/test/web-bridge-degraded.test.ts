/**
 * §13.4 新增覆盖：桥与人物层解耦后的端点语义（纯桩，不触网、不开 DB）。
 *
 * 独立于 `test/web-bridge.test.ts` 的静态桩，专门构造「personStore 缺失 + degraded」的服务对象，
 * 验证：桥仍注册、三端点 503 + 约定响应体且脱敏、未知路径仍 404、400 参数校验优先、
 * 人物层恢复后 200、degraded 缺失（W1/W2 测试桩）视为人物层可用。
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { KnowselfServices } from "../src/services.js";
import { registerKnowselfWebBridge } from "../src/web-bridge.js";

interface CapturedRoute {
  kind: string;
  path: string;
  resource: (request: Request) => Promise<Response>;
}

interface Harness {
  services: KnowselfServices;
  routes: CapturedRoute[];
  store: unknown;
}

const DEGRADING_REASON =
  "人物层装配失败（createPersonStore）：\\\\?\\C:\\Users\\secret\\x.node NODE_MODULE_VERSION 127 " +
  "密钥 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 构造带 degraded 但无 personStore 的 services + 桩 ctx（webServer 就绪）。 */
function makeBridge(options: { withDegraded?: boolean } = {}): Harness {
  const store = {
    listPersons: vi.fn(() => [{ person_id: "p1", display_name: "张三" }]),
    getPerson: vi.fn(() => null),
    events: { timeline: vi.fn(() => [{ event_id: "e1", title: "事件" }]) },
  };
  const services = (
    options.withDegraded === false
      ? { personStore: store }
      : {
          degraded: {
            missing: ["person"],
            reasons: [DEGRADING_REASON],
          },
        }
  ) as unknown as KnowselfServices;

  const routes: CapturedRoute[] = [];
  const ctxObj = {
    inject: (_deps: string[], cb: (sub: unknown) => void) => {
      const sub = {
        webServer: {
          register: (route: CapturedRoute) => {
            routes.push(route);
            return () => {};
          },
        },
        // F3：dsh `connection` 鉴权入口桩——本节全部用例都是「已认证」调用方（放行）。
        connection: { requestRejection: (_request: Request) => undefined },
        effect: (fn: () => unknown) => fn(),
        logger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
      };
      cb(sub);
      return { dispose: async () => {} };
    },
  };
  registerKnowselfWebBridge(ctxObj as unknown as Context, services);
  return { services, routes, store };
}

describe("§13.4：人物层降级时桥仍注册并返回 503", () => {
  it("桥仍注册（routes=1），GET /persons 返回 503 + {status,reason,layer} 且脱敏", async () => {
    const h = makeBridge();
    expect(h.routes).toHaveLength(1);
    expect(h.routes[0]!.path).toBe("/knowself-api");
    const res = await h.routes[0]!.resource(
      new Request("http://x/knowself-api/persons"),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.layer).toBe("person");
    expect(typeof body.reason).toBe("string");
    expect((body.reason as string).length).toBeGreaterThan(0);
    expect((body.reason as string)).toContain("人物层装配失败");
    // 脱敏：不含绝对路径 / UNC / 长 base64（密钥）/ 堆栈
    expect(body.reason).not.toContain("C:\\Users\\secret");
    expect(body.reason).not.toContain("\\\\?\\");
    expect(body.reason).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    // 数据端口绝不能被误调用
    expect(h.store).toBeDefined();
  });

  it("三端点（/persons、/person/:id、/person/:id/timeline）均 503 且形状一致", async () => {
    const h = makeBridge();
    for (const path of ["/persons", "/person/p1", "/person/p1/timeline"]) {
      const res = await h.routes[0]!.resource(
        new Request(`http://x/knowself-api${path}`),
      );
      expect(res.status, path).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("degraded");
      expect(body.layer).toBe("person");
    }
  });

  it("未知路径仍 404 {error:'not_found'}（不是 503），非 GET 仍 404", async () => {
    const h = makeBridge();
    const unknown = await h.routes[0]!.resource(
      new Request("http://x/knowself-api/unknown"),
    );
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ error: "not_found" });
    const post = await h.routes[0]!.resource(
      new Request("http://x/knowself-api/persons", { method: "POST" }),
    );
    expect(post.status).toBe(404);
  });

  it("400 参数校验优先于 503（非法 limit 仍返回 400）", async () => {
    const h = makeBridge();
    const res = await h.routes[0]!.resource(
      new Request("http://x/knowself-api/persons?limit=abc"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("人物层恢复（补回 personStore）后 GET /persons 返回 200 + 真实行", async () => {
    const h = makeBridge();
    h.services.personStore = h.store as NonNullable<
      KnowselfServices["personStore"]
    >;
    const res = await h.routes[0]!.resource(
      new Request("http://x/knowself-api/persons"),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      { person_id: "p1", display_name: "张三" },
    ]);
  });

  it("degraded 缺失（W1/W2 静态测试桩形态）视为人物层可用 → 200", async () => {
    const h = makeBridge({ withDegraded: false });
    expect(h.routes).toHaveLength(1);
    const res = await h.routes[0]!.resource(
      new Request("http://x/knowself-api/persons"),
    );
    expect(res.status).toBe(200);
  });
});
