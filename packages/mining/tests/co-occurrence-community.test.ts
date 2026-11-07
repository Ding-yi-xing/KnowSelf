/**
 * CoOccurrenceBuilder / CommunityDetector / 图谱快照测试（DESIGN-12 §4 + §8 + §11.1 + T7）。
 * 全部合成文案（人名只用 张三 / 李四 / 王五 / 赵六 / 钱七），无真实聊天内容。
 */
import { describe, expect, it } from "vitest";
import { GraphSnapshotSchema } from "@knowself/contracts";
import type { GraphSnapshotInsert, MiningMessageRow } from "@knowself/person-store";
import {
  GRAPH_PRODUCED_BY,
  GRAPH_SNAPSHOT_KEEP,
  MAX_PAIRWISE_MEMBERS,
  MIN_EDGE_STRENGTH,
  SESSION_GAP_MS,
} from "../src/constants";
import { buildCoOccurrence, type CoOccurrenceInput } from "../src/co-occurrence";
import { detectCommunities } from "../src/community";
import {
  buildGraphSnapshot,
  persistGraphSnapshot,
  type GraphSnapshotPruneQuery,
} from "../src/graph";

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
let counter = 0;

function msg(
  conversationId: string,
  senderPersonId: string | null,
  tsMs: number,
  overrides: Partial<MiningMessageRow> = {},
): MiningMessageRow {
  counter += 1;
  return {
    message_id: `m-${counter}`,
    conversation_id: conversationId,
    platform: "wechat",
    role: senderPersonId === "me" ? "me" : "other",
    sender_id: senderPersonId === null ? "unresolved" : `uid-${senderPersonId}`,
    sender_person_id: senderPersonId,
    ts_ms: tsMs,
    msg_date: "2023-11-14",
    content: "合成文案",
    content_type: "text",
    reply_to: null,
    meta: "{}",
    ...overrides,
  };
}

const PERSONS = [
  { person_id: "person-zhangsan", label: "张三" },
  { person_id: "person-lisi", label: "李四" },
  { person_id: "person-wangwu", label: "王五" },
  { person_id: "person-zhaoliu", label: "赵六" },
  { person_id: "person-qianqi", label: "钱七" },
  { person_id: "me", label: "我" },
];

function baseInput(
  messagesByConversation: CoOccurrenceInput["messagesByConversation"],
  overrides: Partial<CoOccurrenceInput> = {},
): CoOccurrenceInput {
  return {
    persons: PERSONS,
    groups: [],
    messagesByConversation,
    ...overrides,
  };
}

describe("CoOccurrenceBuilder（§4.1 / §4.2 / §4.2.1）", () => {
  it("片段内两两配对：3 人同片段 → 3 条 co_presence，各权重 1（含 'me' 节点）", () => {
    const conv = "wechat:conv-1";
    const result = buildCoOccurrence(
      baseInput(
        new Map([
          [
            conv,
            [
              msg(conv, "person-zhangsan", T0),
              msg(conv, "person-lisi", T0 + 1_000),
              msg(conv, "me", T0 + 2_000),
            ],
          ],
        ]),
      ),
    );
    const coPresence = result.edges.filter((e) => e.kind === "co_presence");
    expect(coPresence).toHaveLength(3);
    for (const edge of coPresence) {
      expect(edge.weight_raw).toBe(1);
      expect(edge.directed).toBe(false);
      // id 两端按字典序（§8.3）
      const [left, right] = edge.id.replace("co_presence:", "").split("|");
      expect(left !== undefined && right !== undefined && left < right).toBe(true);
    }
    const meNode = result.nodes.find((n) => n.id === "me");
    expect(meNode?.kind).toBe("person");
  });

  it("sender_person_id 为 NULL 的消息不参与配对", () => {
    const conv = "wechat:conv-2";
    const result = buildCoOccurrence(
      baseInput(
        new Map([
          [conv, [msg(conv, "person-zhangsan", T0), msg(conv, null, T0 + 1_000)]],
        ]),
      ),
    );
    expect(result.edges.filter((e) => e.kind === "co_presence")).toHaveLength(0);
  });

  it("|S| > MAX_PAIRWISE_MEMBERS → 跳过两两共现并记降级（§4.2 降级保护）", () => {
    const conv = "wechat:group-big";
    const senders: MiningMessageRow[] = [];
    for (let i = 0; i < MAX_PAIRWISE_MEMBERS + 1; i += 1) {
      senders.push(msg(conv, `person-bulk-${String(i).padStart(4, "0")}`, T0 + i * 1_000));
    }
    const result = buildCoOccurrence(
      baseInput(new Map([[conv, senders]]), {
        groups: [{ conversation_id: conv, label: "大群" }],
        groupConversationIds: new Set([conv]),
      }),
    );
    expect(result.degradedSessions).toBe(1);
    expect(result.warnings).toContain("CO_OCCURRENCE_DEGRADED");
    expect(result.edges.filter((e) => e.kind === "co_presence")).toHaveLength(0);
  });

  it("co_norm 按 Salton 余弦：count / sqrt(deg(a)·deg(b))（§4.2.1 ①）", () => {
    const conv = "wechat:conv-3";
    // 片段 A: p1,p2,p3 / 片段 B: p1,p2 / 片段 C: p1,p3（片段间间隔 > G）
    const far = SESSION_GAP_MS + 5_000;
    const result = buildCoOccurrence(
      baseInput(
        new Map([
          [
            conv,
            [
              msg(conv, "person-zhangsan", T0),
              msg(conv, "person-lisi", T0 + 1_000),
              msg(conv, "person-wangwu", T0 + 2_000),
              msg(conv, "person-zhangsan", T0 + far),
              msg(conv, "person-lisi", T0 + far + 1_000),
              msg(conv, "person-zhangsan", T0 + far * 2),
              msg(conv, "person-wangwu", T0 + far * 2 + 1_000),
            ],
          ],
        ]),
      ),
    );
    const byPair = new Map(
      result.edges
        .filter((e) => e.kind === "co_presence")
        .map((e) => [e.id.replace("co_presence:", ""), e]),
    );
    // co: (zs,ls)=2 / (zs,ww)=2 / (ls,ww)=1；deg: zs=4, ls=3, ww=3
    const zsLs = byPair.get("person-lisi|person-zhangsan");
    const lsWw = byPair.get("person-lisi|person-wangwu");
    expect(zsLs?.weight_raw).toBe(2);
    expect(zsLs?.attrs.co_norm).toBeCloseTo(2 / Math.sqrt(4 * 3), 6);
    expect(lsWw?.attrs.co_norm).toBeCloseTo(1 / Math.sqrt(3 * 3), 6);
  });

  it("strength 单调映射：max 边 = 1，其余 = log1p(w)/log1p(max)（§4.2.1 ②）", () => {
    const conv = "wechat:conv-4";
    const far = SESSION_GAP_MS + 5_000;
    const result = buildCoOccurrence(
      baseInput(
        new Map([
          [
            conv,
            [
              msg(conv, "person-zhangsan", T0),
              msg(conv, "person-lisi", T0 + 1_000),
              msg(conv, "person-wangwu", T0 + 2_000),
              msg(conv, "person-zhangsan", T0 + far),
              msg(conv, "person-lisi", T0 + far + 1_000),
            ],
          ],
        ]),
      ),
    );
    const edges = result.edges.filter((e) => e.kind === "co_presence");
    const max = edges.find((e) => e.weight_raw === 2);
    const min = edges.find((e) => e.weight_raw === 1);
    expect(max?.strength).toBe(1);
    expect(min?.strength).toBeCloseTo(Math.log1p(1) / Math.log1p(2), 6);
  });

  it("membership / my_group：人↔群边（'me' 走 my_group 且 directed=true）", () => {
    const group = "wechat:group-1";
    const result = buildCoOccurrence(
      baseInput(
        new Map([
          [
            group,
            [
              msg(group, "person-zhangsan", T0),
              msg(group, "person-zhangsan", T0 + 1_000),
              msg(group, "me", T0 + 2_000),
              msg(group, "me", T0 + 3_000),
              msg(group, "me", T0 + 4_000),
            ],
          ],
        ]),
        {
          groups: [{ conversation_id: group, label: "老同学群" }],
          groupConversationIds: new Set([group]),
        },
      ),
    );
    const membership = result.edges.find((e) => e.kind === "membership");
    expect(membership?.weight_raw).toBe(2);
    expect(membership?.directed).toBe(false);
    const myGroup = result.edges.find((e) => e.kind === "my_group");
    expect(myGroup?.weight_raw).toBe(3);
    expect(myGroup?.directed).toBe(true);
    expect(myGroup?.source).toBe("me");
    expect(result.nodes.find((n) => n.id === group)?.kind).toBe("group");
  });

  it("mention 边：从提及消息的发送者指向被提及者（directed=true）", () => {
    const conv = "wechat:conv-5";
    const m1 = msg(conv, "person-zhangsan", T0);
    const result = buildCoOccurrence(
      baseInput(new Map([[conv, [m1]]]), {
        mentions: [{ message_id: m1.message_id, person_id: "person-lisi", mention_kind: "at" }],
      }),
    );
    const mention = result.edges.find((e) => e.kind === "mention");
    expect(mention?.source).toBe("person-zhangsan");
    expect(mention?.target).toBe("person-lisi");
    expect(mention?.directed).toBe(true);
    expect(mention?.weight_raw).toBe(1);
    expect(mention?.attrs.evidence_ref).toContain(m1.message_id);
  });

  it("min_edge_strength 裁剪：低于阈值的边不进图，节点标 isolated=true（§4.5）", () => {
    const conv = "wechat:conv-6";
    const far = SESSION_GAP_MS + 5_000;
    const messages: MiningMessageRow[] = [];
    // (zs,ls) 反复共现 10 次；(zs,ww) 仅 1 次 → 后者强度低，用高阈值裁掉
    for (let i = 0; i < 10; i += 1) {
      messages.push(msg(conv, "person-zhangsan", T0 + far * i));
      messages.push(msg(conv, "person-lisi", T0 + far * i + 1_000));
    }
    messages.push(msg(conv, "person-zhangsan", T0 + far * 11));
    messages.push(msg(conv, "person-wangwu", T0 + far * 11 + 1_000));
    const result = buildCoOccurrence(
      baseInput(new Map([[conv, messages]]), { minEdgeStrength: 0.5 }),
    );
    expect(
      result.edges.some((e) => e.target === "person-wangwu" || e.source === "person-wangwu"),
    ).toBe(false);
    expect(result.nodes.find((n) => n.id === "person-wangwu")?.isolated).toBe(true);
  });

  it("topic 节点与 topic_affinity 边（P2 数据接入位；默认无话题则无 topic 节点）", () => {
    const conv = "wechat:conv-7";
    const empty = buildCoOccurrence(
      baseInput(new Map([[conv, [msg(conv, "person-zhangsan", T0)]]])),
    );
    expect(empty.nodes.some((n) => n.kind === "topic")).toBe(false);
    const withTopics = buildCoOccurrence(
      baseInput(new Map([[conv, [msg(conv, "person-zhangsan", T0)]]]), {
        topicHits: [
          {
            person_id: "person-zhangsan",
            topic_key: "装修",
            topic_label: "装修",
            hit_count: 4,
            evidence: [],
          },
        ],
      }),
    );
    const topicNode = withTopics.nodes.find((n) => n.kind === "topic");
    expect(topicNode?.id.startsWith("topic:")).toBe(true);
    const affinity = withTopics.edges.find((e) => e.kind === "topic_affinity");
    expect(affinity?.weight_raw).toBe(4);
  });
});

describe("CommunityDetector（§4.4 / §11.1）", () => {
  function twoClusterInput(): CoOccurrenceInput {
    const conv = "wechat:conv-c1";
    const far = SESSION_GAP_MS + 5_000;
    const messages: MiningMessageRow[] = [];
    for (let i = 0; i < 4; i += 1) {
      messages.push(msg(conv, "person-zhangsan", T0 + far * i));
      messages.push(msg(conv, "person-lisi", T0 + far * i + 1_000));
    }
    for (let i = 0; i < 4; i += 1) {
      messages.push(msg(conv, "person-wangwu", T0 + far * (i + 10)));
      messages.push(msg(conv, "person-zhaoliu", T0 + far * (i + 10) + 1_000));
    }
    messages.push(msg(conv, "person-qianqi", T0 + far * 30)); // 孤立
    return baseInput(new Map([[conv, messages]]));
  }

  it("community_key 稳定：成员集合相同 → 同 key（与输入顺序、展示名无关）", () => {
    const a = buildCoOccurrence(twoClusterInput());
    const b = buildCoOccurrence({
      ...twoClusterInput(),
      persons: [...PERSONS].reverse().map((p) => ({ ...p, label: `${p.label}·别名` })),
    });
    const keyOf = (
      nodes: readonly { id: string; community_key: string | null }[],
      id: string,
    ): string | null => nodes.find((n) => n.id === id)?.community_key ?? null;
    const ca = detectCommunities({ nodes: a.nodes, edges: a.edges });
    const cb = detectCommunities({ nodes: b.nodes, edges: b.edges });
    expect(keyOf(ca.nodes, "person-zhangsan")).toBe(keyOf(cb.nodes, "person-zhangsan"));
    expect(keyOf(ca.nodes, "person-zhangsan")).not.toBe(keyOf(ca.nodes, "person-wangwu"));
  });

  it("输出 modularity，且两个不连通簇分成两个社区；孤立节点 community_key=null", () => {
    const built = buildCoOccurrence(twoClusterInput());
    const result = detectCommunities({ nodes: built.nodes, edges: built.edges });
    expect(typeof result.modularity).toBe("number");
    expect(result.modularity).toBeGreaterThanOrEqual(-0.5);
    expect(result.modularity).toBeLessThanOrEqual(1);
    const keyOf = (id: string): string | null =>
      result.nodes.find((n) => n.id === id)?.community_key ?? null;
    expect(keyOf("person-zhangsan")).toBe(keyOf("person-lisi"));
    expect(keyOf("person-zhangsan")).not.toBe(keyOf("person-wangwu"));
    expect(keyOf("person-wangwu")).toBe(keyOf("person-zhaoliu"));
    expect(keyOf("person-qianqi")).toBeNull();
    expect(result.communities.every((c) => c.member_ids.length >= 2)).toBe(true);
  });

  it("社区 label 取「size_raw 最大者 + 等 N 人」，size/cohesion 合法", () => {
    const built = buildCoOccurrence(twoClusterInput());
    const result = detectCommunities({ nodes: built.nodes, edges: built.edges });
    for (const community of result.communities) {
      expect(community.label.length).toBeGreaterThan(0);
      expect(community.size).toBe(community.member_ids.length);
      expect(community.cohesion).toBeGreaterThanOrEqual(0);
      expect(community.cohesion).toBeLessThanOrEqual(1);
      expect(community.community_key.startsWith("c:")).toBe(true);
    }
    const labeled = result.communities.find((c) => c.member_ids.includes("person-zhangsan"));
    expect(labeled?.label).toContain("等 2 人");
  });

  it("topic 节点不参与社区（community_key=null，不进 member_ids）", () => {
    const conv = "wechat:conv-c2";
    const built = buildCoOccurrence(
      baseInput(
        new Map([
          [conv, [msg(conv, "person-zhangsan", T0), msg(conv, "person-lisi", T0 + 1_000)]],
        ]),
        {
          topicHits: [
            {
              person_id: "person-zhangsan",
              topic_key: "装修",
              topic_label: "装修",
              hit_count: 3,
              evidence: [],
            },
          ],
        },
      ),
    );
    const result = detectCommunities({ nodes: built.nodes, edges: built.edges });
    const topic = result.nodes.find((n) => n.kind === "topic");
    expect(topic?.community_key).toBeNull();
    expect(
      result.communities.every((c) => c.member_ids.every((id) => !id.startsWith("topic:"))),
    ).toBe(true);
  });
});

describe("图谱快照（§4.5 / §4.6 / T7）", () => {
  it("T7：输出通过 contracts GraphSnapshotSchema 校验，字段逐项对齐", () => {
    const conv = "wechat:conv-s1";
    const built = buildGraphSnapshot(
      baseInput(
        new Map([
          [conv, [msg(conv, "person-zhangsan", T0), msg(conv, "person-lisi", T0 + 1_000)]],
        ]),
        { now: "2026-09-21T10:00:00+08:00" },
      ),
    );
    const parsed = GraphSnapshotSchema.parse(built.snapshot);
    expect(parsed.graph_version).toBe("mining-graph-v1");
    expect(parsed.produced_by).toBe(GRAPH_PRODUCED_BY);
    expect(parsed.params.algo).toBe("louvain");
    expect(parsed.params.resolution).toBe(1);
    expect(parsed.params.gap_ms).toBe(SESSION_GAP_MS);
    expect(parsed.params.min_edge_strength).toBe(MIN_EDGE_STRENGTH);
    expect(parsed.params.max_pairwise_members).toBe(MAX_PAIRWISE_MEMBERS);
    expect(parsed.stats.node_count).toBe(parsed.nodes.length);
    expect(parsed.stats.edge_count).toBe(parsed.edges.length);
    expect(parsed.stats.community_count).toBe(parsed.communities.length);
  });

  it("确定性：同输入同参数 → 逐字节一致的 JSON（附录 B #6）", () => {
    const conv = "wechat:conv-s2";
    const build = (): string =>
      JSON.stringify(
        buildGraphSnapshot(
          baseInput(
            new Map([
              [conv, [msg(conv, "person-zhangsan", T0), msg(conv, "person-lisi", T0 + 1_000)]],
            ]),
            { now: "2026-09-21T10:00:00+08:00" },
          ),
        ).snapshot,
      );
    // 夹具的 message_id 来自模块级自增计数器：两次构建前复位，保证输入本身逐字节相同
    counter = 0;
    const first = build();
    counter = 0;
    const second = build();
    expect(first).toBe(second);
  });

  it("快照落库：写库载荷字段齐全，并按 GRAPH_SNAPSHOT_KEEP 裁剪", () => {
    const conv = "wechat:conv-s3";
    const { snapshot } = buildGraphSnapshot(
      baseInput(
        new Map([
          [conv, [msg(conv, "person-zhangsan", T0), msg(conv, "person-lisi", T0 + 1_000)]],
        ]),
        { now: "2026-09-21T10:00:00+08:00" },
      ),
    );
    const inserted: GraphSnapshotInsert[] = [];
    const pruned: GraphSnapshotPruneQuery[] = [];
    const result = persistGraphSnapshot(
      {
        insertGraphSnapshot: (row) => {
          inserted.push(row);
          return { snapshot_id: "snap-1" };
        },
        pruneGraphSnapshots: (q) => {
          pruned.push(q);
          return { deleted: 0 };
        },
      },
      snapshot,
    );
    expect(result.snapshot_id).toBe("snap-1");
    const row = inserted[0];
    expect(row?.graph_kind).toBe("cooccurrence");
    expect(row?.produced_by).toBe(GRAPH_PRODUCED_BY);
    expect(row?.node_count).toBe(snapshot.nodes.length);
    expect(row?.edge_count).toBe(snapshot.edges.length);
    expect(row?.community_count).toBe(snapshot.communities.length);
    expect(JSON.parse(String(row?.payload_json))).toEqual(snapshot);
    expect(pruned[0]?.keep).toBe(GRAPH_SNAPSHOT_KEEP);
  });
});
