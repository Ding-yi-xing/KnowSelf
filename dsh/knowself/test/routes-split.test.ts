/**
 * M3/T08：REST 路由拆分后的契约测试（桩服务、桩 webServer，不触网、不开 DB）。
 *
 * 覆盖两类关注点：
 *   A. **派发顺序**：鉴权 → 路由(404) → 参数(400) → 降级(503) → 数据(200)
 *      ——未认证时连未知路径也是 401（不泄露路径语义 / 降级原因）。
 *   B. **新端点形状**：`/profile/core`、`/cards`、`/cards/:key`、`/journal`、`/journal/:date`
 *      的 200 体；`cards/:key` 不存在 → 404；`layer` / 日期参数非法 → 400；
 *      人物层降级（503）与既有三端点行为**保持不变**（重构零语义变更）。
 *
 * 桩形状与 `test/web-bridge.test.ts` 同源：`ctx.inject(deps, cb)` 复刻 cordis
 * 「全有或全无」语义，`sub.effect` 收集的 disposer 由 fiber 级联回收。
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { KnowselfServices } from "../src/services.js";
import { registerKnowselfWebBridge } from "../src/web-bridge.js";

/** 捕获到的 resource 型路由（测试局部形状，不依赖 ambient 契约）。 */
interface CapturedRoute {
  kind: string;
  path: string;
  resource: (request: Request) => Promise<Response>;
}

/** L1 核心画像桩。 */
const CORE = {
  display_name: "测试用户",
  locale: "zh-CN",
  section_tags: ["基本情况"],
  body: "一段很长的正文",
  updated_at: "2026-05-30T00:00:00.000Z",
  schema_version: 1 as const,
};

/** L2 卡片摘要桩（含一张带 L1 标记的卡片，用于验证 layer 过滤）。 */
const CARD_L2 = {
  key: "skills",
  title: "技能",
  summary: "后端开发",
  section_tags: [],
  updated_at: "2026-05-30T00:00:00.000Z",
};
const CARD_L1 = {
  key: "identity",
  title: "身份",
  summary: "L1 标记卡片",
  section_tags: ["L1"],
  updated_at: "2026-05-30T00:00:00.000Z",
};

/** 单卡详情桩。 */
const CARD_DETAIL = {
  card: { ...CARD_L2, schema_version: 1 as const },
  sections: [
    {
      id: 1,
      card_key: "skills",
      title: "Java",
      body: "Spring Boot",
      ord: 0,
      updated_at: "2026-05-30T00:00:00.000Z",
    },
  ],
};

/** 日志日期摘要桩。 */
const DATE_OLD = { date: "2026-05-01", record_count: 1, updated_at: "2026-05-01T00:00:00.000Z" };
const DATE_NEW = { date: "2026-05-30", record_count: 2, updated_at: "2026-05-30T00:00:00.000Z" };

/** 单日日志桩。 */
const JOURNAL_ENTRY = {
  date: "2026-05-30",
  records: [
    {
      id: 1,
      date: "2026-05-30",
      ordinal: 1,
      recorded_at: "2026-05-30T08:00:00.000Z",
      provenance: "ui" as const,
      tags: ["晨间"],
      body: "今天写完了路由拆分",
    },
  ],
};

/**
 * 构造领域服务桩：核心层（profileStore）齐全，人物层按需缺席。
 * @param withPersonStore 人物层是否装配（缺省 true）
 */
function makeServices(withPersonStore = true): KnowselfServices {
  const profileStore = {
    core: { get: vi.fn(() => CORE) },
    cards: {
      // 故意把日期/顺序打乱，验证 /journal 的倒序契约由路由层保证
      list: vi.fn(() => [CARD_L2, CARD_L1]),
      get: vi.fn((key: string) => {
        if (key !== CARD_L2.key) throw new Error(`card 不存在: ${key}`);
        return CARD_DETAIL;
      }),
    },
    journal: {
      listDates: vi.fn(() => [DATE_OLD, DATE_NEW]),
      get: vi.fn((date: string) => ({ date, records: date === JOURNAL_ENTRY.date ? JOURNAL_ENTRY.records : [] })),
    },
  };
  const personStore = {
    listPersons: vi.fn(() => [{ person_id: "p1", display_name: "张三" }]),
    getPerson: vi.fn((id: string) => (id === "p1" ? { person_id: "p1" } : null)),
    events: { timeline: vi.fn(() => []) },
  };
  return {
    ...(withPersonStore
      ? { personStore }
      : {
          degraded: {
            missing: ["person"],
            reasons: ["人物层装配失败（createPersonStore）：密钥未配置"],
          },
        }),
    profileStore,
  } as unknown as KnowselfServices;
}

/** 挂载桥并取出 resource。 */
function mount(
  services: KnowselfServices,
  rejection?: 401 | 403,
): (request: Request) => Promise<Response> {
  const routes: CapturedRoute[] = [];
  const sub = {
    webServer: {
      register: (route: CapturedRoute) => {
        routes.push(route);
        return () => {};
      },
    },
    connection: { requestRejection: () => rejection },
    effect: (fn: () => unknown) => fn(),
    logger: () => ({ error: () => {}, warn: () => {}, info: () => {} }),
  };
  const ctx = {
    inject: (_deps: string[], cb: (s: unknown) => void) => {
      cb(sub);
      return { dispose: async () => {} };
    },
  } as unknown as Context;

  registerKnowselfWebBridge(ctx, services);
  const route = routes[0];
  if (route === undefined) throw new Error("route 未注册（预期 webServer 可用）");
  return route.resource;
}

/** 一次 GET 请求。 */
async function get(
  resource: (request: Request) => Promise<Response>,
  path: string,
  method = "GET",
): Promise<{ status: number; body: unknown }> {
  const res = await resource(new Request(`http://x${path}`, { method }));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe("T08 A. 派发顺序：鉴权先于路由 / 参数 / 降级", () => {
  it("未认证 + 未知路径 → 401（鉴权优先于 404，不泄露路径语义）", async () => {
    const resource = mount(makeServices(), 401);
    const { status, body } = await get(resource, "/knowself-api/not-a-real-endpoint");
    expect(status).toBe(401);
    expect(String(body)).not.toContain("not_found");
  });

  it("未认证 + 新端点 → 401（不是 200/503，业务零调用）", async () => {
    const services = makeServices();
    const resource = mount(services, 401);
    for (const path of [
      "/knowself-api/profile/core",
      "/knowself-api/cards",
      "/knowself-api/cards/skills",
      "/knowself-api/journal",
      "/knowself-api/journal/2026-05-30",
    ]) {
      const { status } = await get(resource, path);
      expect(status, path).toBe(401);
    }
    expect(services.profileStore.core.get).not.toHaveBeenCalled();
    expect(services.profileStore.cards.list).not.toHaveBeenCalled();
    expect(services.profileStore.journal.listDates).not.toHaveBeenCalled();
  });

  it("未认证 + 非法参数 → 401（鉴权先于 400）", async () => {
    const resource = mount(makeServices(), 401);
    const { status } = await get(resource, "/knowself-api/cards?layer=L9");
    expect(status).toBe(401);
  });

  it("已认证 + 未知路径 → 404 {error:'not_found'}", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/not-a-real-endpoint");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  });

  it("非 GET（POST /knowself-api/journal）→ 404（保持拆分前行为）", async () => {
    const resource = mount(makeServices());
    const { status } = await get(resource, "/knowself-api/journal", "POST");
    expect(status).toBe(404);
  });

  it("人物层降级仍返回 503 + {status:'degraded', layer:'person'}（重构零语义变更）", async () => {
    const resource = mount(makeServices(false));
    const { status, body } = await get(resource, "/knowself-api/persons");
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "degraded", layer: "person" });
  });

  it("人物层降级不影响核心层端点（/profile/core 仍 200）", async () => {
    const resource = mount(makeServices(false));
    const { status, body } = await get(resource, "/knowself-api/profile/core");
    expect(status).toBe(200);
    expect(body).toMatchObject({ display_name: "测试用户" });
  });
});

describe("T08 B. 新端点 200 形状 + 参数校验", () => {
  it("GET /profile/core → 200 + L1 core 对象", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/profile/core");
    expect(status).toBe(200);
    expect(body).toEqual(CORE);
  });

  it("GET /cards → 200 + 全部卡片；?layer=L2 等价于省略；?layer=L1 → 400 unsupported_layer", async () => {
    const resource = mount(makeServices());

    const all = await get(resource, "/knowself-api/cards");
    expect(all.status).toBe(200);
    expect(all.body).toEqual([CARD_L2, CARD_L1]);

    const l2 = await get(resource, "/knowself-api/cards?layer=L2");
    expect(l2.status).toBe(200);
    expect(l2.body).toEqual([CARD_L2, CARD_L1]);

    // M3 波 2 语义修正：L1 不在 cards 表里（由 /profile/core 提供），
    // 旧行为「200 + []」会被客户端读成「空画像」，现改为显式 400。
    const l1 = await get(resource, "/knowself-api/cards?layer=L1");
    expect(l1.status).toBe(400);
    expect(l1.body).toEqual({
      error: "unsupported_layer",
      hint: "L1 由 /profile/core 提供",
    });
  });

  it("GET /cards?layer=非法 → 400 + {error}", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/cards?layer=L9");
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: expect.stringContaining("layer") as unknown as string });
  });

  it("GET /cards/skills → 200 + 单卡（含 sections）", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/cards/skills");
    expect(status).toBe(200);
    expect(body).toEqual(CARD_DETAIL);
  });

  it("GET /cards/不存在的 key → 404 + {error:'not_found'}", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/cards/nope");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  });

  it("GET /journal → 200 + 按日期倒序的日期摘要", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/journal");
    expect(status).toBe(200);
    expect(body).toEqual([DATE_NEW, DATE_OLD]);
  });

  it("GET /journal/2026-05-30 → 200 + {date, records}", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/journal/2026-05-30");
    expect(status).toBe(200);
    expect(body).toEqual(JOURNAL_ENTRY);
  });

  it("GET /journal/无数据日期 → 200 + records:[]（不抛错、不 404）", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/journal/2020-01-01");
    expect(status).toBe(200);
    expect(body).toEqual({ date: "2020-01-01", records: [] });
  });

  it("GET /journal/非法日期（2026-13-01 / 2026-02-31 / abc）→ 400", async () => {
    const resource = mount(makeServices());
    for (const date of ["2026-13-01", "2026-02-31", "abc"]) {
      const { status } = await get(resource, `/knowself-api/journal/${date}`);
      expect(status, date).toBe(400);
    }
  });

  it("既有三端点仍 200（重构后人物端点行为不变）", async () => {
    const resource = mount(makeServices());
    expect((await get(resource, "/knowself-api/persons")).status).toBe(200);
    expect((await get(resource, "/knowself-api/person/p1")).status).toBe(200);
    expect((await get(resource, "/knowself-api/person/p1/timeline")).status).toBe(200);
  });

  it("核心层异常（cards.list 抛错）→ 500 + 脱敏 error（不是 503）", async () => {
    const services = makeServices();
    services.profileStore.cards.list = vi.fn(() => {
      throw new Error("boom-core");
    }) as unknown as typeof services.profileStore.cards.list;
    const resource = mount(services);
    const { status, body } = await get(resource, "/knowself-api/cards");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "boom-core" });
  });
});
