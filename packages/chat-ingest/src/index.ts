/**
 * chat-ingest 公开入口：`ingestExport()`。
 *
 * 两种模式：
 *   - **pipeline**（生产路径；注入 `proposalSink` + `chatCommitter` + `source_id`）：
 *     reader → normalize → staging → Tier 判定 → 游标过滤 → proposal →
 *     Tier A 自动 accept / Tier B 入队（DESIGN-11 §2.1 阶段 [2]~[9]）。
 *   - **legacy**（降级路径；未注入上述依赖，仅供既有单测与最小可跑脚本）：
 *     reader → normalize → staging → 直接 `commitStaged`，`proposal_id` 传合成值
 *     `chat-ingest:<batch_id>`。**不产 proposal / 不判 Tier / 不预筛游标**。
 *
 * 硬约束（§6.3）：pipeline 模式下 Tier A **也必须**经
 * `proposal → sink.accept → ChatMessageCommitter.commit`，绝不允许直接 INSERT `chat_messages`。
 */
import { randomUUID } from "node:crypto";
import type {
  ChatPlatform,
  ConversationKind,
  ConversationUpsert,
  PersonStore,
  StagingInsert,
} from "@knowself/person-store";
import type { ChatMessageCommitterLike } from "./committer";
import { CursorStore, IncrementalFilter } from "./cursor";
import {
  compileDescriptor,
  TARRY9110_TXT_DESCRIPTOR,
  type CompiledDescriptor,
} from "./descriptor";
import { ChatIngestError, describeError } from "./errors";
import {
  normalizeConversation,
  type NormalizedConversation,
  type NormalizedMessage,
} from "./normalize";
import {
  ProposalBuilder,
  type ChatIngestProposalDraft,
  type PendingProposalRef,
} from "./proposal";
import {
  Tarry9110TxtReader,
  type IChatExportReader,
  type ProbeResult,
  type RawConversationRef,
} from "./reader";
import { GENERIC_JSON_DESCRIPTOR, JsonExportReader } from "./readers/json";
import {
  TierJudge,
  type TierContentTypeMarkers,
  type TierDiagnostics,
  type TierLabel,
  type TierVerdict,
} from "./tier";

// ──────────────────────────────────────────────────────────────────────────
//  依赖注入位（DESIGN-11 §6.3 / §7.3）
// ──────────────────────────────────────────────────────────────────────────

/** Tier 名单（`data/chat-ingest/*.txt` 的内容；**由调用方读入**，领域函数不碰文件）。 */
export interface IngestTierConfig {
  /** `auto_ok.txt`：Tier A 自动落档白名单，每行一个 `conversation_id`。 */
  auto_ok?: readonly string[];
  /** `review.txt`：人工强制复核，每行一个 `conversation_id` 或 `sender_id`（`MANUAL_FLAG`）。 */
  review?: readonly string[];
}

/**
 * proposal 适配器：由 `apps/server`（或测试）实现，把草稿写入 `ingestion_proposals`
 * 并在 Tier A 时调 `ingestion.acceptProposal`。
 * 放在注入位而非直接依赖 `ingestion`，保持 `chat-ingest` 的包边界干净。
 */
export interface IngestProposalSink {
  /**
   * 该会话既有的 pending proposal 列表（§6.5 去重判定；2A 修订）。
   *
   * **按会话作用域查询，不带 `batch_id`**：每次 CLI 运行都会生成新的 `batch_id`，
   * 带上它等于对重跑失明。是否「已覆盖」由调用方按 `message_ids` 集合差集判定。
   */
  listPending(input: {
    conversation_id: string;
  }): readonly PendingProposalRef[];
  /** 写入一条 pending proposal（幂等由调用方与 §6.5 去重共同保证）。 */
  create(proposal: ChatIngestProposalDraft): void;
  /** 规则自动 accept（Tier A）；实现方须走 `ingestion.acceptProposal` → committer。 */
  accept(proposalId: string): void;
  /**
   * 可选：适配器自报的、**用户可见**的告警（如 pending 扫描触顶导致去重可能不完整）。
   *
   * 为什么是可选方法：既有实现（含测试桩）无需改动即可继续工作。
   * 为什么必须有这个出口：只在服务端 `console.warn` 的降级，对用户等于没降级。
   * 约定：**取走即清空**——调用方每轮取一次，不得跨轮累积。
   */
  drainWarnings?(): readonly string[];
}

export interface IngestExportOptions {
  store: PersonStore;
  /** 导出产物目录（**只读**；DESIGN-11 §3.1）。 */
  dir: string;
  /** 复用批次 ID（断点续跑）；缺省新生成 UUID v4。 */
  batch_id?: string;
  now?: string;
  /** 关键字过滤（大小写不敏感，匹配 conversation_key / title）；缺省全量。 */
  only?: readonly string[];
  /** 写入 `ingest_batches.tool_version`；txt 产物自身不带版本，缺省 `unknown`。 */
  tool_version?: string;
  /** reader 选择：默认 `txt`（P0 实测产物）；`json` = 归一化 JSON 导出（§3.5）。 */
  reader?: "txt" | "json";
  /** 本批次对应的 Source id（pipeline 模式必填，写 proposal.source_id，§6.3）。 */
  source_id?: string;
  /** proposal 适配器（pipeline 模式必填）。 */
  proposalSink?: IngestProposalSink;
  /** 落档提交器（pipeline 模式必填；缺省可用 `createChatMessageCommitter({ store })`）。 */
  chatCommitter?: ChatMessageCommitterLike;
  /** Tier 名单（auto_ok / review）。 */
  tierConfig?: IngestTierConfig;
}

export interface IngestIssueSummary {
  conversation_key: string;
  line_no: number;
  code: string;
  excerpt: string;
}

export interface IngestExportResult {
  batch_id: string;
  reader_id: string;
  conversation_count: number;
  message_count: number;
  committed: number;
  skipped: number;
  issues: readonly IngestIssueSummary[];
  /** `pipeline` = 完整管线；`legacy` = 未注入依赖时的降级路径（不产 proposal）。 */
  mode: "pipeline" | "legacy";
  /** 会话级分层统计（`pipeline` 模式有效）。 */
  tier: { auto: number; review: number };
  /** proposal 统计（`pipeline` 模式有效）。 */
  proposals: {
    created: number;
    accepted: number;
    queued: number;
    reused: number;
    skipped_messages: number;
  };
  /** 被增量游标过滤掉的消息数（`pipeline` 模式有效）。 */
  cursor_filtered: number;
  /**
   * 适配器自报的、用户可见的告警（来自 `IngestProposalSink.drainWarnings`）。
   * 与 `issues` 分开：`issues` 是**解析问题**（数据本身有缺陷），`warnings` 是
   * **本工具的能力/上限提示**（数据可能没问题，但本次结论不完整）。
   *
   * 注意：`IngestExportResult` 有两条构造路径（`runLegacyMode` / `runPipelineMode`），
   * 新增字段时必须同时补上——漏一条就是「有字段没值」。
   */
  warnings: readonly string[];
}

/** 无适配器告警时的默认值（legacy 路径共用，避免在多处 return 里散写 `[]`）。 */
const NO_WARNINGS: readonly string[] = Object.freeze([] as string[]);

// ──────────────────────────────────────────────────────────────────────────
//  内部：reader → 归一化会话的 feed 抽象（txt / json 两种 reader 同构）
// ──────────────────────────────────────────────────────────────────────────

interface LoadedConversation {
  conversation: NormalizedConversation;
  diagnostics: TierDiagnostics;
}

interface FeedJob {
  key: string;
  load(): Promise<LoadedConversation>;
}

interface IngestFeed {
  id: string;
  platform: ChatPlatform;
  tool_version: string;
  content_type_markers: TierContentTypeMarkers;
  probe(): Promise<ProbeResult>;
  jobs(): Promise<readonly FeedJob[]>;
}

function parseFailureCount(conversation: NormalizedConversation): number {
  return conversation.issues.filter(
    (issue) => issue.code === "LINE_UNPARSED" || issue.code === "TIMESTAMP_UNKNOWN",
  ).length;
}

/** txt feed：复用 P0 的 `Tarry9110TxtReader` + `normalizeConversation`（纯函数）。 */
function createTxtFeed(
  reader: IChatExportReader,
  compiled: CompiledDescriptor,
  dir: string,
): IngestFeed {
  const spec = compiled.spec;
  return {
    id: reader.id,
    platform: reader.platform,
    tool_version: reader.tool_version,
    content_type_markers: {
      exact: Object.keys(spec.content_type_exact),
      prefixes: Object.keys(spec.content_type_prefix),
    },
    probe: () => reader.probe(dir),
    async jobs(): Promise<readonly FeedJob[]> {
      const refs: readonly RawConversationRef[] = await reader.listConversations(dir);
      return refs.map((ref) => ({
        key: ref.conversation_key,
        async load(): Promise<LoadedConversation> {
          const raw = await reader.readConversation(ref);
          const conversation = normalizeConversation(raw, compiled);
          return {
            conversation,
            diagnostics: {
              total_lines: raw.lines.length,
              parsed_failures: parseFailureCount(conversation),
              encoding_loss_ratio: raw.encoding_loss_ratio ?? 0,
              has_nul: raw.has_nul ?? false,
            },
          };
        },
      }));
    },
  };
}

/** JSON feed：`JsonExportReader` 直接产出归一化会话（字段映射在 descriptor 里）。 */
function createJsonFeed(reader: JsonExportReader, dir: string): IngestFeed {
  return {
    id: reader.id,
    platform: reader.platform,
    tool_version: reader.tool_version,
    content_type_markers: reader.content_type_markers,
    probe: () => reader.probe(dir),
    async jobs(): Promise<readonly FeedJob[]> {
      const refs = await reader.listConversations(dir);
      return refs.map((ref) => ({
        key: ref.conversation_key,
        async load(): Promise<LoadedConversation> {
          const read = await reader.read(ref);
          return { conversation: read.conversation, diagnostics: read.diagnostics };
        },
      }));
    },
  };
}

function createFeed(options: IngestExportOptions): IngestFeed {
  const toolVersion = options.tool_version ?? "unknown";
  if (options.reader === "json") {
    return createJsonFeed(new JsonExportReader(GENERIC_JSON_DESCRIPTOR, toolVersion), options.dir);
  }
  const compiled = compileDescriptor(TARRY9110_TXT_DESCRIPTOR);
  return createTxtFeed(
    new Tarry9110TxtReader(compiled, toolVersion),
    compiled,
    options.dir,
  );
}

// ──────────────────────────────────────────────────────────────────────────
//  内部：公共小工具
// ──────────────────────────────────────────────────────────────────────────

interface OneResult {
  messages: number;
  committed: number;
  skipped: number;
}

function matchesOnly(conversation: NormalizedConversation, only: readonly string[]): boolean {
  if (only.length === 0) return true;
  const hay = `${conversation.conversation_key} ${conversation.title}`.toLowerCase();
  return only.some((keyword) => hay.includes(keyword.toLowerCase()));
}

/** 会话元数据：`title` / `kind` 来自头部；`member_count` = 有发言的人（系统消息不计）。 */
function conversationUpsert(
  conversation: NormalizedConversation,
  readerId: string,
): ConversationUpsert {
  const speakers = new Set(
    conversation.messages.filter((message) => message.role !== "system").map((m) => m.sender_id),
  );
  return {
    conversation_id: `${conversation.platform}:${conversation.conversation_key}`,
    platform: conversation.platform,
    kind: conversation.kind,
    title: conversation.title,
    member_count: speakers.size,
    first_msg_at:
      conversation.first_ts_ms === null ? null : new Date(conversation.first_ts_ms).toISOString(),
    last_msg_at:
      conversation.last_ts_ms === null ? null : new Date(conversation.last_ts_ms).toISOString(),
    source_ref: JSON.stringify({
      reader_id: readerId,
      raw_key: conversation.conversation_key,
      title_snapshot: conversation.title,
    }),
  };
}

function toStagingRows(conversation: NormalizedConversation): StagingInsert[] {
  return conversation.messages.map((message: NormalizedMessage) => ({
    ...message,
    platform: conversation.platform,
  }));
}

function conversationIdOf(conversation: NormalizedConversation): string {
  return `${conversation.platform}:${conversation.conversation_key}`;
}

function emptyTierStats(): IngestExportResult["tier"] {
  return { auto: 0, review: 0 };
}

function emptyProposalStats(): IngestExportResult["proposals"] {
  return { created: 0, accepted: 0, queued: 0, reused: 0, skipped_messages: 0 };
}

// ──────────────────────────────────────────────────────────────────────────
//  legacy 模式（既有行为，逐字保留）
// ──────────────────────────────────────────────────────────────────────────

function ingestOneLegacy(
  store: PersonStore,
  batchId: string,
  now: string,
  conversation: NormalizedConversation,
  readerId: string,
): OneResult {
  const conversation_id = conversationIdOf(conversation);
  const rows = toStagingRows(conversation);
  if (rows.length > 0) {
    store.staging.stageMessages({ batch_id: batchId, conversation_id, rows, now });
  }
  const result = store.commitStaged({
    batch_id: batchId,
    conversation_id,
    proposal_id: `chat-ingest:${batchId}`,
    now,
    conversation: conversationUpsert(conversation, readerId),
  });
  return { messages: rows.length, committed: result.committed, skipped: result.skipped };
}

async function runLegacyMode(
  options: IngestExportOptions,
  feed: IngestFeed,
  batchId: string,
  now: string,
): Promise<IngestExportResult> {
  const { store } = options;
  const jobs = await feed.jobs();
  const issues: IngestIssueSummary[] = [];
  let conversation_count = 0;
  let message_count = 0;
  let committed = 0;
  let skipped = 0;
  for (const job of jobs) {
    let loaded: LoadedConversation;
    try {
      loaded = await job.load();
    } catch (cause) {
      issues.push({
        conversation_key: job.key,
        line_no: 0,
        code: "READER_FAILED",
        excerpt: describeError(cause).slice(0, 200),
      });
      continue;
    }
    const conversation = loaded.conversation;
    if (!matchesOnly(conversation, options.only ?? [])) continue;
    const one = ingestOneLegacy(store, batchId, now, conversation, feed.id);
    conversation_count += 1;
    message_count += one.messages;
    committed += one.committed;
    skipped += one.skipped;
    for (const issue of conversation.issues) {
      issues.push({ conversation_key: conversation.conversation_key, ...issue });
    }
  }
  store.staging.finishBatch({
    batch_id: batchId,
    status: "succeeded",
    conversation_count,
    message_count,
    skipped_count: skipped,
    now,
  });
  return {
    batch_id: batchId,
    reader_id: feed.id,
    conversation_count,
    message_count,
    committed,
    skipped,
    issues,
    mode: "legacy",
    tier: emptyTierStats(),
    proposals: emptyProposalStats(),
    cursor_filtered: 0,
    warnings: NO_WARNINGS,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  pipeline 模式（DESIGN-11 §2.1 / §5 / §6）
// ──────────────────────────────────────────────────────────────────────────

interface PipelineDeps {
  store: PersonStore;
  sink: IngestProposalSink;
  committer: ChatMessageCommitterLike;
  source_id: string;
  batch_id: string;
  now: string;
  now_ms: number;
  auto_ok: readonly string[];
  review: readonly string[];
}

interface JudgedConversation {
  conversation_id: string;
  conversation_key: string;
  title: string;
  kind: ConversationKind;
  platform: ChatPlatform;
  verdict: TierVerdict;
  /** `chat_conversations` 是否已存在该会话（Tier 硬门槛 3 的输入）。 */
  existed: boolean;
  /**
   * 批 2 / 1B′：装配层算一次的信任判定，供 `judge` 与 `enforceHardGates` **共用**。
   * 同值两处喂入，避免 staging 的 `reason_codes` 与 proposal 的 verdict 审计分裂。
   */
  trusted_ingest: boolean;
  /** 去重后的 `content_type` 取值（Tier 硬门槛 2 的输入）。 */
  content_types: readonly string[];
  /** staging 已存在的消息数（L2 幂等口径的 `skipped`）。 */
  pre_existing: number;
  /** 本批实际新增到 staging 的行数（重跑时 `INSERT OR IGNORE` 会忽略已存在行）。 */
  inserted: number;
}

function resolvePipeline(options: IngestExportOptions, now: string): PipelineDeps | null {
  const sink = options.proposalSink;
  const committer = options.chatCommitter;
  if (sink === undefined && committer === undefined) return null;
  if (sink === undefined || committer === undefined) {
    throw new ChatIngestError(
      "INVALID_TARGET_REF",
      "pipeline 模式必须同时注入 proposalSink 与 chatCommitter（DESIGN-11 §6.3）",
    );
  }
  const sourceId = options.source_id ?? "";
  if (sourceId === "") {
    throw new ChatIngestError(
      "INVALID_TARGET_REF",
      "pipeline 模式必须提供 source_id（proposal.source_id 必填，DESIGN-11 §6.3）",
    );
  }
  const nowMs = Date.parse(now);
  return {
    store: options.store,
    sink,
    committer,
    source_id: sourceId,
    batch_id: options.batch_id ?? "",
    now,
    now_ms: Number.isFinite(nowMs) ? nowMs : Date.now(),
    auto_ok: options.tierConfig?.auto_ok ?? [],
    review: options.tierConfig?.review ?? [],
  };
}

/** 阶段 [5]~[6]：落 staging → Tier 判定 → 回写 staging 的 `tier` / `reason_codes`。 */
function stageAndJudge(
  deps: PipelineDeps,
  judge: TierJudge,
  conversation: NormalizedConversation,
  diagnostics: TierDiagnostics,
): JudgedConversation {
  const { store } = deps;
  const conversation_id = conversationIdOf(conversation);
  const rows = toStagingRows(conversation);
  let inserted = 0;
  if (rows.length > 0) {
    inserted = store.staging.stageMessages({
      batch_id: deps.batch_id,
      conversation_id,
      rows,
      now: deps.now,
    }).inserted;
  }

  const existing = store.conversations.get(conversation_id);
  // 批 2 / 1B′：唯一的信任判定来源。`会话已有历史 ∨ auto_ok 预授权`。
  // 本机 `data/chat-ingest/` 不存在（auto_ok.txt 缺失），只认白名单会让 1B′ 永远不生效；
  // 接上 `exists` 后用户路径是「首次导入 → 接受一次 → 之后全自动」，无需编辑配置文件。
  const trusted_ingest = existing !== null || deps.auto_ok.includes(conversation_id);
  const speakers = new Set(
    conversation.messages.filter((message) => message.role !== "system").map((m) => m.sender_id),
  );
  const knownSenders: string[] = [];
  for (const senderId of speakers) {
    if (senderId === "me") continue;
    if (store.aliases.resolvePersonId(conversation.platform, senderId) !== null) {
      knownSenders.push(senderId);
    }
  }
  // 群成员表缺失 → member_count = -1（未知），触发 GROUP_MEMBER_UNKNOWN（§4.5）。
  const member_count =
    existing !== null
      ? existing.member_count
      : conversation.kind === "group"
        ? -1
        : speakers.size;

  let pre_existing = 0;
  const verdict = judge.judgeNow({
    messages: conversation.messages,
    conversation: {
      conversation_id,
      kind: conversation.kind,
      exists: existing !== null,
      member_count,
      trusted_ingest,
    },
    cursor: new CursorStore(store.staging).read(conversation.platform, conversation_id),
    known_sender_ids: knownSenders,
    encoding: {
      replacement_ratio: diagnostics.encoding_loss_ratio,
      has_nul: diagnostics.has_nul,
    },
    batch: {
      parsed_failures: diagnostics.parsed_failures,
      total_lines: diagnostics.total_lines,
    },
    manual_flags: deps.review,
    lookup_existing: (messageId: string) => {
      const row = store.messages.get(messageId);
      if (row === null) return null;
      pre_existing += 1;
      return { content: row.content, ts_ms: row.ts_ms };
    },
  });

  if (rows.length > 0) {
    store.staging.markTier({
      batch_id: deps.batch_id,
      conversation_id,
      items: conversation.messages.map((message) => ({
        message_id: message.message_id,
        tier: verdict.tier,
        reason_codes: verdict.reason_codes,
      })),
      now: deps.now,
    });
  }

  const contentTypes = [...new Set(conversation.messages.map((m) => m.content_type))];
  return {
    conversation_id,
    conversation_key: conversation.conversation_key,
    title: conversation.title,
    kind: conversation.kind,
    platform: conversation.platform,
    verdict,
    existed: existing !== null,
    trusted_ingest,
    content_types: contentTypes,
    pre_existing,
    inserted,
  };
}

/** 阶段 [7]~[8a]/[8b]：游标过滤 → proposal 构建 → Tier A 自动 accept / Tier B 入队。 */
function proposeForConversation(
  deps: PipelineDeps,
  judged: JudgedConversation,
  stats: IngestExportResult["proposals"],
): { tier: TierLabel; cursor_filtered: number } {
  const { store, sink } = deps;
  const rows = store.staging.listStaged({
    batch_id: deps.batch_id,
    conversation_id: judged.conversation_id,
  });
  const staged = rows.filter((row) => row.status === "staged");
  const alreadyProposed = rows
    .filter((row) => row.proposal_id !== null)
    .map((row) => row.message_id);

  const filter = new IncrementalFilter(
    new CursorStore(store.staging).read(judged.platform, judged.conversation_id),
  );
  const fresh = filter.filter(staged);
  const cursor_filtered = staged.length - fresh.length;

  const builder = new ProposalBuilder({
    source_id: deps.source_id,
    batch_id: deps.batch_id,
    now: deps.now,
    conversation: {
      conversation_id: judged.conversation_id,
      title: judged.title,
      kind: judged.kind,
    },
    tier: judged.verdict.tier,
    reason_codes: judged.verdict.reason_codes,
    // 摘要末行的 M：本批该会话的待落档行数（`commitStaged` 是会话级粒度，见 committer.ts）。
    conversation_pending_commit_count: staged.length,
  });
  const plan = builder.plan({
    messages: fresh.map((row) => ({
      message_id: row.message_id,
      ts_ms: row.ts_ms,
      sender_name: row.sender_name,
      content: row.content,
      content_type: row.content_type,
      role: row.role,
    })),
    already_proposed_message_ids: alreadyProposed,
    // §6.5（2A）：按会话作用域取既有 pending，去重交给 message_id 差集。
    existing_pending: sink.listPending({ conversation_id: judged.conversation_id }),
  });

  for (const proposal of plan.proposals) {
    sink.create(proposal);
    stats.created += 1;
    if (judged.verdict.tier === "auto") {
      // §6.3：Tier A 也必须经 proposal → accept → committer（决策者是规则，管线同一条）。
      sink.accept(proposal.id);
      stats.accepted += 1;
    } else {
      stats.queued += 1;
    }
  }
  stats.reused += plan.reused.length;
  stats.skipped_messages += plan.skipped;
  return { tier: judged.verdict.tier, cursor_filtered };
}

async function runPipelineMode(
  options: IngestExportOptions,
  feed: IngestFeed,
  batchId: string,
  now: string,
  pipeline: PipelineDeps,
): Promise<IngestExportResult> {
  const deps: PipelineDeps = { ...pipeline, batch_id: batchId };
  const judge = new TierJudge({ now_ms: deps.now_ms });
  const jobs = await feed.jobs();
  const issues: IngestIssueSummary[] = [];
  const judged: JudgedConversation[] = [];
  let message_count = 0;
  let skipped = 0;
  let conversation_count = 0;

  // 阶段 [2]~[6]：读 → 归一化 → staging → Tier 判定
  for (const job of jobs) {
    let loaded: LoadedConversation;
    try {
      loaded = await job.load();
    } catch (cause) {
      issues.push({
        conversation_key: job.key,
        line_no: 0,
        code: "READER_FAILED",
        excerpt: describeError(cause).slice(0, 200),
      });
      continue;
    }
    const conversation = loaded.conversation;
    if (!matchesOnly(conversation, options.only ?? [])) continue;
    const one = stageAndJudge(deps, judge, conversation, loaded.diagnostics);
    judged.push(one);
    conversation_count += 1;
    message_count += one.inserted;
    skipped += one.pre_existing;
    for (const issue of conversation.issues) {
      issues.push({ conversation_key: conversation.conversation_key, ...issue });
    }
  }

  // 门槛 4 是**批次级**：本批次任一会话触发 BATCH_QUALITY，全部不得自动落档。
  const batch_quality_failed = judged.some((item) =>
    item.verdict.reason_codes.includes("BATCH_QUALITY"),
  );

  const tierStats = emptyTierStats();
  const proposalStats = emptyProposalStats();
  let cursor_filtered = 0;
  for (const item of judged) {
    const verdict = TierJudge.enforceHardGates({
      verdict: item.verdict,
      content_types: item.content_types,
      gates: {
        conversation_id: item.conversation_id,
        conversation_exists: item.existed,
        trusted_ingest: item.trusted_ingest,
        auto_ok_conversation_ids: deps.auto_ok,
        batch_quality_failed,
      },
    });
    const final: JudgedConversation = { ...item, verdict };
    const applied = proposeForConversation(deps, final, proposalStats);
    tierStats[applied.tier] += 1;
    cursor_filtered += applied.cursor_filtered;
  }

  // 适配器告警：每轮**只取一次**（实现约定「取走即清空」，避免跨轮累积）。
  const adapterWarnings = deps.sink.drainWarnings?.() ?? NO_WARNINGS;

  const counts = deps.store.staging.countByStatus(batchId);
  deps.store.staging.finishBatch({
    batch_id: batchId,
    status: "succeeded",
    conversation_count,
    message_count,
    skipped_count: skipped,
    now,
  });

  return {
    batch_id: batchId,
    reader_id: feed.id,
    conversation_count,
    message_count,
    committed: counts.committed,
    skipped,
    issues,
    mode: "pipeline",
    tier: tierStats,
    proposals: proposalStats,
    cursor_filtered,
    warnings: adapterWarnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  公开入口
// ──────────────────────────────────────────────────────────────────────────

/** 摄入一个导出目录；返回批次统计与保真度 issue（不抛单会话错误，DESIGN-11 §8.1）。 */
export async function ingestExport(options: IngestExportOptions): Promise<IngestExportResult> {
  const { store, dir } = options;
  const now = options.now ?? new Date().toISOString();
  const batchId = options.batch_id ?? randomUUID();
  const feed = createFeed({ ...options, dir });
  const probe = await feed.probe();
  if (!probe.ok) {
    throw new ChatIngestError(
      "EXPORT_FORMAT_UNKNOWN",
      `导出目录格式无法识别：${dir}（${probe.warnings.join("；")}）`,
    );
  }
  store.staging.beginBatch({
    batch_id: batchId,
    platform: feed.platform,
    extractor: feed.id,
    tool_version: feed.tool_version,
    now,
  });
  // 批 2b 回滚四步 ②：游标快照必须在**本批次推进游标之前**采集，否则 revertBatch 的
  // restoreCursors 只会把「批次跑完后的游标」写回去，等于回滚空转（restored 恒 0）。
  // 主干此前从未调用 snapshotCursors（生产零调用），ingest_batches.cursor_snapshot_json 恒 NULL。
  // 放在 beginBatch 之后、两种模式之前：legacy 与 pipeline 都被覆盖。
  store.staging.snapshotCursors({ batch_id: batchId, now });
  const pipeline = resolvePipeline({ ...options, batch_id: batchId }, now);
  if (pipeline === null) {
    return runLegacyMode(options, feed, batchId, now);
  }
  return runPipelineMode(options, feed, batchId, now, pipeline);
}

/** 便捷构造说明：生产装配用 `createChatMessageCommitter({ store })` 注入 `chatCommitter`。 */

export { ChatIngestError, isChatIngestError, type ChatIngestErrorCode, describeError } from "./errors";
export {
  compileDescriptor,
  loadDescriptor,
  TARRY9110_TXT_DESCRIPTOR,
  type ChatFormatDescriptor,
  type CompiledDescriptor,
} from "./descriptor";
export { normalizeConversation, type NormalizedConversation } from "./normalize";
export type { IngestIssue, IssueCode, NormalizedMessage } from "./normalize";
export { decodeText, Tarry9110TxtReader } from "./reader";
export type {
  DecodedText,
  IChatExportReader,
  ProbeResult,
  RawConversation,
  RawConversationRef,
} from "./reader";
export {
  advanceCursorState,
  CursorStore,
  filterNew,
  IncrementalFilter,
  keep,
  maxCursorOf,
  type CursorMessageKey,
  type CursorRepoLike,
  type CursorState,
} from "./cursor";
export {
  AUTO_CONTENT_TYPES,
  judgeTier,
  TIER_REASON_CODES,
  TIER_RULE_VERSION,
  TIER_RULES,
  TierJudge,
  type TierConversationLike,
  type TierCursorLike,
  type TierDiagnostics,
  type TierGateInput,
  type TierJudgeInput,
  type TierLabel,
  type TierMessageLike,
  type TierReasonCode,
  type TierRule,
  type TierVerdict,
} from "./tier";
export {
  buildProposedBody,
  buildReasoning,
  PROPOSAL_PROVIDER_ID,
  PROPOSAL_SHARD_SIZE,
  PROPOSED_BODY_LIMIT,
  ProposalBuilder,
  selectUnproposedMessages,
  type ChatIngestProposalDraft,
  type ChatMessageProposalTarget,
  type PendingProposalRef,
  type ProposalBuilderInput,
  type ProposalMessageLike,
  type ProposalPlan,
} from "./proposal";
export {
  createChatMessageCommitter,
  createChatMessageRejecter,
  type ChatCommitStoreLike,
  type ChatRejectStoreLike,
  type ChatMessageCommitInputLike,
  type ChatMessageCommitTargetLike,
  type ChatMessageCommitterLike,
  type ChatMessageRejectInputLike,
  type ChatMessageRejecterLike,
  type ChatStagingRowLike,
} from "./committer";
export {
  GENERIC_JSON_DESCRIPTOR,
  JsonExportReader,
  jsonContentTypeMarkers,
  loadJsonDescriptor,
  msgDateOf,
  type JsonChatPlatform,
  type JsonContentType,
  type JsonConversationRead,
  type JsonFormatDescriptor,
} from "./readers/json";
