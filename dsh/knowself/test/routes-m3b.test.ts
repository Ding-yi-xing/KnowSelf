/**
 * M3 波 2：`/proposals`（待整理）与 `/sources`（资料）两个只读端点的契约测试。
 *
 * 桩形状与 `test/routes-split.test.ts` / `test/web-bridge.test.ts` 同源（桩 webServer +
 * 桩 connection，不触网、不开 DB、不用 vi.mock 整个模块图）。
 *
 * 覆盖（对应波次验收）：
 *   A. **鉴权先于一切**：未认证时即使参数非法 / 路径未知也一律 401，且业务零调用；
 *   B. 已认证：200 数组形状、缺省 status=pending、limit/offset/status 透传；
 *   C. 参数错误：status / limit / offset 非法 → 400 `{error:"bad_request"}`（业务零调用）；
 *   D. 未知路径 → 404 `{error:"not_found"}`；非 GET → 404；
 *   E. `layer=L1` 语义修正 → 400 `{error:"unsupported_layer"}`（技术债修复的端到端断言）；
 *   F. 核心层异常 → 500 + 脱敏 error（不造 503）。
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

/** 一条待整理提案桩（字段与领域库 `IngestionProposal` 一致）。 */
const PROPOSAL_PENDING = {
  id: "11111111-1111-4111-8111-111111111111",
  source_id: "22222222-2222-4222-8222-222222222222",
  target: { kind: "card_section", card_key: "skills", section: "职业" },
  proposed_body: "新增：Go 后端经验（两年）",
  reasoning: "资料中提到 Go 项目",
  source_excerpts: [{ start: 0, end: 120 }],
  produced_by_provider: "deepseek-chat",
  status: "pending",
  user_edited_body: null,
  created_at: "2026-05-30T08:00:00.000Z",
  decided_at: null,
};

/** 一条资料桩（字段与领域库 `SourceStored` 一致）。 */
const SOURCE_ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "file",
  original_name: "简历.pdf",
  mime_type: "application/pdf",
  file_path: "sources/22222222.pdf",
  url: null,
  extracted_text: "一段很长的简历文本",
  truncated: false,
  char_count: 1200,
  user_note: "",
  user_tags: ["简历"],
  status: "pending_review",
  metadata: {},
  created_at: "2026-05-30T08:00:00.000Z",
  last_ingested_at: "2026-05-30T09:00:00.000Z",
  last_error: null,
};

/** L2 卡片摘要桩（仅供 `layer=L1` 的 400 断言顺带验证「取数未被触碰」）。 */
const CARD_L2 = {
  key: "skills",
  title: "技能",
  summary: "后端开发",
  section_tags: [],
  updated_at: "2026-05-30T00:00:00.000Z",
};

/**
 * 构造领域服务桩：核心层含 `proposals` / `sources` 两个仓储（人物层不参与本组断言）。
 */
function makeServices(): KnowselfServices {
  const profileStore = {
    core: { get: vi.fn(() => ({ display_name: "测试用户" })) },
    cards: { list: vi.fn(() => [CARD_L2]), get: vi.fn(() => ({ card: CARD_L2, sections: [] })) },
    journal: { listDates: vi.fn(() => []), get: vi.fn((date: string) => ({ date, records: [] })) },
    proposals: { listByStatus: vi.fn((_status: string, _limit?: number) => [PROPOSAL_PENDING]) },
    sources: {
      list: vi.fn((_query: unknown) => ({ items: [SOURCE_ROW], total: 1 })),
    },
  };
  return { profileStore } as unknown as KnowselfServices;
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

/** 一次请求（默认 GET）。 */
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

describe("M3B A. 鉴权先于路由 / 参数（未认证一律 401）", () => {
  it("未认证 + 两个新端点（含非法参数 / 未知子路径）→ 全部 401，业务零调用", async () => {
    const services = makeServices();
    const resource = mount(services, 401);

    for (const path of [
      "/knowself-api/proposals",
      "/knowself-api/proposals?status=BOGUS",
      "/knowself-api/proposals/extra",
      "/knowself-api/sources",
      "/knowself-api/sources?limit=-1",
      "/knowself-api/sources?status=BOGUS",
    ]) {
      const { status, body } = await get(resource, path);
      expect(status, path).toBe(401);
      // 401 体是固定文案，不泄露路径语义 / 参数校验结论。
      expect(String(body)).not.toContain("bad_request");
      expect(String(body)).not.toContain("not_found");
    }

    expect(services.profileStore.proposals.listByStatus).not.toHaveBeenCalled();
    expect(services.profileStore.sources.list).not.toHaveBeenCalled();
  });
});

describe("M3B B. 已认证：200 数组 + 参数透传", () => {
  it("GET /proposals 缺省 status=pending（待整理语义）", async () => {
    const services = makeServices();
    const resource = mount(services);

    const { status, body } = await get(resource, "/knowself-api/proposals");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([PROPOSAL_PENDING]);
    expect(services.profileStore.proposals.listByStatus).toHaveBeenCalledWith("pending");
  });

  it("GET /proposals?status=processing|accepted|edited|rejected → 透传对应状态", async () => {
    for (const status of ["processing", "accepted", "edited", "rejected"]) {
      const services = makeServices();
      const resource = mount(services);
      const res = await get(resource, `/knowself-api/proposals?status=${status}`);
      expect(res.status, status).toBe(200);
      expect(res.body).toEqual([PROPOSAL_PENDING]);
      expect(services.profileStore.proposals.listByStatus).toHaveBeenCalledWith(status);
    }
  });

  it("GET /sources 缺省 limit=50 / offset=0（与领域库缺省一致），返回 items 数组", async () => {
    const services = makeServices();
    const resource = mount(services);

    const { status, body } = await get(resource, "/knowself-api/sources");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([SOURCE_ROW]);
    expect(services.profileStore.sources.list).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it("GET /sources?limit=2&offset=1&status=completed → 三个参数原样透传", async () => {
    const services = makeServices();
    const resource = mount(services);

    const { status } = await get(
      resource,
      "/knowself-api/sources?limit=2&offset=1&status=completed",
    );
    expect(status).toBe(200);
    expect(services.profileStore.sources.list).toHaveBeenCalledWith({
      limit: 2,
      offset: 1,
      status: "completed",
    });
  });
});

describe("M3B C. 参数错误 → 400 {error:'bad_request'}（取数零调用）", () => {
  it("GET /proposals?status=非法 → 400 bad_request，不查库", async () => {
    const services = makeServices();
    const resource = mount(services);

    for (const bad of ["BOGUS", "PENDING", "", "all"]) {
      const { status, body } = await get(
        resource,
        `/knowself-api/proposals?status=${encodeURIComponent(bad)}`,
      );
      expect(status, bad).toBe(400);
      expect(body).toEqual({ error: "bad_request" });
    }
    expect(services.profileStore.proposals.listByStatus).not.toHaveBeenCalled();
  });

  it("GET /sources?status=非法 / limit 非非负整数 / offset 同 → 400 bad_request", async () => {
    const services = makeServices();
    const resource = mount(services);

    for (const path of [
      "/knowself-api/sources?status=BOGUS",
      "/knowself-api/sources?limit=-1",
      "/knowself-api/sources?limit=1.5",
      "/knowself-api/sources?limit=",
      "/knowself-api/sources?offset=-3",
      "/knowself-api/sources?offset=abc",
    ]) {
      const { status, body } = await get(resource, path);
      expect(status, path).toBe(400);
      expect(body, path).toEqual({ error: "bad_request" });
    }
    expect(services.profileStore.sources.list).not.toHaveBeenCalled();
  });
});

describe("M3B D. 未知路径 / 非 GET → 404", () => {
  it("子路径不匹配（/proposals/extra、/sources/x）→ 404 not_found", async () => {
    const resource = mount(makeServices());
    for (const path of ["/knowself-api/proposals/extra", "/knowself-api/sources/x"]) {
      const { status, body } = await get(resource, path);
      expect(status, path).toBe(404);
      expect(body).toEqual({ error: "not_found" });
    }
  });

  it("非 GET（POST /proposals、POST /sources）→ 404（本波不做写端点）", async () => {
    const services = makeServices();
    const resource = mount(services);
    for (const path of ["/knowself-api/proposals", "/knowself-api/sources"]) {
      const { status } = await get(resource, path, "POST");
      expect(status, path).toBe(404);
    }
    expect(services.profileStore.proposals.listByStatus).not.toHaveBeenCalled();
    expect(services.profileStore.sources.list).not.toHaveBeenCalled();
  });
});

describe("M3B E. layer 语义修正：L1 → 400 unsupported_layer", () => {
  it("GET /cards?layer=L1 → 400 + hint 指向 /profile/core，且不取卡片数据", async () => {
    const services = makeServices();
    const resource = mount(services);

    const { status, body } = await get(resource, "/knowself-api/cards?layer=L1");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "unsupported_layer", hint: "L1 由 /profile/core 提供" });
    expect(services.profileStore.cards.list).not.toHaveBeenCalled();
  });

  it("GET /cards?layer=L2 与省略 layer 等价 → 200 全部卡片", async () => {
    const services = makeServices();
    const resource = mount(services);

    expect((await get(resource, "/knowself-api/cards?layer=L2")).body).toEqual([CARD_L2]);
    expect((await get(resource, "/knowself-api/cards")).body).toEqual([CARD_L2]);
  });
});

describe("M3B F. 核心层异常 → 500（不造 503，错误脱敏）", () => {
  it("proposals.listByStatus 抛错 → 500 + 脱敏 error", async () => {
    const services = makeServices();
    services.profileStore.proposals.listByStatus = vi.fn(() => {
      throw new Error("boom-proposals");
    }) as unknown as typeof services.profileStore.proposals.listByStatus;
    const resource = mount(services);

    const { status, body } = await get(resource, "/knowself-api/proposals");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "boom-proposals" });
  });

  it("sources.list 抛错 → 500 + 脱敏 error（绝对路径被抹掉）", async () => {
    const services = makeServices();
    services.profileStore.sources.list = vi.fn(() => {
      throw new Error("open failed: C:\\Users\\someone\\data\\profile.sqlite");
    }) as unknown as typeof services.profileStore.sources.list;
    const resource = mount(services);

    const { status, body } = await get(resource, "/knowself-api/sources");
    expect(status).toBe(500);
    expect(String((body as { error: string }).error)).not.toContain("C:\\Users");
    expect(String((body as { error: string }).error)).toContain("[路径已省略]");
  });
});
