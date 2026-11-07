/**
 * `exportMining` 测试（DESIGN-12 §8.5-R4 + §7.1 三形态 / §7.2 信封 / §7.4 落盘）。
 *
 * 覆盖：ExportInput 从 store 的组装（persons / groups / metrics / ranking 含 breakdown 解析 /
 * graph / counts / quality）、`format` 过滤、`write` 落盘与目录约定、`export_kind` 对 graph 的影响、
 * 残缺 breakdown 的跳过与告警、确定性。
 *
 * 全部合成数据（人名只用 我 / 张三 / 李四），无真实聊天内容。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphCommunity, GraphEdge, GraphNode } from "@knowself/contracts";
import type { ChatConversationRow, GraphSnapshotRow, MetricRow, PersonRow } from "@knowself/person-store";
import { SCORE_FEATURES } from "../src/value-scorer";
import {
  DEFAULT_EXPORT_FORMAT,
  WARN_EXPORT_QUALITY_PARTIAL,
  WARN_EXPORT_RANKING_BREAKDOWN_MISSING,
  exportMining,
  type MiningExportStore,
} from "../src/export-api";

const NOW = "2026-09-22T10:00:00+08:00";

// ── fixtures ────────────────────────────────────────────────────────────────

function node(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    kind: "person",
    label: overrides.id,
    ref_id: overrides.id,
    size_raw: 10,
    size: 0.5,
    community_key: "c:1",
    degree: 1,
    relation_type: null,
    isolated: false,
    attrs: {},
    ...overrides,
  } as GraphNode;
}

function edge(overrides: Partial<GraphEdge> & { id: string }): GraphEdge {
  return {
    source: "me",
    target: "zhangsan",
    kind: "direct_reply",
    weight_raw: 5,
    strength: 0.7,
    directed: false,
    attrs: {},
    ...overrides,
  } as GraphEdge;
}

function community(overrides: Partial<GraphCommunity> & { community_key: string }): GraphCommunity {
  return {
    label: "我 等 2 人",
    size: 2,
    member_ids: ["me", "zhangsan"],
    group_ids: [],
    cohesion: 0.6,
    ...overrides,
  } as GraphCommunity;
}

function payload(): string {
  const nodes = [
    node({ id: "me", label: "我", size_raw: 100, size: 1 }),
    node({ id: "zhangsan", label: "张三", size_raw: 40, size: 0.4 }),
  ];
  const edges = [edge({ id: "direct_reply:me|zhangsan" })];
  const communities = [community({ community_key: "c:1" })];
  return JSON.stringify({
    graph_version: "mining-graph-v1",
    produced_by: "mining:graph-v1",
    generated_at: NOW,
    params: {
      algo: "louvain",
      resolution: 1,
      gap_ms: 1_800_000,
      min_edge_strength: 0.05,
      max_pairwise_members: 200,
      time_from: null,
      time_to: null,
    },
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      community_count: communities.length,
      modularity: 0.4,
      degraded_sessions: 3,
    },
    nodes,
    edges,
    communities,
  });
}

function snapshotRow(): GraphSnapshotRow {
  return {
    snapshot_id: "snap-1",
    graph_kind: "cooccurrence",
    scope_kind: "global",
    scope_id: "",
    time_from: null,
    time_to: null,
    params_json: "{}",
    payload_json: payload(),
    node_count: 2,
    edge_count: 1,
    community_count: 1,
    produced_by: "mining:graph-v1",
    computed_at: NOW,
  };
}

function person(overrides: Partial<PersonRow> & { person_id: string }): PersonRow {
  return {
    subject_kind: "contact",
    display_name: overrides.person_id,
    remark: "",
    sort_key: "",
    avatar_ref: null,
    status: "active",
    merged_into: null,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: 0,
    conv_count: 0,
    ...overrides,
  } as PersonRow;
}

function conversation(
  conversationId: string,
  kind: ChatConversationRow["kind"],
  title: string,
): ChatConversationRow {
  return {
    conversation_id: conversationId,
    platform: "wechat",
    kind,
    title,
    owner_person_id: "me",
    member_count: 2,
    msg_count: 10,
    first_msg_at: null,
    last_msg_at: null,
    is_active: true,
    source_batch_id: "batch-1",
  } as ChatConversationRow;
}

function metric(overrides: Partial<MetricRow> & { metric_key: string }): MetricRow {
  return {
    metric_id: `m-${overrides.person_id ?? "me"}-${overrides.metric_key}`,
    person_id: "me",
    scope_kind: "global",
    scope_id: "",
    period: "all",
    period_key: "",
    metric_value: 1,
    metric_value_json: null,
    metric_unit: "count",
    computed_at: NOW,
    produced_by: "mining:metrics-v1",
    source_ref: "[]",
    evidence_count: 0,
    manual_locked: false,
    ...overrides,
  } as MetricRow;
}

/** §6.3 的特征分解 JSON（8 个特征齐全）。 */
function breakdownJson(): string {
  const entries = SCORE_FEATURES.map((key) => [
    key,
    { raw: 1, norm: 0.5, weight: 0.125, contrib: 0.0625 },
  ]);
  return JSON.stringify(Object.fromEntries(entries));
}

interface FakeOptions {
  readonly persons?: readonly PersonRow[];
  readonly conversations?: readonly ChatConversationRow[];
  readonly metrics?: readonly MetricRow[];
  readonly snapshots?: readonly GraphSnapshotRow[];
  readonly messageCount?: number;
}

function fakeStore(options: FakeOptions = {}): MiningExportStore {
  const persons = options.persons ?? [];
  const conversations = options.conversations ?? [];
  const metrics = options.metrics ?? [];
  const snapshots = options.snapshots ?? [];
  return {
    listPersons: () => [...persons],
    conversations: {
      list: (q) => conversations.filter((row) => q?.kind === undefined || row.kind === q.kind),
    },
    messages: { count: () => options.messageCount ?? 0 },
    metrics: {
      list: (q) =>
        metrics.filter(
          (row) =>
            (q.person_id === undefined || row.person_id === q.person_id) &&
            (q.scope_kind === undefined || row.scope_kind === q.scope_kind) &&
            (q.scope_id === undefined || row.scope_id === q.scope_id) &&
            (q.metric_keys === undefined || q.metric_keys.includes(row.metric_key)),
        ),
      listGraphSnapshots: (q) =>
        snapshots.filter(
          (row) =>
            (q?.graph_kind === undefined || row.graph_kind === q.graph_kind) &&
            (q?.scope_kind === undefined || row.scope_kind === q.scope_kind) &&
            (q?.scope_id === undefined || row.scope_id === q.scope_id),
        ),
    },
  };
}

const PERSONS = [
  person({ person_id: "me", subject_kind: "self", display_name: "我" }),
  person({ person_id: "zhangsan", display_name: "张三" }),
  person({ person_id: "lisi", display_name: "李四" }),
];

const CONVERSATIONS = [
  conversation("wechat:conv-direct", "direct", "张三"),
  conversation("wechat:group-1", "group", "三人小群"),
];

/** 张三 / 李四 各 3 行价值行（score / rank / breakdown）。 */
const VALUE_ROWS = [
  metric({ person_id: "zhangsan", metric_key: "value_score", metric_value: 0.8, metric_unit: "score" }),
  metric({ person_id: "zhangsan", metric_key: "value_rank", metric_value: 1, metric_unit: "rank" }),
  metric({
    person_id: "zhangsan",
    metric_key: "value_score_breakdown",
    metric_value: null,
    metric_value_json: breakdownJson(),
    metric_unit: "json",
  }),
  metric({ person_id: "lisi", metric_key: "value_score", metric_value: 0.3, metric_unit: "score" }),
  metric({ person_id: "lisi", metric_key: "value_rank", metric_value: 2, metric_unit: "rank" }),
  metric({
    person_id: "lisi",
    metric_key: "value_score_breakdown",
    metric_value: null,
    metric_value_json: breakdownJson(),
    metric_unit: "json",
  }),
  metric({ person_id: "zhangsan", metric_key: "msg_count_other", metric_value: 42 }),
];

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-export-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fullStore(): MiningExportStore {
  return fakeStore({
    persons: PERSONS,
    conversations: CONVERSATIONS,
    metrics: VALUE_ROWS,
    snapshots: [snapshotRow()],
    messageCount: 123,
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("exportMining（DESIGN-12 §8.5-R4）", () => {
  it("默认 format=all 产出 §7.1 三形态全部文件（不落盘）", () => {
    const result = exportMining(fullStore(), { export_kind: "weekly", write: false, now: NOW });

    expect(DEFAULT_EXPORT_FORMAT).toBe("all");
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain("report.md");
    expect(paths).toContain("data.json");
    expect(paths).toContain("index.md");
    expect(result.written).toEqual([]);
    expect(result.outDir).toBeNull();
  });

  it("format 过滤：json 只留 data.json，report 只留 report.md，markdown 排除前两者", () => {
    const store = fullStore();

    const json = exportMining(store, { export_kind: "weekly", format: "json", write: false, now: NOW });
    expect(json.files.map((file) => file.path)).toEqual(["data.json"]);

    const report = exportMining(store, { export_kind: "weekly", format: "report", write: false, now: NOW });
    expect(report.files.map((file) => file.path)).toEqual(["report.md"]);

    const markdown = exportMining(store, {
      export_kind: "weekly",
      format: "markdown",
      write: false,
      now: NOW,
    });
    const paths = markdown.files.map((file) => file.path);
    expect(paths).not.toContain("report.md");
    expect(paths).not.toContain("data.json");
    expect(paths).toContain("index.md");
    expect(paths.some((path) => path.startsWith("persons/"))).toBe(true);
  });

  it("信封含 §7.1 头部四要素：生成时间 / 数据范围 / produced_by / 数据条数", () => {
    const result = exportMining(fullStore(), {
      export_kind: "weekly",
      range: { from: "2026-09-01", to: "2026-09-22" },
      write: false,
      now: NOW,
    });

    expect(result.envelope.generated_at).toBe(NOW);
    expect(result.envelope.data_range).toEqual({ from: "2026-09-01", to: "2026-09-22" });
    expect(result.envelope.produced_by).toBe("mining:export-v1");
    expect(result.envelope.counts).toEqual({ messages: 123, persons: 3, conversations: 2 });
  });

  it("export_kind='graph' 时图谱进导出，其它 kind 时为空", () => {
    const store = fullStore();

    const withGraph = exportMining(store, { export_kind: "graph", format: "json", write: false, now: NOW });
    const plain = exportMining(store, { export_kind: "weekly", format: "json", write: false, now: NOW });

    // data.json 内嵌 graph 字段（§7.2：export_kind='graph' 时非空）
    const graphFile = withGraph.files.find((file) => file.path === "data.json");
    const plainFile = plain.files.find((file) => file.path === "data.json");
    expect(graphFile).toBeDefined();
    expect(plainFile).toBeDefined();
    expect(graphFile!.bytes).toBeGreaterThan(plainFile!.bytes);
  });

  it("ranking 从 value_* 三行组装（含 breakdown 解析）", () => {
    const result = exportMining(fullStore(), {
      export_kind: "ranking",
      format: "json",
      write: false,
      now: NOW,
    });

    expect(result.warnings).not.toContain(WARN_EXPORT_RANKING_BREAKDOWN_MISSING);
    expect(result.envelope.counts.persons).toBe(3);
  });

  it("缺 value_score_breakdown 的人不进 ranking 并给 warning", () => {
    const store = fakeStore({
      persons: PERSONS,
      conversations: CONVERSATIONS,
      snapshots: [snapshotRow()],
      metrics: [
        ...VALUE_ROWS,
        metric({ person_id: "wangwu", metric_key: "value_score", metric_value: 0.1, metric_unit: "score" }),
        metric({ person_id: "wangwu", metric_key: "value_rank", metric_value: 3, metric_unit: "rank" }),
      ],
    });

    const result = exportMining(store, { export_kind: "ranking", write: false, now: NOW });

    expect(result.warnings).toContain(WARN_EXPORT_RANKING_BREAKDOWN_MISSING);
  });

  it("quality 只接线 degraded_sessions，未接线字段给 warning（不静默留空）", () => {
    const result = exportMining(fullStore(), { export_kind: "graph", write: false, now: NOW });

    expect(result.warnings).toContain(WARN_EXPORT_QUALITY_PARTIAL);
  });

  it("write=true 落盘到指定目录（§7.4）并返回相对路径", () => {
    const dir = tempDir();

    const result = exportMining(fullStore(), {
      export_kind: "weekly",
      format: "json",
      outDir: dir,
      now: NOW,
    });

    expect(result.written).toEqual(["data.json"]);
    expect(result.outDir).toBe(dir);
    const written = JSON.parse(readFileSync(join(dir, "data.json"), "utf8")) as {
      envelope: { export_kind: string };
    };
    expect(written.envelope.export_kind).toBe("weekly");
  });

  it("outDir 缺省时按 §7.4 目录约定生成（时间戳已做 Windows 路径净化）", () => {
    const result = exportMining(fullStore(), { export_kind: "weekly", format: "json", now: NOW });

    expect(result.outDir).not.toBeNull();
    expect(result.outDir).toContain("exports");
    // `:` 在 Windows 路径非法，必须被净化
    expect(result.outDir).not.toContain(":");
  });

  it("确定性：同参数同 now 两次调用，文件清单与信封一致", () => {
    const store = fullStore();

    const first = exportMining(store, { export_kind: "weekly", write: false, now: NOW });
    const second = exportMining(store, { export_kind: "weekly", write: false, now: NOW });

    expect(second.files).toEqual(first.files);
    expect(second.envelope).toEqual(first.envelope);
    expect(second.warnings).toEqual(first.warnings);
  });

  it("无价值行 / 无快照时仍能导出（不抛错）", () => {
    const store = fakeStore({ persons: PERSONS, conversations: CONVERSATIONS });

    const result = exportMining(store, { export_kind: "weekly", write: false, now: NOW });

    expect(result.envelope.counts).toEqual({ messages: 0, persons: 3, conversations: 2 });
    expect(result.files.length).toBeGreaterThan(0);
  });
});
