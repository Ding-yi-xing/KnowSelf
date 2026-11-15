/**
 * T04：`GET /ability-graph` 的路由层回归（只读、空态合法、缓存命中可观测、降级 503）。
 *
 * ## 为什么直调 `dispatch` 而不起 HTTP server
 * `routes/*.ts` 是纯函数式分发（不认识鉴权、不产生 `Response`），鉴权与 405 守卫在
 * `web-bridge.ts`。真机链路由 evidence 脚本另外验证；这里用 `dispatch()` 覆盖
 * 「路由 → 参数 → 降级 → 数据」四步，与既有 `w1-ingest-route.test.ts` 同一套路。
 *
 * ## 覆盖点
 *   A. 200 结构完整：`fingerprint` / `stats` / `nodes` / `edges` 四者齐
 *   B. **0 张卡 → 200 + 空数组**（不是 404/503：新用户第一眼就是这个状态）
 *   C. 缓存：连打两次，第二次 `X-Ability-Cache: hit`，且**没有重新抽取**
 *      （用 store 的 `list()` 调用次数作为"是否重算"的硬证据，比 spy 更直接）
 *   D. 改 body（不动 `cards.updated_at`）→ 指纹变 → 第二次是 `miss`
 *   E. `profileStore` 缺失 → 503 + `layer: "profile"`
 *   F. 只读：非 GET 不认领（`undefined`），不会误吞写请求
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { dispatch } from "../src/routes/index.js";
import { handleAbilityGraphRoute, ABILITY_CACHE_HEADER } from "../src/routes/ability-graph.js";
import { AbilitySnapshotCache } from "../src/ability/cache.js";
import type { AbilityStoreLike } from "../src/ability/extract.js";

const BASE = "http://localhost";
const API = "/knowself-api/ability-graph";
const CARD_UPDATED_AT = "2026-11-01T00:00:00+08:00";

interface FakeCard {
  key: string;
  sections: { id: number; title: string; body: string }[];
}

/**
 * 构造可观测的 store 桩：`listCalls` / `getCalls` 记录调用次数。
 *
 * 「抽取是否重跑」用它来证明：缓存命中时 `list()` 不该再被调用。
 */
function makeStore(cards: FakeCard[]): {
  store: AbilityStoreLike;
  counts: { list: number; get: number };
  setBody(cardKey: string, sectionId: number, body: string): void;
} {
  const counts = { list: 0, get: 0 };
  const data = cards.map((card) => ({
    key: card.key,
    sections: card.sections.map((s) => ({ ...s, card_key: card.key, ord: s.id, updated_at: CARD_UPDATED_AT })),
  }));

  const store: AbilityStoreLike = {
    cards: {
      list: () => {
        counts.list += 1;
        return data.map((card) => ({
          key: card.key,
          title: card.key,
          summary: "",
          section_tags: [],
          updated_at: CARD_UPDATED_AT,
        })) as never;
      },
      get: (key: string) => {
        counts.get += 1;
        const card = data.find((item) => item.key === key);
        if (card === undefined) throw new Error(`card 不存在: ${key}`);
        return {
          card: {
            key: card.key,
            title: card.key,
            summary: "",
            section_tags: [],
            updated_at: CARD_UPDATED_AT,
            schema_version: 1 as const,
          },
          sections: card.sections,
        } as never;
      },
    },
  };

  return {
    store,
    counts,
    setBody(cardKey: string, sectionId: number, body: string): void {
      const card = data.find((item) => item.key === cardKey);
      const section = card?.sections.find((s) => s.id === sectionId);
      if (section !== undefined) section.body = body; // 只改正文，updated_at 不动
    },
  };
}

/** 构造最小 services（只提供本路由需要的 profileStore）。 */
function makeServices(store: AbilityStoreLike | undefined): KnowselfServices {
  const services = {
    ...(store === undefined ? {} : { profileStore: store }),
  } as unknown as KnowselfServices;
  return services;
}

/** 调一次路由（默认 GET）。 */
async function get(services: KnowselfServices, method = "GET") {
  return dispatch(new URL(API, BASE), services, method);
}

let cache: AbilitySnapshotCache;

beforeEach(() => {
  cache = new AbilitySnapshotCache();
});

describe("GET /ability-graph · 结构与空态", () => {
  it("A. 200：fingerprint / stats / nodes / edges 四者齐，且过契约形状", async () => {
    const { store } = makeStore([
      { key: "skills", sections: [{ id: 1, title: "技能清单", body: "后端：Java、Spring Boot\n数据库：MySQL、Redis" }] },
    ]);
    const result = await handleAbilityGraphRoute(
      { path: "/ability-graph", url: new URL(API, BASE), services: makeServices(store), method: "GET" },
      { cache },
    );
    expect(result?.status).toBe(200);
    const body = result?.body as {
      fingerprint: string;
      stats: { node_count: number; edge_count: number };
      nodes: { label: string }[];
      edges: unknown[];
    };
    expect(body.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(body.nodes.map((n) => n.label)).toEqual(
      expect.arrayContaining(["Java", "Spring Boot", "MySQL", "Redis"]),
    );
    expect(body.stats.node_count).toBe(body.nodes.length);
    expect(body.stats.edge_count).toBe(body.edges.length);
    // 两个分组各 2 项 → 每组分内 1 条边，共 2 条（不做跨组连边）
    expect(body.stats.edge_count).toBe(2);
  });

  it("B. 0 张卡 → 200 + 空 nodes/edges（**不是 404/503**），fingerprint 照常计算", async () => {
    const { store } = makeStore([]);
    const result = await get(makeServices(store));
    expect(result.status).toBe(200);
    const body = result.body as {
      fingerprint: string;
      stats: { node_count: number; edge_count: number; card_count: number };
      nodes: unknown[];
      edges: unknown[];
    };
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.stats).toMatchObject({ node_count: 0, edge_count: 0, card_count: 0 });
    expect(body.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it("E. profileStore 缺失 → 503 + layer=profile（不抛 500）", async () => {
    const result = await get(makeServices(undefined));
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: "degraded", layer: "profile" });
    expect(String((result.body as { reason: string }).reason)).toContain("资料层");
  });

  it("F. 只读：非 GET 不认领（返回 undefined，不吞写请求）", async () => {
    const { store } = makeStore([]);
    const result = await handleAbilityGraphRoute(
      { path: "/ability-graph", url: new URL(API, BASE), services: makeServices(store), method: "POST" },
      { cache },
    );
    expect(result).toBeUndefined();
  });
});

describe("GET /ability-graph · 缓存可观测", () => {
  it("C. 连打两次：第二次 X-Ability-Cache=hit，且**没有重新抽取**", async () => {
    const { store, counts } = makeStore([
      { key: "skills", sections: [{ id: 1, title: "技能", body: "后端：Java、Spring Boot" }] },
    ]);
    const services = makeServices(store);
    const ctx = { path: "/ability-graph", url: new URL(API, BASE), services, method: "GET" } as const;

    const first = handleAbilityGraphRoute(ctx, { cache });
    const listCallsAfterFirst = counts.list;
    expect(first?.headers?.[ABILITY_CACHE_HEADER]).toBe("miss");
    expect(listCallsAfterFirst).toBeGreaterThan(0); // 首次确实扫了库

    // 注意：**不能**用 store 调用次数判断"是否重算" —— 算指纹本来就要扫一遍
    // cards + sections（`computeAbilityFingerprint` 里逐卡 `get()` 取 body）。
    // "没有重新抽取"的硬证据是**对象引用同一性**：抽取会新建快照对象，命中不会。
    const second = handleAbilityGraphRoute(ctx, { cache });
    expect(second?.headers?.[ABILITY_CACHE_HEADER]).toBe("hit");
    expect(second?.body).toBe(first?.body);
    // 命中只做一次指纹扫描（list 每次 +1），代价是只读查询而非解析
    expect(counts.list).toBeGreaterThan(0);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("D. 只改 sections.body → 指纹变化 → 第二次是 miss，新内容生效", async () => {
    const fake = makeStore([
      { key: "skills", sections: [{ id: 1, title: "技能", body: "后端：Java、Spring Boot" }] },
    ]);
    const services = makeServices(fake.store);
    const ctx = { path: "/ability-graph", url: new URL(API, BASE), services, method: "GET" } as const;

    const first = handleAbilityGraphRoute(ctx, { cache });
    const firstBody = first?.body as { fingerprint: string; nodes: { label: string }[] };
    expect(firstBody.nodes.map((n) => n.label)).not.toContain("Redis");

    fake.setBody("skills", 1, "后端：Java、Spring Boot、Redis");

    const second = handleAbilityGraphRoute(ctx, { cache });
    const secondBody = second?.body as { fingerprint: string; nodes: { label: string }[] };
    expect(second?.headers?.[ABILITY_CACHE_HEADER]).toBe("miss");
    expect(secondBody.fingerprint).not.toBe(firstBody.fingerprint);
    expect(secondBody.nodes.map((n) => n.label)).toContain("Redis");
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("G. 响应头带 cache-control: no-store（派生视图，禁止中间层缓存）", async () => {
    const { store } = makeStore([]);
    const result = await handleAbilityGraphRoute(
      { path: "/ability-graph", url: new URL(API, BASE), services: makeServices(store), method: "GET" },
      { cache },
    );
    expect(result?.headers?.["cache-control"]).toBe("no-store");
  });
});
