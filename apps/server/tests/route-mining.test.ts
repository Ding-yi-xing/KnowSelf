/**
 * route-mining.test.ts — mining 只读路由集成测试（exec plan 7c-3）
 *
 * 覆盖 DESIGN-12 §8.5 的 R1~R4 四条路由。**经 `createApp` 真实挂载**（非单挂 router），
 * 以同时验证三件事：`app.ts` 的 `/api/mining` 挂载、`onError` 的 422 映射、以及
 * `routes/mining.ts` 自建查询解析的实际行为。
 *
 * §8.5 的三条横向约束在本文件逐条落地：
 *  1. **只读 + 幂等**：R1~R3 不写库（fake store 只实现读方法，结构上无法写）；
 *     R4 `write:false` 不落盘（`written: []` / `outDir: null`）。
 *  2. **R1 必须启用 gzip**（DESIGN-17 §1.1）：断言 `Content-Encoding` 与解压后等价。
 *  3. **path 不得自造**：全部用例直接打 §8.5 的 path。
 *
 * store 用内存 fake 实现 `MiningExportStore`。真实库路径已由 `packages/mining` 的
 * `integration-mining.test.ts`（真实 `persons.sqlite`）覆盖；本文件专测 HTTP 边界与
 * 参数解析——尤其是 `routes/mining.ts` **自建 `readQuery` 而非复用 `zValidate`** 的
 * 两个理由（重复键数组、小数数字强转），它们是本层最容易被改坏的地方。
 *
 * ⚠️ R4 的 `write` 默认 `true`，而路由**不暴露 `outDir`**（§8.5 入参只有
 * `format / export_kind / scope / range`）→ 省略 `write:false` 会把导出写进仓库
 * `data/mining/exports/`。本文件所有 R4 用例一律显式传 `write:false`。
 */

import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import type {
  ChatConversationRow,
  GraphSnapshotRow,
  MetricRow,
  PersonRow,
} from "@knowself/person-store";
import {
  RANKING_TOP_MAX,
  SCORE_FEATURES,
  WARN_EXPORT_QUALITY_PARTIAL,
  WARN_EXPORT_RANKING_BREAKDOWN_MISSING,
  WARN_RANKING_INCOMPLETE_ROWS,
  WARN_RANKING_TIME_RANGE_UNSUPPORTED,
  type MiningExportStore,
} from "@knowself/mining";
import { createApp } from "../src/app";
import { createRuntime, type Runtime } from "../src/runtime";
import { WARN_GRAPH_TIME_RANGE_UNSUPPORTED } from "../src/routes/mining";

// ── fixture ─────────────────────────────────────────────────────────────────

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";

function person(
  person_id: string,
  display_name: string,
  subject_kind: PersonRow["subject_kind"] = "contact",
): PersonRow {
  return {
    person_id,
    subject_kind,
    display_name,
    remark: "",
    sort_key: display_name,
    avatar_ref: null,
    status: "active",
    merged_into: null,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: 0,
    conv_count: 0,
    profile_json: "{}",
    manual_locked: false,
    created_at: T0,
    updated_at: T0,
  };
}

function metric(
  person_id: string,
  metric_key: string,
  metric_value: number,
  extra: Partial<MetricRow> = {},
): MetricRow {
  return {
    metric_id: `${person_id}|${metric_key}`,
    person_id,
    scope_kind: "global",
    scope_id: "",
    period: "all",
    period_key: "",
    metric_key,
    metric_value,
    metric_value_json: null,
    metric_unit: "",
    computed_at: T0,
    produced_by: "mining:metrics-v1",
    source_ref: "",
    evidence_count: 0,
    manual_locked: false,
    ...extra,
  };
}

/** §4.5 图谱快照载荷（满足 `GraphSnapshotSchema`：`attrs` 为必填且 `.strict()`）。 */
const graphPayload = {
  graph_version: "graph-v1",
  produced_by: "mining:graph-v1",
  generated_at: T0,
  params: {
    algo: "louvain",
    resolution: 1,
    gap_ms: 1_800_000,
    min_edge_strength: 0.05,
    max_pairwise_members: 50,
    time_from: null,
    time_to: null,
  },
  stats: {
    node_count: 3,
    edge_count: 2,
    community_count: 1,
    modularity: 0.42,
    degraded_sessions: 0,
  },
  nodes: [
    {
      id: "me",
      kind: "person",
      label: "我",
      ref_id: "me",
      size_raw: 100,
      size: 1,
      community_key: "c:core",
      degree: 1,
      relation_type: "self",
      isolated: false,
      attrs: {},
    },
    {
      id: "p1",
      kind: "person",
      label: "张三",
      ref_id: "p1",
      size_raw: 60,
      size: 0.6,
      community_key: "c:core",
      degree: 1,
      relation_type: "friend",
      isolated: false,
      attrs: { msg_count_other: 60 },
    },
    {
      id: "g1",
      kind: "group",
      label: "项目群",
      ref_id: "g1",
      size_raw: 20,
      size: 0.2,
      community_key: null,
      degree: 2,
      relation_type: null,
      isolated: false,
      attrs: {},
    },
  ],
  edges: [
    {
      id: "co_presence:g1|p1",
      source: "g1",
      target: "p1",
      kind: "co_presence",
      weight_raw: 20,
      strength: 0.4,
      directed: false,
      attrs: { co_norm: 0.3 },
    },
    {
      id: "membership:g1|me",
      source: "g1",
      target: "me",
      kind: "membership",
      weight_raw: 50,
      strength: 0.9,
      directed: false,
      attrs: {},
    },
  ],
  communities: [
    {
      community_key: "c:core",
      label: "核心圈",
      size: 2,
      member_ids: ["me", "p1"],
      group_ids: [],
      cohesion: 0.7,
    },
  ],
};

function snapshotRow(
  snapshot_id: string,
  computed_at: string,
  payload: unknown = graphPayload,
): GraphSnapshotRow {
  return {
    snapshot_id,
    graph_kind: "cooccurrence",
    scope_kind: "global",
    scope_id: "",
    time_from: null,
    time_to: null,
    params_json: "{}",
    payload_json: JSON.stringify(payload),
    node_count: 3,
    edge_count: 2,
    community_count: 1,
    produced_by: "mining:graph-v1",
    computed_at,
  };
}

function conversation(
  conversation_id: string,
  kind: ChatConversationRow["kind"],
  title: string,
): ChatConversationRow {
  return {
    conversation_id,
    platform: "wechat",
    kind,
    title,
    owner_person_id: "me",
    member_count: kind === "group" ? 12 : 2,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: 0,
    source_ref: "",
    created_at: T0,
    updated_at: T0,
  };
}

const PERSONS = [person("me", "我", "self"), person("p1", "张三"), person("p2", "李四")];
const CONVERSATIONS = [
  conversation("c-dm", "direct", "与张三的会话"),
  conversation("g1", "group", "项目群"),
];

/**
 * 默认数据：p1 / p2 有完整价值行（可进榜），p1 另有一条 `day` 周期指标供 R2 筛选。
 * `metric_value_json` 让 R4 的 breakdown 可解析（否则触发缺失告警）。
 */
function defaultData() {
  return {
    persons: PERSONS,
    snapshots: [snapshotRow("s-old", T0), snapshotRow("s-new", T1)],
    conversations: CONVERSATIONS,
    metrics: [
      metric("p1", "value_score", 0.8, { metric_value_json: '{"f_frequency":0.9}' }),
      metric("p1", "value_rank", 1),
      metric("p2", "value_score", 0.5, { metric_value_json: '{"f_frequency":0.4}' }),
      metric("p2", "value_rank", 2),
      metric("p1", "msg_frequency", 42, {
        period: "day",
        period_key: "2026-01-15",
      }),
    ],
    messageCount: 120,
  };
}

type FakeData = ReturnType<typeof defaultData>;

/**
 * §6.3 的 `value_score_breakdown.metric_value_json`：**8 个特征缺一即视为无效**
 * （`parseBreakdown` 逐键校验 `norm` / `weight` / `contrib` 均为 number）。
 */
function breakdownJson(): string {
  return JSON.stringify(
    Object.fromEntries(
      SCORE_FEATURES.map((key) => [key, { raw: 1, norm: 0.5, weight: 0.125, contrib: 0.0625 }]),
    ),
  );
}

/** 给 p1 / p2 补上合法的 breakdown 行 → `assembleRanking` 不再计入 missingBreakdown。 */
function withBreakdown(data: FakeData): FakeData {
  return {
    ...data,
    metrics: [
      ...data.metrics,
      metric("p1", "value_score_breakdown", 0, { metric_value_json: breakdownJson() }),
      metric("p2", "value_score_breakdown", 0, { metric_value_json: breakdownJson() }),
    ],
  };
}

// ── fake store（只实现读方法——结构上无法写库，即 §8.5「只读」）─────────────

function makeStore(data: FakeData = defaultData()): MiningExportStore {
  return {
    listPersons: (q) =>
      q?.status === undefined
        ? [...data.persons]
        : data.persons.filter((row) => row.status === q.status),
    metrics: {
      list: (q) =>
        data.metrics.filter((row) => {
          if (q.person_id !== undefined && row.person_id !== q.person_id) return false;
          if (q.scope_kind !== undefined && row.scope_kind !== q.scope_kind) return false;
          if (q.scope_id !== undefined && row.scope_id !== q.scope_id) return false;
          if (q.period !== undefined && row.period !== q.period) return false;
          if (q.period_key !== undefined && row.period_key !== q.period_key) return false;
          if (q.metric_keys !== undefined && !q.metric_keys.includes(row.metric_key)) return false;
          return true;
        }),
      listGraphSnapshots: (q) => {
        const rows = data.snapshots.filter((row) => {
          if (q?.graph_kind !== undefined && row.graph_kind !== q.graph_kind) return false;
          if (q?.scope_kind !== undefined && row.scope_kind !== q.scope_kind) return false;
          if (q?.scope_id !== undefined && row.scope_id !== q.scope_id) return false;
          return true;
        });
        return q?.limit === undefined ? rows : rows.slice(0, q.limit);
      },
    },
    conversations: {
      list: (q) =>
        q?.kind === undefined
          ? [...data.conversations]
          : data.conversations.filter((row) => row.kind === q.kind),
    },
    messages: { count: () => data.messageCount },
  };
}

function appWith(store: MiningExportStore) {
  const runtime: Runtime = createRuntime({
    personStore: store as unknown as Runtime["personStore"],
  });
  return createApp(runtime);
}

function url(path: string, params: Record<string, string | string[]> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.append(key, value);
    }
  }
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

// ── R1 GET /api/mining/graph ────────────────────────────────────────────────

describe("R1 GET /api/mining/graph", () => {
  it("无过滤参数时返回该 scope 的最新快照，且不加告警", async () => {
    const res = await appWith(makeStore()).request("/api/mining/graph");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { snapshot: typeof graphPayload; warnings: string[] };
    // §4.6「最新快照」= computed_at 最大者 → s-new(T1) 胜出；两快照载荷同构，
    // 故用 stats 与节点度数验证「原样透传、不重算」。
    expect(body.snapshot.graph_version).toBe("graph-v1");
    expect(body.snapshot.nodes).toHaveLength(3);
    expect(body.snapshot.edges).toHaveLength(2);
    expect(body.snapshot.stats).toEqual(graphPayload.stats);
    expect(body.snapshot.nodes[0]!.degree).toBe(1);
    expect(body.warnings).toEqual([]);
  });

  it("该 scope 无快照 → 404 NOT_FOUND，而非空图", async () => {
    const res = await appWith(makeStore({ ...defaultData(), snapshots: [] })).request(
      "/api/mining/graph",
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
  });

  it("snapshot_id 显式命中优先于「最新」约定（可取到历史快照）", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/graph", { snapshot_id: "s-old" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: { graph_version: string } };
    expect(body.snapshot.graph_version).toBe("graph-v1");
  });

  it("snapshot_id 不存在 → 404（不静默回落最新）", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/graph", { snapshot_id: "nope" }),
    );
    expect(res.status).toBe(404);
  });

  it("relation_types[] 走诱导子图：非 person 节点被剔除，degree/isolated/stats 重算", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/graph", { relation_types: "friend" }),
    );
    expect(res.status).toBe(200);

    const { snapshot } = (await res.json()) as {
      snapshot: {
        nodes: Array<{ id: string; degree: number; isolated: boolean }>;
        edges: unknown[];
        communities: Array<{ community_key: string; member_ids: string[]; size: number }>;
        stats: { node_count: number; edge_count: number; community_count: number };
      };
    };

    // 只有 p1 的 relation_type === 'friend'；me('self') 与 group(null) 均被剔除
    expect(snapshot.nodes.map((n) => n.id)).toEqual(["p1"]);
    // 边的两端必须都在保留集内 → 两条边全断
    expect(snapshot.edges).toEqual([]);
    // 视图量重算：p1 失去全部边
    expect(snapshot.nodes[0]!.degree).toBe(0);
    expect(snapshot.nodes[0]!.isolated).toBe(true);
    expect(snapshot.stats).toMatchObject({ node_count: 1, edge_count: 0, community_count: 1 });
    // 社区成员按保留集裁剪后 size 同步收缩（否则 M11 会渲染「社区 2 人、图上 1 人」）
    expect(snapshot.communities[0]!.member_ids).toEqual(["p1"]);
    expect(snapshot.communities[0]!.size).toBe(1);
  });

  it("min_strength=0.5 走小数解析并筛边（回归：`zValidate` 的 /^\\d+$/ 会把它转成 NaN）", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/graph", { min_strength: "0.5" }),
    );
    expect(res.status).toBe(200);

    const { snapshot } = (await res.json()) as {
      snapshot: { edges: Array<{ id: string }>; nodes: Array<{ id: string; degree: number }> };
    };
    // 0.4 的 co_presence 被筛掉，0.9 的 membership 保留
    expect(snapshot.edges.map((e) => e.id)).toEqual(["membership:g1|me"]);
    // 保留边重算度数：p1 归零、g1/me 各 1
    expect(snapshot.nodes.find((n) => n.id === "p1")!.degree).toBe(0);
    expect(snapshot.nodes.find((n) => n.id === "g1")!.degree).toBe(1);
  });

  it("edge_kinds[] 按边 kind 过滤（§8.1 标为加法式，§8.5 参数表未列 → ISS-005）", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/graph", { edge_kinds: "membership" }),
    );
    expect(res.status).toBe(200);
    const { snapshot } = (await res.json()) as { snapshot: { edges: Array<{ kind: string }> } };
    expect(snapshot.edges.map((e) => e.kind)).toEqual(["membership"]);
  });

  it("重复键与逗号两种数组写法等价（回归：`zValidate` 折叠 searchParams 只剩最后一个）", async () => {
    const app = appWith(makeStore());
    const repeated = await app.request(
      url("/api/mining/graph", { edge_kinds: ["membership", "co_presence"] }),
    );
    const comma = await app.request(
      url("/api/mining/graph", { edge_kinds: "membership,co_presence" }),
    );
    expect(repeated.status).toBe(200);
    expect(comma.status).toBe(200);
    expect(await repeated.text()).toBe(await comma.text());
  });

  it("非法参数 → 422 VALIDATION（非 500）", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/graph", { min_strength: "1.5" }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDATION");
  });

  it("from / to 无设计口径（ISS-008）→ 仅告警，不参与筛选", async () => {
    const app = appWith(makeStore());
    const plain = await app.request("/api/mining/graph");
    const ranged = await app.request(
      url("/api/mining/graph", { from: "2026-01-01", to: "2026-12-31" }),
    );
    expect(ranged.status).toBe(200);

    const body = (await ranged.json()) as { snapshot: unknown; warnings: string[] };
    expect(body.warnings).toContain(WARN_GRAPH_TIME_RANGE_UNSUPPORTED);
    // 快照与不带 from/to 时一致 → 证明未参与筛选
    expect(body.snapshot).toEqual(((await plain.json()) as { snapshot: unknown }).snapshot);
  });

  it("R1 幂等：两次请求响应逐字节一致（§8.5 只读 + 幂等）", async () => {
    const app = appWith(makeStore());
    const first = await app.request("/api/mining/graph");
    const second = await app.request("/api/mining/graph");
    expect(await first.text()).toBe(await second.text());
  });

  // ── gzip（DESIGN-17 §1.1 强制项）──────────────────────────────────────────

  it("Accept-Encoding: gzip → 带 Content-Encoding: gzip，解压后与未压缩版等价", async () => {
    const app = appWith(makeStore());
    const plain = await app.request("/api/mining/graph");
    const plainText = await plain.text();
    expect(plain.headers.get("Content-Encoding")).toBeNull();

    const zipped = await app.request("/api/mining/graph", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(zipped.headers.get("Content-Encoding")).toBe("gzip");

    const inflated = gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString("utf8");
    expect(inflated).toBe(plainText);
  });

  it("Accept-Encoding 不含 gzip → 不压缩", async () => {
    const res = await appWith(makeStore()).request("/api/mining/graph", {
      headers: { "Accept-Encoding": "br" },
    });
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });
});

// ── R2 GET /api/mining/persons/:id/metrics ──────────────────────────────────

describe("R2 GET /api/mining/persons/:id/metrics", () => {
  it("返回该人的指标行（默认不按周期筛选）", async () => {
    const res = await appWith(makeStore()).request("/api/mining/persons/p1/metrics");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { person_id: string; rows: Array<{ metric_key: string }> };
    expect(body.person_id).toBe("p1");
    expect(body.rows.map((r) => r.metric_key).sort()).toEqual([
      "msg_frequency",
      "value_rank",
      "value_score",
    ]);
  });

  it("人存在但无指标 → 200 + 空数组（§8.5-R2：不是 404）", async () => {
    const res = await appWith(makeStore()).request("/api/mining/persons/nobody/metrics");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ person_id: "nobody", rows: [] });
  });

  it("period / period_key / keys[] 透传筛选", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/persons/p1/metrics", {
        period: "day",
        period_key: "2026-01-15",
        keys: ["msg_frequency", "value_score"],
      }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { rows: Array<{ metric_key: string; period: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ metric_key: "msg_frequency", period: "day" });
  });

  it("非法 period 值 → 422", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/persons/p1/metrics", { period: "hour" }),
    );
    expect(res.status).toBe(422);
  });
});

// ── R3 GET /api/mining/ranking ──────────────────────────────────────────────

describe("R3 GET /api/mining/ranking", () => {
  it("按 value_rank 升序返回，并 join display_name", async () => {
    const res = await appWith(makeStore()).request("/api/mining/ranking");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rows: Array<{ person_id: string; display_name: string; value_rank: number }>;
      warnings: string[];
    };
    expect(body.rows.map((r) => r.person_id)).toEqual(["p1", "p2"]);
    expect(body.rows.map((r) => r.display_name)).toEqual(["张三", "李四"]);
    expect(body.warnings).toEqual([]);
  });

  it(`top 越界（> ${RANKING_TOP_MAX}）被 schema 拒绝 → 422`, async () => {
    const res = await appWith(makeStore()).request(url("/api/mining/ranking", { top: "500" }));
    expect(res.status).toBe(422);
  });

  it("负数 top → 422（schema 下界）", async () => {
    const res = await appWith(makeStore()).request(url("/api/mining/ranking", { top: "-1" }));
    expect(res.status).toBe(422);
  });

  it("合法 top 生效（截断到请求值）", async () => {
    const res = await appWith(makeStore()).request(url("/api/mining/ranking", { top: "1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; top: number };
    expect(body.top).toBe(1);
    expect(body.rows).toHaveLength(1);
  });

  it("from / to 无设计口径（ISS-006）→ 告警 RANKING_TIME_RANGE_UNSUPPORTED", async () => {
    const res = await appWith(makeStore()).request(
      url("/api/mining/ranking", { from: "2026-01-01", to: "2026-12-31" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings: string[] }).warnings).toContain(
      WARN_RANKING_TIME_RANGE_UNSUPPORTED,
    );
  });

  it("缺 value_score 或 value_rank 的残缺行不进榜，并回告警", async () => {
    const data = defaultData();
    data.metrics = data.metrics.filter((row) => row.person_id !== "p2");
    data.metrics.push(metric("p2", "value_score", 0.5)); // 只有 score，无 rank

    const res = await appWith(makeStore(data)).request("/api/mining/ranking");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ person_id: string }>; warnings: string[] };
    expect(body.rows.map((r) => r.person_id)).toEqual(["p1"]);
    expect(body.warnings).toContain(WARN_RANKING_INCOMPLETE_ROWS);
  });
});

// ── R4 POST /api/mining/export ──────────────────────────────────────────────

describe("R4 POST /api/mining/export", () => {
  async function postExport(body: unknown) {
    return appWith(makeStore()).request("/api/mining/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("write:false → 返回三形态文件清单但不落盘", async () => {
    const res = await postExport({ export_kind: "person", format: "all", write: false });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      envelope: { counts: { persons: number; conversations: number; messages: number } };
      files: Array<{ path: string; bytes: number }>;
      written: string[];
      outDir: string | null;
    };

    expect(body.envelope.counts).toMatchObject({ persons: 3, conversations: 2, messages: 120 });
    // §7.4：快照**文件名用净化后的内部 id**（`sanitizeFileName(personId)`），显示名出现在
    // 文档内容与 `index.md` 的表格里。且**只有被 metrics / ranking 引用到的人物**才产出文档
    // → `me` 无指标行，故无 `persons/me.md`。
    // 图谱文档不受 `export_kind` 门控（该参数只决定 `data.json` 的 `graph` 字段）。
    expect(body.files.map((f) => f.path).sort()).toEqual([
      "data.json",
      "graph/communities.md",
      "groups/g1.md",
      "index.md",
      "persons/p1.md",
      "persons/p2.md",
      "report.md",
    ]);
    expect(body.files.every((f) => f.bytes > 0)).toBe(true);
    // §8.5：导出写文件「除外」，但 write:false 时不得留下任何痕迹
    expect(body.written).toEqual([]);
    expect(body.outDir).toBeNull();
  });

  it("format 过滤只影响的文件子集", async () => {
    const res = await postExport({ export_kind: "person", format: "json", write: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(["data.json"]);
  });

  it("export_kind 透传进信封（§7.2 的 `graph` 属 `data.json` 顶层，不在信封内）", async () => {
    // 信封（`ExportEnvelope`）字段固定：schema_version / export_kind / generated_at /
    // produced_by / data_range / scope / counts / warnings / 口径声明 / 已知缺口 —— **无 graph**。
    // §7.2 的 `graph` 是 `data.json` 顶层字段（`export_kind='graph'` 时才是快照，否则 null）；
    // 本层只回文件引用（path + bytes）不回内容，故内容断言归
    // `packages/mining/tests/export-api.test.ts`。
    const graph = await postExport({ export_kind: "graph", format: "json", write: false });
    const person = await postExport({ export_kind: "person", format: "json", write: false });
    expect(
      ((await graph.json()) as { envelope: { export_kind: string } }).envelope.export_kind,
    ).toBe("graph");
    expect(
      ((await person.json()) as { envelope: { export_kind: string } }).envelope.export_kind,
    ).toBe("person");
  });

  it("quality 部分接线以告警显式回告（不静默留空）", async () => {
    const res = await postExport({ export_kind: "person", format: "report", write: false });
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toContain(WARN_EXPORT_QUALITY_PARTIAL);
  });

  it("缺 `value_score_breakdown` 行 → 告警 EXPORT_RANKING_BREAKDOWN_MISSING（§6.4）", async () => {
    // 默认 fixture 只有 value_score / value_rank，没有第三个键 `value_score_breakdown`
    const res = await postExport({ export_kind: "ranking", format: "json", write: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings: string[] }).warnings).toContain(
      WARN_EXPORT_RANKING_BREAKDOWN_MISSING,
    );
  });

  it("breakdown 行齐全且合法 → 该告警消失（上一条的正向对照）", async () => {
    const res = await appWith(makeStore(withBreakdown(defaultData()))).request(
      "/api/mining/export",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ export_kind: "ranking", format: "json", write: false }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).not.toContain(WARN_EXPORT_RANKING_BREAKDOWN_MISSING);
  });

  it("缺 export_kind → 422（§8.5 未给默认，必填）", async () => {
    const res = await postExport({ format: "json", write: false });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDATION");
  });

  it("非法 format → 422", async () => {
    const res = await postExport({ export_kind: "person", format: "pdf", write: false });
    expect(res.status).toBe(422);
  });

  it("非 JSON body 不抛 500（回落空对象 → 由 schema 报 422）", async () => {
    const res = await appWith(makeStore()).request("/api/mining/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(422);
  });
});
