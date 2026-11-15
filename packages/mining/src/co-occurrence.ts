/**
 * `CoOccurrenceBuilder`（DESIGN-12 §4.1 / §4.2 / §4.2.1）：图谱节点 + 六类边 + 双层归一化。
 * 输入为 `v_chat_messages` 投影行（§3.1 语义：已排除回滚批次）；system 消息在本模块内过滤。
 * 输出节点/边逐字段对齐 contracts `GraphNodeSchema` / `GraphEdgeSchema`（T7）。
 * 不变量：不猜（无证据不给边）、确定性（同输入同输出）、只读（不写任何库）。
 */
import { createHash } from "node:crypto";
import type { GraphEdge, GraphNode } from "@knowself/contracts";
import type { MentionKind, MiningMessageRow } from "@knowself/person-store";
import {
  MAX_EDGES,
  MAX_NODES,
  MAX_PAIRWISE_MEMBERS,
  MIN_EDGE_STRENGTH,
  MIN_TOPIC_COUNT,
} from "./constants";
import { segmentConversation } from "./session";

const SELF_PERSON_ID = "me";
const EVIDENCE_LIMIT = 5;
/** 内部复合键分隔符（topic_key 可能含空格与 `|`，故用不可见字符）。 */
const KEY_SEP = "\u0000";

export interface CoOccurrencePersonInput {
  readonly person_id: string;
  readonly label: string;
  /** 与 'me' 的关系类型（§8.2 `relation_type`）；未知留空，不猜。 */
  readonly relation_type?: string | null;
}

export interface CoOccurrenceGroupInput {
  readonly conversation_id: string;
  readonly label: string;
}

export interface MentionInput {
  readonly message_id: string;
  readonly person_id: string;
  readonly mention_kind: MentionKind;
}

/** 话题命中（P2 话题抽取的接入位；§4.1 话题节点来源为 `person_facts(fact_kind='topic')`）。 */
export interface TopicHitInput {
  readonly person_id: string;
  readonly topic_key: string;
  readonly topic_label: string;
  readonly hit_count: number;
  readonly evidence?: readonly string[];
}

export interface CoOccurrenceInput {
  readonly persons: readonly CoOccurrencePersonInput[];
  readonly groups: readonly CoOccurrenceGroupInput[];
  readonly messagesByConversation: ReadonlyMap<string, readonly MiningMessageRow[]>;
  /** 群会话 id 集合（未在 `groups` 里给标签时，label 回退为 conversation_id）。 */
  readonly groupConversationIds?: ReadonlySet<string>;
  readonly mentions?: readonly MentionInput[];
  readonly topicHits?: readonly TopicHitInput[];
  readonly lastMsgAtByPerson?: ReadonlyMap<string, string>;
  readonly maxPairwiseMembers?: number;
  readonly minEdgeStrength?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  /**
   * W29：会话节点类型判定。缺省全部按 `"group"`，既有调用方零行为变化。
   * pipeline 注入后把单聊会话标成 `"direct"`，在 group 节点循环里消费。
   */
  readonly conversationKindOf?: (conversationId: string) => "group" | "direct";
}

export interface CoOccurrenceResult {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /** `|S(s)| > MAX_PAIRWISE_MEMBERS` 的片段数（§4.2 降级保护）。 */
  readonly degradedSessions: number;
  /** 审计用告警码（不进快照 payload——§4.5 的 `truncated` 标记与 §8.2 的 strict schema 冲突，按契约取 §8.2）。 */
  readonly warnings: string[];
  /**
   * 裁剪**前**的候选边数（已过滤 minStrength、且两端节点都保留）。
   *
   * 为什么要带出来：`edges.length` 顶到上限时，用户看到"10,000 条边"会当成全部，
   * 而实际候选可能是 18,000+。这个数字必须能被上层写进快照与提示里
   * （真机全量：1206 节点、候选 18k+、保留 10k，此前完全静默）。
   */
  readonly edgeCandidates: number;
}

interface RawEdge {
  kind: GraphEdge["kind"];
  source: string;
  target: string;
  weight_raw: number;
  directed: boolean;
  co_norm: number | null;
  evidence: string[];
}

function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** 边 id：`'<kind>:<source>|<target>'`，两端恒按字典序（§8.3）。 */
function edgeId(kind: GraphEdge["kind"], source: string, target: string): string {
  const [left, right] = sortedPair(source, target);
  return `${kind}:${left}|${right}`;
}

function topicNodeId(topicKey: string): string {
  return `topic:${createHash("sha1").update(topicKey).digest("hex")}`;
}

function pushEvidence(list: string[], ids: readonly string[]): void {
  for (const id of ids) {
    if (list.length >= EVIDENCE_LIMIT) return;
    if (!list.includes(id)) list.push(id);
  }
}

function byKeyAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildCoOccurrence(input: CoOccurrenceInput): CoOccurrenceResult {
  const maxPairwise = input.maxPairwiseMembers ?? MAX_PAIRWISE_MEMBERS;
  const minStrength = input.minEdgeStrength ?? MIN_EDGE_STRENGTH;
  const maxNodes = input.maxNodes ?? MAX_NODES;
  const maxEdges = input.maxEdges ?? MAX_EDGES;

  const groupIds = new Set<string>([
    ...input.groups.map((g) => g.conversation_id),
    ...(input.groupConversationIds ?? []),
  ]);
  const groupLabels = new Map(input.groups.map((g) => [g.conversation_id, g.label]));

  // ── 消息索引（确定性：会话按 id 排序，会话内按 (ts_ms, message_id) 排序）──────
  const personMsgCount = new Map<string, number>();
  const personEvidence = new Map<string, string[]>();
  const groupMsgCount = new Map<string, number>();
  const groupEvidence = new Map<string, string[]>();
  const senderByMessage = new Map<string, string | null>();
  const ordered = new Map<string, readonly MiningMessageRow[]>();

  for (const conversationId of [...input.messagesByConversation.keys()].sort(byKeyAsc)) {
    const raw = input.messagesByConversation.get(conversationId) ?? [];
    const messages = raw
      .filter((m) => m.role !== "system" && m.content_type !== "system")
      .slice()
      .sort((a, b) => a.ts_ms - b.ts_ms || byKeyAsc(a.message_id, b.message_id));
    ordered.set(conversationId, messages);
    for (const m of messages) {
      senderByMessage.set(m.message_id, m.sender_person_id);
      const sender = m.sender_person_id;
      if (sender !== null) {
        personMsgCount.set(sender, (personMsgCount.get(sender) ?? 0) + 1);
        const ev = personEvidence.get(sender) ?? [];
        pushEvidence(ev, [m.message_id]);
        personEvidence.set(sender, ev);
      }
      if (groupIds.has(conversationId)) {
        groupMsgCount.set(conversationId, (groupMsgCount.get(conversationId) ?? 0) + 1);
        const ev = groupEvidence.get(conversationId) ?? [];
        pushEvidence(ev, [m.message_id]);
        groupEvidence.set(conversationId, ev);
      }
    }
  }

  // ── 片段级累加：co_presence / direct_reply / membership ─────────────────────
  const coCounts = new Map<string, number>();
  const coEvidence = new Map<string, string[]>();
  const replyCounts = new Map<string, number>();
  const replyEvidence = new Map<string, string[]>();
  const memberCounts = new Map<string, number>();
  const memberEvidence = new Map<string, string[]>();
  let degradedSessions = 0;

  for (const [conversationId, messages] of ordered) {
    const { segments } = segmentConversation(conversationId, messages);
    for (const segment of segments) {
      const senders = [
        ...new Set(
          segment.messages.map((m) => m.sender_person_id).filter((s): s is string => s !== null),
        ),
      ].sort(byKeyAsc);

      if (senders.length > maxPairwise) {
        degradedSessions += 1;
        continue;
      }

      for (let i = 0; i < senders.length; i += 1) {
        const a = senders[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < senders.length; j += 1) {
          const b = senders[j];
          if (b === undefined) continue;
          const key = `${a}|${b}`;
          coCounts.set(key, (coCounts.get(key) ?? 0) + 1);
          const ev = coEvidence.get(key) ?? [];
          pushEvidence(
            ev,
            segment.messages
              .filter((m) => m.sender_person_id === a || m.sender_person_id === b)
              .map((m) => m.message_id),
          );
          coEvidence.set(key, ev);
        }
      }

      if (groupIds.has(conversationId)) {
        for (const sender of senders) {
          const key = `${sender}|${conversationId}`;
          const inSegment = segment.messages.filter((m) => m.sender_person_id === sender);
          memberCounts.set(key, (memberCounts.get(key) ?? 0) + inSegment.length);
          const ev = memberEvidence.get(key) ?? [];
          pushEvidence(ev, inSegment.map((m) => m.message_id));
          memberEvidence.set(key, ev);
        }
      }

      // 块 → 块（§3.3.4）：同一发送者连续消息合并为一块
      const blocks: { sender: string; first: string; last: string }[] = [];
      for (const m of segment.messages) {
        const sender = m.sender_person_id;
        if (sender === null) continue;
        const tail = blocks[blocks.length - 1];
        if (tail !== undefined && tail.sender === sender) {
          tail.last = m.message_id;
          continue;
        }
        blocks.push({ sender, first: m.message_id, last: m.message_id });
      }
      for (let i = 1; i < blocks.length; i += 1) {
        const prev = blocks[i - 1];
        const cur = blocks[i];
        if (prev === undefined || cur === undefined || prev.sender === cur.sender) continue;
        const key = `${prev.sender}|${cur.sender}`;
        replyCounts.set(key, (replyCounts.get(key) ?? 0) + 1);
        const ev = replyEvidence.get(key) ?? [];
        pushEvidence(ev, [prev.last, cur.first]);
        replyEvidence.set(key, ev);
      }
    }
  }

  // ── mention（§4.2：仅 at / reply；自己提及自己不成边）───────────────────────
  const mentionCounts = new Map<string, number>();
  const mentionEvidence = new Map<string, string[]>();
  for (const mention of input.mentions ?? []) {
    if (mention.mention_kind === "at_all") continue;
    const source = senderByMessage.get(mention.message_id);
    if (source === undefined || source === null || source === mention.person_id) continue;
    const key = `${source}→${mention.person_id}`;
    mentionCounts.set(key, (mentionCounts.get(key) ?? 0) + 1);
    const ev = mentionEvidence.get(key) ?? [];
    pushEvidence(ev, [mention.message_id]);
    mentionEvidence.set(key, ev);
  }

  // ── 话题（§4.1：出现次数 ≥ MIN_TOPIC_COUNT 才成节点）────────────────────────
  const topicTotals = new Map<string, { label: string; hits: number; evidence: string[] }>();
  const topicPersonCounts = new Map<string, number>();
  for (const hit of input.topicHits ?? []) {
    const entry = topicTotals.get(hit.topic_key) ?? {
      label: hit.topic_label,
      hits: 0,
      evidence: [],
    };
    entry.hits += hit.hit_count;
    pushEvidence(entry.evidence, hit.evidence ?? []);
    topicTotals.set(hit.topic_key, entry);
    const key = `${hit.topic_key}${KEY_SEP}${hit.person_id}`;
    topicPersonCounts.set(key, (topicPersonCounts.get(key) ?? 0) + hit.hit_count);
  }
  const keptTopics = new Set(
    [...topicTotals.entries()].filter(([, t]) => t.hits >= MIN_TOPIC_COUNT).map(([k]) => k),
  );

  // ── 节点（§4.1 纳入条件；size 归一化在裁剪后统一算）─────────────────────────
  const nodes: GraphNode[] = [];
  for (const person of input.persons) {
    const sizeRaw = personMsgCount.get(person.person_id) ?? 0;
    const attrs: GraphNode["attrs"] = {
      evidence_ref: (personEvidence.get(person.person_id) ?? []).slice(0, EVIDENCE_LIMIT),
    };
    if (person.person_id !== SELF_PERSON_ID) attrs.msg_count_other = sizeRaw;
    const lastAt = input.lastMsgAtByPerson?.get(person.person_id);
    if (lastAt !== undefined) attrs.last_msg_at = lastAt;
    nodes.push({
      id: person.person_id,
      kind: "person",
      label: person.label,
      ref_id: person.person_id,
      size_raw: sizeRaw,
      size: 0,
      community_key: null,
      degree: 0,
      relation_type: person.relation_type ?? null,
      isolated: false,
      attrs,
    });
  }
  for (const conversationId of [...groupIds].sort(byKeyAsc)) {
    const sizeRaw = groupMsgCount.get(conversationId) ?? 0;
    if (sizeRaw === 0) continue; // §4.1：窗口内有消息才成节点
    // W29：会话类型由调用方注入（缺省 group），label 仍取 groups 传入的标签。
    const kind = input.conversationKindOf?.(conversationId) ?? "group";
    nodes.push({
      id: conversationId,
      kind,
      label: groupLabels.get(conversationId) ?? conversationId,
      ref_id: conversationId,
      size_raw: sizeRaw,
      size: 0,
      community_key: null,
      degree: 0,
      relation_type: null,
      isolated: false,
      attrs: { evidence_ref: (groupEvidence.get(conversationId) ?? []).slice(0, EVIDENCE_LIMIT) },
    });
  }
  for (const topicKey of [...keptTopics].sort(byKeyAsc)) {
    const entry = topicTotals.get(topicKey);
    if (entry === undefined) continue;
    const id = topicNodeId(topicKey);
    nodes.push({
      id,
      kind: "topic",
      label: entry.label,
      ref_id: id,
      size_raw: entry.hits,
      size: 0,
      community_key: null,
      degree: 0,
      relation_type: null,
      isolated: false,
      attrs: { evidence_ref: entry.evidence.slice(0, EVIDENCE_LIMIT) },
    });
  }

  // ── 边（原始计数 + 结构归一化 co_norm；strength 在全局 max 之后算）──────────
  const rawEdges: RawEdge[] = [];

  const coDeg = new Map<string, number>();
  for (const [key, count] of coCounts) {
    const [a, b] = key.split("|");
    if (a === undefined || b === undefined) continue;
    coDeg.set(a, (coDeg.get(a) ?? 0) + count);
    coDeg.set(b, (coDeg.get(b) ?? 0) + count);
  }
  for (const key of [...coCounts.keys()].sort(byKeyAsc)) {
    const [a, b] = key.split("|");
    if (a === undefined || b === undefined) continue;
    const count = coCounts.get(key) ?? 0;
    const degA = coDeg.get(a) ?? 0;
    const degB = coDeg.get(b) ?? 0;
    rawEdges.push({
      kind: "co_presence",
      source: a,
      target: b,
      weight_raw: count,
      directed: false,
      co_norm: degA > 0 && degB > 0 ? count / Math.sqrt(degA * degB) : null,
      evidence: coEvidence.get(key) ?? [],
    });
  }

  for (const key of [...replyCounts.keys()].sort(byKeyAsc)) {
    const [a, b] = key.split("|");
    if (a === undefined || b === undefined) continue;
    rawEdges.push({
      kind: "direct_reply",
      source: a,
      target: b,
      weight_raw: replyCounts.get(key) ?? 0,
      directed: false,
      co_norm: null,
      evidence: replyEvidence.get(key) ?? [],
    });
  }

  for (const key of [...mentionCounts.keys()].sort(byKeyAsc)) {
    const [source, target] = key.split("→");
    if (source === undefined || target === undefined) continue;
    rawEdges.push({
      kind: "mention",
      source,
      target,
      weight_raw: mentionCounts.get(key) ?? 0,
      directed: true,
      co_norm: null,
      evidence: mentionEvidence.get(key) ?? [],
    });
  }

  const memberDegPerson = new Map<string, number>();
  const memberDegGroup = new Map<string, number>();
  for (const [key, count] of memberCounts) {
    const [person, group] = key.split("|");
    if (person === undefined || group === undefined) continue;
    memberDegPerson.set(person, (memberDegPerson.get(person) ?? 0) + count);
    memberDegGroup.set(group, (memberDegGroup.get(group) ?? 0) + count);
  }
  for (const key of [...memberCounts.keys()].sort(byKeyAsc)) {
    const [person, group] = key.split("|");
    if (person === undefined || group === undefined) continue;
    const count = memberCounts.get(key) ?? 0;
    const degP = memberDegPerson.get(person) ?? 0;
    const degG = memberDegGroup.get(group) ?? 0;
    // §4.4 的 Louvain 输入需要人↔群边的结构权重：沿用 §4.2.1① 的 Salton 形式
    // （co_presence 的公式与设计逐字一致；人↔群的形式属实现补足，已登记待架构确认）
    const coNorm = degP > 0 && degG > 0 ? count / Math.sqrt(degP * degG) : null;
    rawEdges.push({
      kind: person === SELF_PERSON_ID ? "my_group" : "membership",
      source: person,
      target: group,
      weight_raw: count,
      directed: person === SELF_PERSON_ID,
      co_norm: coNorm,
      evidence: memberEvidence.get(key) ?? [],
    });
  }

  for (const key of [...topicPersonCounts.keys()].sort(byKeyAsc)) {
    const [topicKey, person] = key.split(KEY_SEP);
    if (topicKey === undefined || person === undefined || !keptTopics.has(topicKey)) continue;
    rawEdges.push({
      kind: "topic_affinity",
      source: person,
      target: topicNodeId(topicKey),
      weight_raw: topicPersonCounts.get(key) ?? 0,
      directed: false,
      co_norm: null,
      evidence: [],
    });
  }

  // ── 视觉强度（§4.2.1 ②）：全局 max 单调映射到 [0,1] ────────────────────────
  const maxWeight = rawEdges.reduce((max, e) => Math.max(max, e.weight_raw), 0);
  const withStrength = rawEdges.map((e) => ({
    ...e,
    strength: maxWeight === 0 ? 0 : Math.log1p(e.weight_raw) / Math.log1p(maxWeight),
  }));

  // ── 裁剪（§4.5）：先强度、再节点上限、再边上限 ─────────────────────────────
  const warnings: string[] = [];
  if (degradedSessions > 0) warnings.push("CO_OCCURRENCE_DEGRADED");

  const visible = withStrength.filter((e) => e.strength >= minStrength);
  let keptNodes = nodes;
  if (nodes.length > maxNodes) {
    keptNodes = [...nodes]
      .sort((a, b) => b.size_raw - a.size_raw || byKeyAsc(a.id, b.id))
      .slice(0, maxNodes);
    warnings.push("GRAPH_NODES_TRUNCATED");
  }
  const keptIds = new Set(keptNodes.map((n) => n.id));
  let keptEdges = visible.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  const edgeCandidates = keptEdges.length;
  if (edgeCandidates > maxEdges) {
    keptEdges = [...keptEdges]
      .sort(
        (a, b) =>
          b.weight_raw - a.weight_raw ||
          byKeyAsc(edgeId(a.kind, a.source, a.target), edgeId(b.kind, b.source, b.target)),
      )
      .slice(0, maxEdges);
    // 带数字的告警：只说 "GRAPH_EDGES_TRUNCATED" 等于没说——用户/运维看不到差多少
    warnings.push(`GRAPH_EDGES_TRUNCATED:candidate=${edgeCandidates} kept=${maxEdges}`);
  }

  const finalEdges: GraphEdge[] = keptEdges
    .map((e) => {
      const attrs: GraphEdge["attrs"] = { evidence_ref: e.evidence.slice(0, EVIDENCE_LIMIT) };
      if (e.co_norm !== null) attrs.co_norm = e.co_norm;
      return {
        id: edgeId(e.kind, e.source, e.target),
        source: e.source,
        target: e.target,
        kind: e.kind,
        weight_raw: e.weight_raw,
        strength: e.strength,
        directed: e.directed,
        attrs,
      };
    })
    .sort((a, b) => byKeyAsc(a.id, b.id));

  const degree = new Map<string, number>();
  for (const e of finalEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const maxSizeRaw = keptNodes.reduce((max, n) => Math.max(max, n.size_raw), 0);
  const finalNodes: GraphNode[] = keptNodes
    .map((n) => ({
      ...n,
      size: maxSizeRaw === 0 ? 0 : Math.log1p(n.size_raw) / Math.log1p(maxSizeRaw),
      degree: degree.get(n.id) ?? 0,
      isolated: (degree.get(n.id) ?? 0) === 0,
    }))
    .sort((a, b) => byKeyAsc(a.id, b.id));

  return { nodes: finalNodes, edges: finalEdges, degradedSessions, warnings, edgeCandidates };
}

/** `CoOccurrenceBuilder` 别名（DESIGN-12 §12 P1-5 命名）。 */
export const CoOccurrenceBuilder = { build: buildCoOccurrence };
