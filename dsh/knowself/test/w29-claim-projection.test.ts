// @vitest-environment node
/**
 * W29 真机③：`/graph` 里 **direct 节点的「认领覆盖」投影**（src/routes/graph.ts:144-158 + 230-235）。
 *
 * 认领写入的 alias 恰好等于 `wechat:<uid>` 的 uid，读路径用 `aliases.findByUid` 反查
 * person_id → `persons.display_name`，命中就**覆盖 label 为真名**；查不到 / 降级时保持原
 * label、不报错。**节点 id 不变**（投影只改 label，不动身份字段）。
 *
 * 桩法与 routes-graph.test.ts 同源（resource 捕获 + handleGraphRoute），人物层桩额外提供
 * `aliases.findByUid` 与 `getPerson`（供 directLabelOf 使用）。不触网、不开 DB。
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { GraphSnapshotRow } from "@knowself/person-store";
import type { KnowselfServices } from "../src/services.js";
import { registerKnowselfWebBridge } from "../src/web-bridge.js";

interface CapturedRoute {
  kind: string;
  path: string;
  resource: (request: Request) => Promise<Response>;
}

const DIRECT_ID = "wechat:uid-abc";
const DISPLAY_NAME = "真人名";

/** 一份含 1 个 direct 节点（id=wechat:uid-abc）+ 1 个 person 节点的快照载荷。 */
const PAYLOAD = {
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
  stats: { node_count: 2, edge_count: 1, community_count: 1, modularity: 0.2, degraded_sessions: 0 },
  nodes: [
    {
      id: DIRECT_ID,
      kind: "direct",
      label: "单聊会话",
      ref_id: DIRECT_ID,
      size_raw: 3,
      size: 0.3,
      community_key: "c:x",
      degree: 1,
      relation_type: null,
      isolated: false,
      attrs: {},
    },
    {
      id: "p-other",
      kind: "person",
      label: "张三",
      ref_id: "p-other",
      size_raw: 3,
      size: 0.3,
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
      source: DIRECT_ID,
      target: "p-other",
      kind: "co_presence",
      weight_raw: 1,
      strength: 0.5,
      directed: false,
      attrs: { co_norm: 0.3, evidence_ref: [] },
    },
  ],
  communities: [
    { community_key: "c:x", label: "X", size: 2, member_ids: [DIRECT_ID, "p-other"], group_ids: [], cohesion: 0.5 },
  ],
};

function row(): GraphSnapshotRow {
  return {
    snapshot_id: "snap-1",
    graph_kind: "cooccurrence",
    scope_kind: "global",
    scope_id: "",
    time_from: null,
    time_to: null,
    params_json: "{}",
    payload_json: JSON.stringify(PAYLOAD),
    node_count: 2,
    edge_count: 1,
    community_count: 1,
    produced_by: "knowself-mining-test",
    computed_at: "2026-05-30T00:00:00.000Z",
  } as unknown as GraphSnapshotRow;
}

/** 人物层桩：mining 读层 + direct 认领覆盖用到的四个方法。`aliasHit=false` 模拟认领未命中。 */
function makeServices(aliasHit: boolean): KnowselfServices {
  const store = {
    listPersons: () => [] as [],
    metrics: { list: () => [] as [], listGraphSnapshots: vi.fn(() => [row()]) },
    aliases: {
      findByUid: vi.fn((platform: string, uid: string) =>
        aliasHit && platform === "wechat" && uid === "uid-abc" ? { person_id: "P-1" } : null,
      ),
    },
    getPerson: vi.fn((personId: string) =>
      aliasHit && personId === "P-1" ? { display_name: DISPLAY_NAME } : null,
    ),
  };
  return { personStore: store } as unknown as KnowselfServices;
}

function mount(services: KnowselfServices): (request: Request) => Promise<Response> {
  const routes: CapturedRoute[] = [];
  const sub = {
    webServer: {
      register: (route: CapturedRoute) => {
        routes.push(route);
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
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

async function getGraph(resource: (request: Request) => Promise<Response>): Promise<{
  status: number;
  nodes: Array<Record<string, unknown>>;
}> {
  const res = await resource(new Request("http://x/knowself-api/graph", { method: "GET" }));
  const body = JSON.parse(await res.text()) as { nodes: Array<Record<string, unknown>> };
  return { status: res.status, nodes: body.nodes };
}

describe("W29 认领③：direct 节点 label 投影为真名", () => {
  it("alias 命中 → label 变为 display_name，节点 id 不变（person 节点不受影响）", async () => {
    const resource = mount(makeServices(true));
    const { status, nodes } = await getGraph(resource);
    expect(status).toBe(200);

    const direct = nodes.find((n) => n.id === DIRECT_ID);
    expect(direct).toBeDefined();
    // label 被认领覆盖为真名（原来快照里是「单聊会话」）
    expect(direct?.label).toBe(DISPLAY_NAME);
    // 节点 id 未变（投影只改 label，不动身份）
    expect(direct?.id).toBe(DIRECT_ID);

    // 非 direct 的 person 节点不走认领覆盖，label 原样
    const other = nodes.find((n) => n.id === "p-other");
    expect(other?.label).toBe("张三");
  });

  it("alias 未命中 → 保持原 label、不报错", async () => {
    const resource = mount(makeServices(false));
    const { status, nodes } = await getGraph(resource);
    expect(status).toBe(200);

    const direct = nodes.find((n) => n.id === DIRECT_ID);
    expect(direct?.label).toBe("单聊会话");
    expect(direct?.id).toBe(DIRECT_ID);
  });
});
