/**
 * M3 波 3：`GET /knowself-api/graph`（知识图谱）的契约测试。
 *
 * 桩形状与 `test/routes-m3b.test.ts` / `test/routes-split.test.ts` 同源（桩 webServer +
 * 桩 connection，不触网、不开 DB、不用 vi.mock 整个模块图）。
 *
 * 覆盖（对应波次验收）：
 *   A. **鉴权先于一切**：未认证时即使参数非法 / 路径未知也一律 401，且业务零调用；
 *   B. 已认证 + 有快照 → 200 + `{snapshot, nodes, edges, warnings}`（节点/边是画布投影，
 *      不含 `attrs` 等审计字段）；
 *   C. 已认证 + **无快照** → 200 + `{snapshot:null, nodes:[], edges:[], hint}`（不是 404/503）；
 *   D. 参数错误 → 400：`min_interaction` 非非负整数、`edge_kinds` 空/非法；
 *   E. **参数校验先于层解析**：人物层缺失 + 非法参数 → 400（不是 503）；
 *   F. 人物层缺失 → 503 + `{status:"degraded", layer:"person", reason}`；
 *   G. 未知路径 / 子路径 / 非 GET → 404；
 *   H. 查询参数真实生效：`min_interaction` 过滤掉小节点，`edge_kinds` 过滤掉异类边。
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { GraphSnapshotRow } from "@knowself/person-store";
import type { KnowselfServices } from "../src/services.js";
import { registerKnowselfWebBridge } from "../src/web-bridge.js";

/** 捕获到的 resource 型路由（测试局部形状，不依赖 ambient 契约）。 */
interface CapturedRoute {
  kind: string;
  path: string;
  resource: (request: Request) => Promise<Response>;
}

/**
 * 一份合法的快照载荷（字段与 `GraphSnapshotSchema` 逐字一致；`payload_json` 用
 * `GraphSnapshotSchema.parse` 解析，形状错了这里就会抛）。
 */
const SNAPSHOT_PAYLOAD = {
  graph_version: "1",
  produced_by: "knowself-mining-test",
  generated_at: "2026-05-30T00:00:00.000Z",
  params: {
    algo: "louvain",
    resolution: 1,
    gap_ms: 300000,
    min_edge_strength: 0.05,
    max_pairwise_members: 50,
    time_from: null,
    time_to: null,
  },
  stats: {
    node_count: 2,
    edge_count: 2,
    community_count: 1,
    modularity: 0.42,
    degraded_sessions: 0,
  },
  nodes: [
    {
      id: "p1",
      kind: "person",
      label: "张三",
      ref_id: "p1",
      size_raw: 10,
      size: 0.8,
      community_key: "c:aaaa",
      degree: 1,
      relation_type: "friend",
      isolated: false,
      attrs: { msg_count_other: 5, evidence_ref: [] },
    },
    {
      id: "p2",
      kind: "person",
      label: "李四",
      ref_id: "p2",
      size_raw: 2,
      size: 0.2,
      community_key: "c:aaaa",
      degree: 1,
      relation_type: null,
      isolated: false,
      attrs: { evidence_ref: [] },
    },
  ],
  edges: [
    {
      id: "co_presence:p1|p2",
      source: "p1",
      target: "p2",
      kind: "co_presence",
      weight_raw: 3,
      strength: 0.6,
      directed: false,
      attrs: { co_norm: 0.3, evidence_ref: [] },
    },
    {
      id: "mention:p1|p2",
      source: "p1",
      target: "p2",
      kind: "mention",
      weight_raw: 1,
      strength: 0.2,
      directed: true,
      attrs: { evidence_ref: [] },
    },
  ],
  communities: [
    {
      community_key: "c:aaaa",
      label: "社区 A",
      size: 2,
      member_ids: ["p1", "p2"],
      group_ids: [],
      cohesion: 0.5,
    },
  ],
};

/**
 * 一行快照（`GraphSnapshotRow` 的字段形态，`computed_at` 决定「最新」）。
 * @param payload 载荷对象（默认 {@link SNAPSHOT_PAYLOAD}）
 * @returns 数据库行桩
 */
function snapshotRow(payload: unknown = SNAPSHOT_PAYLOAD): GraphSnapshotRow {
  return {
    snapshot_id: "snap-1",
    graph_kind: "cooccurrence",
    scope_kind: "global",
    scope_id: "",
    time_from: null,
    time_to: null,
    params_json: "{}",
    payload_json: JSON.stringify(payload),
    node_count: 2,
    edge_count: 2,
    community_count: 1,
    produced_by: "knowself-mining-test",
    computed_at: "2026-05-30T00:00:00.000Z",
  } as unknown as GraphSnapshotRow;
}

/** 人物层桩：只实现 mining 读层用到的两个方法（`listPersons` / `metrics.*`）。 */
function makePersonStore(rows: GraphSnapshotRow[]): {
  listPersons: () => [];
  metrics: { list: () => []; listGraphSnapshots: ReturnType<typeof vi.fn> };
} {
  return {
    listPersons: () => [] as [],
    metrics: {
      list: () => [] as [],
      listGraphSnapshots: vi.fn(() => rows),
    },
  };
}

/**
 * 构造领域服务桩。
 * @param options.rows 快照行（空数组 = 尚无快照）
 * @param options.withPersonStore 人物层是否装配（缺省 true）
 */
function makeServices(
  options: { rows?: GraphSnapshotRow[]; withPersonStore?: boolean } = {},
): KnowselfServices {
  const { rows = [snapshotRow()], withPersonStore = true } = options;
  const profileStore = {
    core: { get: vi.fn(() => ({ display_name: "测试用户" })) },
    cards: { list: vi.fn(() => []), get: vi.fn(() => ({ card: {}, sections: [] })) },
    journal: { listDates: vi.fn(() => []), get: vi.fn(() => ({ records: [] })) },
    proposals: { listByStatus: vi.fn(() => []) },
    sources: { list: vi.fn(() => ({ items: [], total: 0 })) },
  };
  const personStore = makePersonStore(rows);
  return (
    withPersonStore
      ? { profileStore, personStore }
      : {
          profileStore,
          degraded: {
            missing: ["person"],
            reasons: ["人物层装配失败（createPersonStore）：密钥未配置"],
          },
        }
  ) as unknown as KnowselfServices;
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

describe("M3C A. 鉴权先于路由 / 参数（未认证一律 401）", () => {
  it("未认证 + /graph（含非法参数、子路径）→ 全部 401，业务零调用", async () => {
    const services = makeServices();
    const resource = mount(services, 401);

    for (const path of [
      "/knowself-api/graph",
      "/knowself-api/graph?min_interaction=abc",
      "/knowself-api/graph?min_interaction=-1",
      "/knowself-api/graph?edge_kinds=bogus",
      "/knowself-api/graph/extra",
    ]) {
      const { status, body } = await get(resource, path);
      expect(status, path).toBe(401);
      // 401 体是固定文案，不泄露路径语义 / 参数校验结论。
      expect(String(body)).not.toContain("bad_request");
      expect(String(body)).not.toContain("not_found");
      expect(String(body)).not.toContain("degraded");
    }

    const personStore = services.personStore as unknown as {
      metrics: { listGraphSnapshots: ReturnType<typeof vi.fn> };
    };
    expect(personStore.metrics.listGraphSnapshots).not.toHaveBeenCalled();
  });
});

describe("M3C B. 已认证 + 有快照 → 200 + 画布投影", () => {
  it("返回 snapshot 元信息 + nodes/edges（不含 attrs 等审计字段）", async () => {
    const services = makeServices();
    const resource = mount(services);

    const { status, body } = await get(resource, "/knowself-api/graph");
    expect(status).toBe(200);

    const payload = body as {
      snapshot: Record<string, unknown>;
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      warnings: unknown[];
    };
    expect(payload.snapshot).toMatchObject({
      graph_version: "1",
      generated_at: "2026-05-30T00:00:00.000Z",
      node_count: 2,
      edge_count: 2,
      community_count: 1,
      modularity: 0.42,
    });
    expect(payload.nodes).toHaveLength(2);
    expect(payload.nodes[0]).toEqual({
      id: "p1",
      label: "张三",
      kind: "person",
      size: 0.8,
      degree: 1,
      isolated: false,
      community_key: "c:aaaa",
      relation_type: "friend",
    });
    // 投影掉审计字段：画布不需要 attrs / ref_id / size_raw
    expect(payload.nodes[0]).not.toHaveProperty("attrs");
    expect(payload.nodes[0]).not.toHaveProperty("size_raw");
    expect(payload.nodes[0]).not.toHaveProperty("ref_id");
    expect(payload.edges).toHaveLength(2);
    expect(payload.edges[0]).toEqual({
      id: "co_presence:p1|p2",
      source: "p1",
      target: "p2",
      kind: "co_presence",
      strength: 0.6,
      directed: false,
    });
    expect(payload.warnings).toEqual([]);

    const personStore = services.personStore as unknown as {
      metrics: { listGraphSnapshots: ReturnType<typeof vi.fn> };
    };
    // 与工具侧同口径：只取 cooccurrence 图的最新快照
    expect(personStore.metrics.listGraphSnapshots).toHaveBeenCalledWith({
      graph_kind: "cooccurrence",
      scope_kind: "global",
      scope_id: "",
    });
  });
});

describe("M3C C. 已认证 + 无快照 → 200 + hint（不是 404 / 503）", () => {
  it("空快照：snapshot=null + 空数组 + 可执行指引，且不画空图", async () => {
    const resource = mount(makeServices({ rows: [] }));

    const { status, body } = await get(resource, "/knowself-api/graph");
    expect(status).toBe(200);
    expect(body).toEqual({
      snapshot: null,
      nodes: [],
      edges: [],
      hint: "暂无图谱快照，需要先在对话里让助手做数据挖掘",
    });
  });
});

describe("M3C D. 参数错误 → 400", () => {
  it("min_interaction 非非负整数 → 400 + {error}，且不查快照", async () => {
    const services = makeServices();
    const resource = mount(services);

    for (const value of ["abc", "-1", "1.5", "", " "]) {
      const { status, body } = await get(
        resource,
        `/knowself-api/graph?min_interaction=${encodeURIComponent(value)}`,
      );
      expect(status, value).toBe(400);
      expect(body).toMatchObject({ error: expect.any(String) as unknown as string });
    }

    const personStore = services.personStore as unknown as {
      metrics: { listGraphSnapshots: ReturnType<typeof vi.fn> };
    };
    expect(personStore.metrics.listGraphSnapshots).not.toHaveBeenCalled();
  });

  it("edge_kinds 空 / 含非法取值 → 400（不静默丢参数）", async () => {
    const services = makeServices();
    const resource = mount(services);

    for (const value of ["", "..", "co_presence,BOGUS", "not_a_kind"]) {
      const { status, body } = await get(
        resource,
        `/knowself-api/graph?edge_kinds=${encodeURIComponent(value)}`,
      );
      expect(status, value).toBe(400);
      expect(body).toMatchObject({ error: expect.any(String) as unknown as string });
    }

    const personStore = services.personStore as unknown as {
      metrics: { listGraphSnapshots: ReturnType<typeof vi.fn> };
    };
    expect(personStore.metrics.listGraphSnapshots).not.toHaveBeenCalled();
  });
});

describe("M3C E. 参数校验先于层解析（400 不得被误报成 503）", () => {
  it("人物层缺失 + min_interaction=abc → 400（不是 503）", async () => {
    const resource = mount(makeServices({ withPersonStore: false }));
    const { status } = await get(resource, "/knowself-api/graph?min_interaction=abc");
    expect(status).toBe(400);
  });
});

describe("M3C F. 人物层缺失 → 503 degraded(person)", () => {
  it("503 + {status:'degraded', layer:'person', reason}（与 /persons 同一文案来源）", async () => {
    const resource = mount(makeServices({ withPersonStore: false }));

    const { status, body } = await get(resource, "/knowself-api/graph");
    expect(status).toBe(503);
    const payload = body as { status: string; layer: string; reason: string };
    expect(payload.status).toBe("degraded");
    expect(payload.layer).toBe("person");
    expect(payload.reason).toContain("人物层");
    // 脱敏：不得回显绝对路径
    expect(payload.reason).not.toContain("C:\\Users");
  });
});

describe("M3C G. 未知路径 / 非 GET → 404", () => {
  it("子路径与 POST 均 404（本波只有只读 GET /graph）", async () => {
    const services = makeServices();
    const resource = mount(services);

    for (const path of ["/knowself-api/graph/extra", "/knowself-api/graph/1"]) {
      const { status, body } = await get(resource, path);
      expect(status, path).toBe(404);
      expect(body, path).toEqual({ error: "not_found" });
    }

    const post = await get(resource, "/knowself-api/graph", "POST");
    expect(post.status).toBe(404);

    const personStore = services.personStore as unknown as {
      metrics: { listGraphSnapshots: ReturnType<typeof vi.fn> };
    };
    expect(personStore.metrics.listGraphSnapshots).not.toHaveBeenCalled();
  });
});

describe("M3C H. 查询参数真实生效", () => {
  it("min_interaction 过滤小节点（p2 size_raw=2 被剔除，相关边一并消失）", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/graph?min_interaction=5");
    expect(status).toBe(200);
    const payload = body as {
      snapshot: { node_count: number; edge_count: number };
      nodes: Array<{ id: string }>;
      edges: unknown[];
    };
    expect(payload.nodes.map((node) => node.id)).toEqual(["p1"]);
    expect(payload.edges).toEqual([]);
    expect(payload.snapshot.node_count).toBe(1);
    expect(payload.snapshot.edge_count).toBe(0);
  });

  it("edge_kinds=mention 只保留 mention 边", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(resource, "/knowself-api/graph?edge_kinds=mention");
    expect(status).toBe(200);
    const payload = body as { edges: Array<{ kind: string }> };
    expect(payload.edges.map((edge) => edge.kind)).toEqual(["mention"]);
  });

  it("edge_kinds 多值（逗号分隔）→ 命中任一即保留", async () => {
    const resource = mount(makeServices());
    const { status, body } = await get(
      resource,
      "/knowself-api/graph?edge_kinds=mention,co_presence",
    );
    expect(status).toBe(200);
    const payload = body as { edges: Array<{ kind: string }> };
    expect(payload.edges).toHaveLength(2);
  });
});

/**
 * A3「未识别」投影（src/routes/graph.ts:130-143）：
 * display_name 恰为 `wxid_xxx` 的 person 节点 = 未识别 → label 改写为 `未识别·末4位`，
 * 并把完整 wxid 条件展开到 `title`；**id / ref_id 不参与改写**（id 原样，ref_id 投影层丢弃）。
 * display_name 正常（非 wxid）的 person 不受影响、**不带 title**。
 */
describe("M3C A3. 未识别 person 节点投影（label 改写 + title 兜底完整 wxid）", () => {
  const A3_PAYLOAD = {
    graph_version: "1",
    produced_by: "knowself-mining-test",
    generated_at: "2026-05-30T00:00:00.000Z",
    params: {
      algo: "louvain",
      resolution: 1,
      gap_ms: 300000,
      min_edge_strength: 0.05,
      max_pairwise_members: 50,
      time_from: null,
      time_to: null,
    },
    stats: { node_count: 2, edge_count: 1, community_count: 1, modularity: 0.3, degraded_sessions: 0 },
    nodes: [
      {
        id: "p-wxid",
        kind: "person",
        label: "wxid_abcd1234",
        ref_id: "p-wxid",
        size_raw: 5,
        size: 0.5,
        community_key: "c:x",
        degree: 1,
        relation_type: null,
        isolated: false,
        attrs: {},
      },
      {
        id: "p-named",
        kind: "person",
        label: "张三",
        ref_id: "p-named",
        size_raw: 5,
        size: 0.5,
        community_key: "c:x",
        degree: 1,
        relation_type: null,
        isolated: false,
        attrs: {},
      },
    ],
    edges: [
      {
        id: "e1",
        source: "p-wxid",
        target: "p-named",
        kind: "co_presence",
        weight_raw: 1,
        strength: 0.5,
        directed: false,
        attrs: {},
      },
    ],
    communities: [
      { community_key: "c:x", label: "X", size: 2, member_ids: ["p-wxid", "p-named"], group_ids: [], cohesion: 0.5 },
    ],
  };

  it("wxid_ person → label `未识别·末4位`、title=完整 wxid、id 不变、ref_id 被投影层丢弃", async () => {
    const resource = mount(makeServices({ rows: [snapshotRow(A3_PAYLOAD)] }));
    const { status, body } = await get(resource, "/knowself-api/graph");
    expect(status).toBe(200);

    const nodes = (body as { nodes: Array<Record<string, unknown>> }).nodes;
    const wxid = nodes.find((n) => n.id === "p-wxid");
    expect(wxid).toBeDefined();
    // label 改写为「未识别·末4位」（wxid_abcd1234 → 1234）
    expect(wxid?.label).toBe("未识别·1234");
    // title 兜底完整 wxid（canvas 2D 无 per-node DOM 时靠原生 title 上屏）
    expect(wxid?.title).toBe("wxid_abcd1234");
    // id 未被改写（仍是原始节点 id，不是 wxid、也不是「未识别·…」）
    expect(wxid?.id).toBe("p-wxid");
    // ref_id 不进入画布 DTO（投影层丢弃、未被拿来改写）
    expect(wxid).not.toHaveProperty("ref_id");
    expect(wxid).not.toHaveProperty("attrs");
  });

  it("反向：display_name 正常（非 wxid）的 person 不改写、**不带 title**", async () => {
    const resource = mount(makeServices({ rows: [snapshotRow(A3_PAYLOAD)] }));
    const { body } = await get(resource, "/knowself-api/graph");

    const nodes = (body as { nodes: Array<Record<string, unknown>> }).nodes;
    const named = nodes.find((n) => n.id === "p-named");
    expect(named?.label).toBe("张三");
    expect(named).not.toHaveProperty("title");
  });
});
