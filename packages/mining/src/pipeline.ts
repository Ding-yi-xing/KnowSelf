/**
 * 挖掘管线总装（DESIGN-12 §3.6 计算流水线）：读库 → 全 scope 编排 → 意图 → 图谱 → 打分 → 落库。
 * 读路径守不变量 #1：一律经 `messages.stream`（`v_chat_messages` 语义，排除已回滚批次），不碰 `chat_messages` 原表。
 * 写路径守不变量 #2：只经注入的 `MiningPipelineStore`（person-store `PersonStore` 的结构子集），**永不直连库**。
 * 时区：`active_hour_hist` 的「本地小时」取 `persons_meta.timezone`（缺省 UTC，非法值回退 UTC）。
 * 增量重算（§10.2）：`incremental.conversation_ids` = 本批落档会话 → 只重算受影响 person × scope；
 * 图谱按 step 4 与上一快照比对（新节点 / 新边 / 本批贡献 > 5% → 全量重建，否则复用）；
 * 价值打分保持全批次归一化，但只写受影响 person 的行（T3：其余行 `computed_at` 不变）。
 */
import { GraphSnapshotSchema, type ScopeKind } from "@knowself/contracts";
import {
  SELF_PERSON_ID,
  type ChatConversationRow,
  type ChatMemberRow,
  type GraphSnapshotInsert,
  type GraphSnapshotRow,
  type IntentUpsert,
  type MentionRow,
  type MetricRow,
  type MetricUpsert,
  type MiningMessageRow,
  type Period,
  type PersonRow,
} from "@knowself/person-store";
import { GRAPH_PRODUCED_BY, GRAPH_SNAPSHOT_KEEP, METRICS_PRODUCED_BY } from "./constants";
import { buildCoOccurrence, type CoOccurrenceResult } from "./co-occurrence";
import { buildGraphSnapshot, type BuiltGraphSnapshot } from "./graph";
import { classifyMessages } from "./intent-engine";
import { INTENT_LEXICON } from "./intent-lexicon";
import { buildMetrics, type MetricsScope } from "./metrics";
import { scorePersons, type ScoreWeights, type ValueScorerPersonInput } from "./value-scorer";

/** 管线所需的 store 面（person-store `PersonStore` 的结构子集；便于测试注入与守卫不变量 #2）。 */
export interface MiningPipelineStore {
  listPersons(q?: { status?: PersonRow["status"] }): PersonRow[];
  conversations: {
    list(q?: { kind?: ChatConversationRow["kind"] }): ChatConversationRow[];
    listForPerson(personId: string, q?: { active_only?: boolean }): ChatConversationRow[];
    /** §10.2 step 1：受影响会话的成员集合（`ChatMemberRow` 含 `person_id`）。 */
    listMembers(conversationId: string): ChatMemberRow[];
  };
  messages: {
    stream(q: {
      scope_kind: ScopeKind;
      scope_id?: string;
      from_ms?: number;
      to_ms?: number;
      conversation_ids?: readonly string[];
    }): AsyncIterable<MiningMessageRow>;
    /** 真实 store 中 `MessagesRepo extends MentionsRepo`（DESIGN-13 §3.1）。 */
    readMentions(q: {
      conversation_id?: string;
      person_id?: string;
      from_ms?: number;
      to_ms?: number;
    }): MentionRow[];
  };
  metrics: {
    upsert(rows: readonly MetricUpsert[]): { upserted: number; skipped_locked: number };
    /** 增量模式下读未受影响 person 的存量 global 行（价值打分全批次归一化，D3 可重建）。 */
    list(q: { person_id: string; scope_kind: MetricRow["scope_kind"] }): MetricRow[];
    /** §10.2 step 4：与上一快照比对边权变化。 */
    latestGraphSnapshot(q: {
      graph_kind: GraphSnapshotRow["graph_kind"];
      scope_kind: ScopeKind;
      scope_id: string;
    }): GraphSnapshotRow | null;
    insertGraphSnapshot(row: GraphSnapshotInsert): { snapshot_id: string };
    /** §2.1 FR-9.3：逐消息意图落库（`chat_message_intents`，主键 message_id，ON CONFLICT 覆盖）。 */
    upsertIntents(rows: readonly IntentUpsert[]): { upserted: number };
    pruneGraphSnapshots(q: {
      graph_kind: "cooccurrence" | "value_rank";
      scope_kind: ScopeKind;
      scope_id: string;
      keep: number;
    }): { deleted: number };
  };
  getMeta(key: string): string | undefined;
}

export interface RunMiningInput {
  readonly store: MiningPipelineStore;
  readonly now?: string;
  /** 时间窗（`YYYY-MM-DD`）；缺省不限。 */
  readonly window?: { readonly from?: string; readonly to?: string };
  readonly period?: Period;
  readonly periodKey?: string;
  readonly weights?: ScoreWeights;
  /** `false` = dry-run（只算不落库）。 */
  readonly write?: boolean;
  /** 增量重算（§10.2）：本批落档涉及的会话 id；缺省全量重算。 */
  readonly incremental?: { readonly conversation_ids: readonly string[] };
}

export interface RunMiningResult {
  readonly rows: MetricUpsert[];
  readonly graph: BuiltGraphSnapshot;
  readonly upserted: number;
  readonly skippedLocked: number;
  /** 本结果对应的图谱快照 id；增量复用上一快照时为其 id（未新落）。 */
  readonly snapshotId: string | null;
  readonly pruned: number;
  readonly warnings: string[];
  /** 纳入计算的 person 数（增量时为受影响 person 数）。 */
  readonly persons: number;
  readonly scopes: number;
  /** 意图落库行数（dry-run 为 0）。 */
  readonly intentsWritten: number;
}

const DAY_MS = 86_400_000;

function dayToMs(day: string | undefined): number | undefined {
  if (day === undefined) return undefined;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** `persons_meta.timezone` → 本地小时函数；缺失或非法回退 UTC。 */
function hourOfFromTimezone(timeZone: string | undefined): (tsMs: number) => number {
  const fallback = (tsMs: number): number => new Date(tsMs).getUTCHours();
  if (timeZone === undefined || timeZone.length === 0) return fallback;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    });
    return (tsMs: number): number => Number(formatter.format(new Date(tsMs))) % 24;
  } catch {
    return fallback;
  }
}

async function collect(stream: AsyncIterable<MiningMessageRow>): Promise<MiningMessageRow[]> {
  const rows: MiningMessageRow[] = [];
  for await (const row of stream) rows.push(row);
  return rows;
}

/** 单 scope 计算：已收集消息 → §3.5 指标行 + 逐消息意图行 + （global 时）价值打分输入。 */
function computeScope(
  person: PersonRow,
  scope: MetricsScope,
  messages: readonly MiningMessageRow[],
  hourOf: (tsMs: number) => number,
  now: string,
  input: RunMiningInput,
): {
  rows: MetricUpsert[];
  warnings: string[];
  scorerInput: ValueScorerPersonInput | null;
  /** §2.1 FR-9.3：本 scope 全部消息的意图行（含 'me' 的消息；`computed_at` 传 now 保确定性）。 */
  intentRows: IntentUpsert[];
} {
  // 逐消息意图（落库 §2.1 FR-9.3 用全量；`intent_dist` 只统计「对方」消息的意图）
  const classified = classifyMessages(messages, INTENT_LEXICON, now);
  const senderByMessage = new Map(messages.map((m) => [m.message_id, m.sender_person_id]));
  const intents = classified
    .filter((row) => senderByMessage.get(row.message_id) === person.person_id)
    .map((row) => row.intent);

  const built = buildMetrics({
    personId: person.person_id,
    scope,
    messages,
    intents,
    hourOf,
    computedAt: now,
    ...(input.period === undefined ? {} : { period: input.period }),
    ...(input.periodKey === undefined ? {} : { periodKey: input.periodKey }),
  });

  let scorerInput: ValueScorerPersonInput | null = null;
  if (scope.scope_kind === "global") {
    const valueOf = (key: string): number | null =>
      built.rows.find((row) => row.metric_key === key)?.metric_value ?? null;
    const jsonOf = (key: string): string | null =>
      built.rows.find((row) => row.metric_key === key)?.metric_value_json ?? null;
    const msgOther = valueOf("msg_count_other") ?? 0;
    const sessionCount = valueOf("session_count") ?? 0;
    const totalMsgs = valueOf("msg_count_total") ?? 0;
    const intentJson = jsonOf("intent_dist");
    scorerInput = {
      person_id: person.person_id,
      msgCountOther90d: msgOther,
      daysSinceLastMsg:
        person.last_msg_at === null
          ? 3650
          : Math.max(0, (Date.parse(now) - Date.parse(person.last_msg_at)) / DAY_MS),
      initiativeRatioOther: valueOf("initiative_ratio_other") ?? 0,
      replyLatencyP50Ms: valueOf("reply_latency_p50_ms"),
      msgCountMe: valueOf("msg_count_me") ?? 0,
      msgCountOther: msgOther,
      avgSessionMsgs90d: sessionCount > 0 ? totalMsgs / sessionCount : 0,
      intentDist: intentJson === null ? {} : (JSON.parse(intentJson) as Record<string, number>),
      degree: 0, // 由图谱节点度数回填
    };
  }
  return { rows: built.rows, warnings: built.warnings, scorerInput, intentRows: classified };
}

/** 增量模式下未受影响 person 的价值输入：读存量 global 行（存量行即全量重算会产出的值，D3）。 */
function scorerInputFromStoredRows(
  store: MiningPipelineStore,
  person: PersonRow,
  now: string,
): ValueScorerPersonInput | null {
  const rows = store.metrics.list({ person_id: person.person_id, scope_kind: "global" });
  if (rows.length === 0) return null; // 从未产出指标（无消息）→ 与全量路径一致地不入批
  const valueOf = (key: string): number | null =>
    rows.find((row) => row.metric_key === key)?.metric_value ?? null;
  const jsonOf = (key: string): string | null =>
    rows.find((row) => row.metric_key === key)?.metric_value_json ?? null;
  const msgOther = valueOf("msg_count_other") ?? 0;
  const sessionCount = valueOf("session_count") ?? 0;
  const totalMsgs = valueOf("msg_count_total") ?? 0;
  const intentJson = jsonOf("intent_dist");
  return {
    person_id: person.person_id,
    msgCountOther90d: msgOther,
    daysSinceLastMsg:
      person.last_msg_at === null
        ? 3650
        : Math.max(0, (Date.parse(now) - Date.parse(person.last_msg_at)) / DAY_MS),
    initiativeRatioOther: valueOf("initiative_ratio_other") ?? 0,
    replyLatencyP50Ms: valueOf("reply_latency_p50_ms"),
    msgCountMe: valueOf("msg_count_me") ?? 0,
    msgCountOther: msgOther,
    avgSessionMsgs90d: sessionCount > 0 ? totalMsgs / sessionCount : 0,
    intentDist: intentJson === null ? {} : (JSON.parse(intentJson) as Record<string, number>),
    degree: 0, // 后续统一回填
  };
}

/**
 * §10.2 step 4：本批贡献 vs 上一快照。新节点 / 新边 / 某边本批贡献 > 5% 旧权重 → 全量重建。
 * 局部构建（`minEdgeStrength=0`）的 `weight_raw` 即受影响会话对该边的贡献（权重可加）。
 */
function needsGraphRebuild(prev: GraphSnapshotRow, partial: CoOccurrenceResult): boolean {
  const payload = GraphSnapshotSchema.parse(JSON.parse(prev.payload_json));
  const nodeIds = new Set(payload.nodes.map((node) => node.id));
  // 按 (kind, source, target) 查旧权重——不能用 `edge.id`：`id` 对两端排序，
  // 反向的 direct_reply 边（张三→me 与 me→张三）会得到相同 id 导致覆盖
  const weights = new Map(
    payload.edges.map((edge) => [`${edge.kind}\u0000${edge.source}\u0000${edge.target}`, edge.weight_raw]),
  );
  for (const node of partial.nodes) {
    if (!nodeIds.has(node.id)) return true;
  }
  for (const edge of partial.edges) {
    const prevWeight = weights.get(`${edge.kind}\u0000${edge.source}\u0000${edge.target}`);
    if (prevWeight === undefined) return true;
    if (prevWeight > 0 && edge.weight_raw > prevWeight * 0.05) return true;
  }
  return false;
}

/**
 * 图谱节点 label 的兜底。
 *
 * 为什么要兜底：person 行的 `display_name` 可能是空串（chat-ingest 对未识别发送者会写空），
 * 而 `GraphSnapshotSchema` 的 label 是 `min(1)`——那是刻意的（空 label 上屏就是无名圈）。
 * 所以**不放宽契约**，在生产侧给一个稳定名字。
 *
 * 为什么用 person_id 前 6 位而不是序号：序号随节点顺序变，刷新一次名字就变了。
 *
 * @param person 人物行（可能 label 为空）
 * @returns 非空 label
 */
/**
 * 把空字符串/纯空白归一成 `null`（供 `?? fallback` 使用）。
 *
 * 为什么需要：`?? ` 只挡 null/undefined，**挡不住空串**——这正是 W-9 真机那次
 * `nodes[4].label` 为空的原因（会话标题是空串，`groupLabels.get() ?? id` 直接放行了 ""）。
 *
 * @param value 原始标签
 * @returns 非空标签，或 null
 */
export function nonEmptyLabel(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function labelOf(person: { person_id: string; display_name: string }): string {
  const name = person.display_name.trim();
  if (name !== "") return name;
  return `未命名(${person.person_id.slice(0, 6)})`;
}

export async function runMiningPipeline(input: RunMiningInput): Promise<RunMiningResult> {
  const store = input.store;
  const now = input.now ?? new Date().toISOString();
  const write = input.write ?? true;
  const fromMs = dayToMs(input.window?.from);
  const toMs = dayToMs(input.window?.to);
  const hourOf = hourOfFromTimezone(store.getMeta("timezone"));
  const warnings: string[] = [];

  // §4.1：active 且非 merged；`me` 自身不产 person_metrics（指标是 (me,P) 对）
  const persons = store
    .listPersons()
    .filter((person) => person.status === "active" && person.merged_into === null)
    .filter((person) => person.person_id !== SELF_PERSON_ID);

  const conversations = store.conversations.list();
  const groupIds = new Set(
    conversations.filter((conv) => conv.kind === "group").map((conv) => conv.conversation_id),
  );
  const groupLabels = new Map(conversations.map((conv) => [conv.conversation_id, conv.title]));

  const incrementalConvIds =
    input.incremental === undefined
      ? null
      : [...new Set(input.incremental.conversation_ids)].sort();

  const metricsRows: MetricUpsert[] = [];
  const scorerInputs: ValueScorerPersonInput[] = [];
  const messagesByConversation = new Map<string, MiningMessageRow[]>();
  /** 逐消息意图（§2.1 FR-9.3）：同一消息会出现在多个 scope，按 message_id 去重（先到先得，遍历序确定）。 */
  const intentByMessage = new Map<string, IntentUpsert>();
  let scopeCount = 0;

  const streamQ = (
    scopeKind: ScopeKind,
    scopeId: string | undefined,
    conversationIds?: readonly string[],
  ) => ({
    scope_kind: scopeKind,
    ...(scopeId === undefined ? {} : { scope_id: scopeId }),
    ...(conversationIds === undefined ? {} : { conversation_ids: conversationIds }),
    ...(fromMs === undefined ? {} : { from_ms: fromMs }),
    ...(toMs === undefined ? {} : { to_ms: toMs }),
  });

  /** 按会话取消息（带缓存）：增量模式下 global scope 与图谱重建共用。 */
  async function messagesOf(conversationId: string): Promise<MiningMessageRow[]> {
    const cached = messagesByConversation.get(conversationId);
    if (cached !== undefined) return cached;
    const kind = groupIds.has(conversationId) ? "group" : "direct";
    const messages = await collect(store.messages.stream(streamQ(kind, conversationId)));
    messagesByConversation.set(conversationId, messages);
    return messages;
  }

  // §10.2 step 1：受影响 person 集合 = 受影响会话成员 ∪ 发送者
  let affectedPersonIds: Set<string> | null = null;
  if (incrementalConvIds !== null) {
    const memberIds = new Set<string>();
    const senderIds = new Set<string>();
    for (const conversationId of incrementalConvIds) {
      for (const member of store.conversations.listMembers(conversationId)) {
        memberIds.add(member.person_id);
      }
      for (const message of await messagesOf(conversationId)) {
        if (message.sender_person_id !== null) senderIds.add(message.sender_person_id);
      }
    }
    affectedPersonIds = new Set([...memberIds, ...senderIds]);
  }
  const isAffected = (personId: string): boolean =>
    affectedPersonIds === null || affectedPersonIds.has(personId);

  // ── 逐 person × scope：全量 = 全部；增量 = 受影响 person 的 global + 受影响会话（§10.2 step 2）──
  for (const person of persons) {
    const personConversations = store
      .conversations.listForPerson(person.person_id, { active_only: true })
      .map((conv) => conv.conversation_id)
      .sort();
    const scopes: MetricsScope[] =
      incrementalConvIds === null
        ? [
            { scope_kind: "global", scope_id: "" },
            ...personConversations.map((conversationId) => ({
              scope_kind: (groupIds.has(conversationId) ? "group" : "direct") as ScopeKind,
              scope_id: conversationId,
            })),
          ]
        : isAffected(person.person_id)
          ? [
              { scope_kind: "global", scope_id: "" },
              ...incrementalConvIds.map((conversationId) => ({
                scope_kind: (groupIds.has(conversationId) ? "group" : "direct") as ScopeKind,
                scope_id: conversationId,
              })),
            ]
          : [];

    for (const scope of scopes) {
      scopeCount += 1;
      const messages =
        scope.scope_kind === "global"
          ? incrementalConvIds === null
            ? // 全量：单流跨会话排序（keyset 顺序即 (ts_ms, message_id) 升序）
              await collect(store.messages.stream(streamQ("global", undefined, personConversations)))
            : // 增量：该 person 的全部会话按 (ts_ms, message_id) 归并，与全量路径同序
              (await Promise.all(personConversations.map((cid) => messagesOf(cid))))
                .flat()
                .sort(
                  (a, b) =>
                    a.ts_ms - b.ts_ms ||
                    (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0),
                )
          : await messagesOf(scope.scope_id);
      if (messages.length === 0) continue;

      const computed = computeScope(person, scope, messages, hourOf, now, input);
      warnings.push(...computed.warnings);
      metricsRows.push(...computed.rows);
      for (const row of computed.intentRows) {
        if (!intentByMessage.has(row.message_id)) intentByMessage.set(row.message_id, row);
      }
      if (computed.scorerInput !== null) scorerInputs.push(computed.scorerInput);
    }
  }

  // ── 图谱（§4；增量时先按 §10.2 step 4 判定复用或重建）────────────────────────
  const mentionsByMessage = new Map<string, MentionRow[]>();
  for (const mention of store.messages.readMentions({})) {
    mentionsByMessage.set(mention.message_id, [
      ...(mentionsByMessage.get(mention.message_id) ?? []),
      mention,
    ]);
  }
  const mentionInput = [...mentionsByMessage.values()].flat().map((mention) => ({
    message_id: mention.message_id,
    person_id: mention.person_id,
    mention_kind: mention.mention_kind,
  }));
  // §4.1：图谱 person 节点 = active 且非 merged 的 contact + self（'me' 也是节点）。
  // 注意：不能复用上面的 `persons`（指标视角排除 'me'），否则 my_group / co_presence 等
  // 所有涉及 'me' 的边会被 co-occurrence 的 keptIds 裁剪静默丢弃（7b-7b 潜藏缺陷，7b-7c 实测暴露）。
  const personNodes = store
    .listPersons()
    .filter(
      (person) =>
        person.status === "active" &&
        person.merged_into === null &&
        (person.subject_kind === "contact" || person.subject_kind === "self"),
    )
    .map((person) => ({
      person_id: person.person_id,
      // label 兜底（W-9 真机实测）：有些 person 行 `display_name` 是空串（chat-ingest 对
      // 未识别发送者会写空），而 `GraphSnapshotSchema` 要求 label ≥1 字符 —— 不放宽契约
      // （空 label 上屏就是"无名圈"），在**生产侧**兜一个稳定可预期的名字。
      // 用 person_id 前 6 位而不是序号：序号会随节点顺序变，刷新一次名字就变了。
      label: labelOf(person),
    }));
  /** W29：会话类型判定（@chatroom / @//chatroom/ 为群，其余为单聊）。 */
  const conversationKindOf = (id: string): "group" | "direct" =>
    id.endsWith("@chatroom") || id.includes("@//chatroom/") ? "group" : "direct";

  /**
   * W29 direct 节点 label：取会话内「非我且有归属」的消息发送者在 `persons` 里的真名；
   * 取不到 / 空串 / 仍是 wxid_ 时兜 `单聊·<uid 末 4 位>`。每次挖掘重算，不做缓存。
   * `MiningPipelineStore` 没有 aliases 面，故从消息行的 `sender_person_id` 反查 persons。
   */
  const directLabelOf = (conversationId: string): string => {
    const uid = conversationId.slice(conversationId.indexOf(":") + 1);
    const rows = messagesByConversation.get(conversationId) ?? [];
    for (const row of rows) {
      if (row.role === "me" || row.sender_person_id === null) continue;
      const person = persons.find((candidate) => candidate.person_id === row.sender_person_id);
      const name = person?.display_name?.trim() ?? "";
      if (name !== "" && !/^wxid_/.test(name)) return name;
    }
    return `单聊·${uid.slice(-4)}`;
  };

  const groupNodes = [...groupIds].sort().map((conversationId) => ({
    conversation_id: conversationId,
    // 群节点同样要兜底：会话标题可能是空串（真机实测 `nodes[4].label` 就是空），
    // 而 schema 要求 label ≥1 字符。空标题时退回 conversation_id（稳定、可读、不随顺序变）。
    label:
      conversationKindOf(conversationId) === "direct"
        ? directLabelOf(conversationId)
        : nonEmptyLabel(groupLabels.get(conversationId)) ?? conversationId,
  }));
  const timeFromTo = {
    ...(input.window?.from === undefined ? {} : { timeFrom: input.window.from }),
    ...(input.window?.to === undefined ? {} : { timeTo: input.window.to }),
  };

  let graph: BuiltGraphSnapshot;
  let graphFresh: boolean;
  let snapshotId: string | null = null;
  let pruned = 0;

  if (incrementalConvIds === null) {
    graph = buildGraphSnapshot({
      persons: personNodes,
      groups: groupNodes,
      messagesByConversation,
      groupConversationIds: groupIds,
      mentions: mentionInput,
      conversationKindOf,
      now,
      ...timeFromTo,
    });
    graphFresh = true;
  } else {
    const prev = store.metrics.latestGraphSnapshot({
      graph_kind: "cooccurrence",
      scope_kind: "global",
      scope_id: "",
    });
    // 本批贡献的局部构建；minEdgeStrength=0 以原始权重做 step 4 判定（局部强度无意义）
    const partial = buildCoOccurrence({
      persons: personNodes,
      groups: groupNodes,
      messagesByConversation: new Map(
        incrementalConvIds.map((cid) => [cid, messagesByConversation.get(cid) ?? []]),
      ),
      groupConversationIds: groupIds,
      mentions: mentionInput,
      minEdgeStrength: 0,
    });
    if (prev !== null && !needsGraphRebuild(prev, partial)) {
      // 复用上一快照：不落新快照、不采编局部构建的告警（它只服务于 step 4 判定）
      graph = { snapshot: GraphSnapshotSchema.parse(JSON.parse(prev.payload_json)), warnings: [] };
      graphFresh = false;
      snapshotId = prev.snapshot_id;
    } else {
      // 全量重建：先补全其余会话的消息
      for (const conversation of conversations) await messagesOf(conversation.conversation_id);
      graph = buildGraphSnapshot({
        persons: personNodes,
        groups: groupNodes,
        messagesByConversation,
        groupConversationIds: groupIds,
        mentions: mentionInput,
        conversationKindOf,
        now,
        ...timeFromTo,
      });
      graphFresh = true;
    }
  }
  warnings.push(...graph.warnings);
  const degreeByPerson = new Map(
    graph.snapshot.nodes
      .filter((node) => node.kind === "person")
      .map((node) => [node.id, node.degree]),
  );

  // ── 价值打分（§6；增量保持全批次归一化，但只写受影响 person 的行）───────────
  let batchInputs: ValueScorerPersonInput[];
  if (incrementalConvIds === null) {
    batchInputs = scorerInputs;
  } else {
    const freshByPerson = new Map(scorerInputs.map((entry) => [entry.person_id, entry]));
    batchInputs = [];
    for (const person of persons) {
      if (isAffected(person.person_id)) {
        const fresh = freshByPerson.get(person.person_id);
        if (fresh !== undefined) batchInputs.push(fresh);
      } else {
        const stored = scorerInputFromStoredRows(store, person, now);
        if (stored !== null) batchInputs.push(stored);
      }
    }
  }
  const scored = scorePersons({
    persons: batchInputs.map((entry) => ({
      ...entry,
      degree: degreeByPerson.get(entry.person_id) ?? 0,
    })),
    now,
    ...(input.weights === undefined ? {} : { weights: input.weights }),
  });
  metricsRows.push(
    ...(incrementalConvIds === null
      ? scored.rows
      : scored.rows.filter((row) => affectedPersonIds?.has(row.person_id))),
  );

  // ── 落库（写路径只经 store；dry-run 不写）────────────────────────────────────
  let upserted = 0;
  let skippedLocked = 0;
  let intentsWritten = 0;
  if (write) {
    const result = store.metrics.upsert(metricsRows);
    upserted = result.upserted;
    skippedLocked = result.skipped_locked;
    intentsWritten = store.metrics.upsertIntents([...intentByMessage.values()]).upserted;
    if (graphFresh) {
      const inserted = store.metrics.insertGraphSnapshot({
        graph_kind: "cooccurrence",
        scope_kind: "global",
        scope_id: "",
        time_from: input.window?.from ?? null,
        time_to: input.window?.to ?? null,
        params_json: JSON.stringify(graph.snapshot.params),
        payload_json: JSON.stringify(graph.snapshot),
        node_count: graph.snapshot.nodes.length,
        edge_count: graph.snapshot.edges.length,
        community_count: graph.snapshot.communities.length,
        produced_by: GRAPH_PRODUCED_BY,
        computed_at: now,
      });
      snapshotId = inserted.snapshot_id;
      pruned = store.metrics.pruneGraphSnapshots({
        graph_kind: "cooccurrence",
        scope_kind: "global",
        scope_id: "",
        keep: GRAPH_SNAPSHOT_KEEP,
      }).deleted;
    }
  }

  return {
    rows: metricsRows,
    graph,
    upserted,
    skippedLocked,
    snapshotId,
    pruned,
    warnings,
    persons:
      incrementalConvIds === null
        ? persons.length
        : persons.filter((person) => isAffected(person.person_id)).length,
    scopes: scopeCount,
    intentsWritten,
  };
}

/** 版本位（审计用）：指标 + 图谱。 */
export const PIPELINE_PRODUCED_BY = { metrics: METRICS_PRODUCED_BY, graph: GRAPH_PRODUCED_BY };

/** `MiningPipeline` 别名（§12 / 7b-7b 命名）。 */
export const MiningPipeline = { run: runMiningPipeline };
