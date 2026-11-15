/**
 * W-9：聊天记录导入 + 挖掘触发（写通道路由）。
 *
 * ## 为什么需要它
 * 图谱能不能有内容，只取决于两件事：**库里有没有含他人参与的聊天数据**、**有没有人跑过挖掘**。
 * 现状两者皆无：`runMiningPipeline` 全仓零调用方（旧库 `GET /graph` 直接回 `snapshot:null`
 * 就是铁证），而 W-1 的资料上传只做 txt/md/json → distill 提案，不是 chat 导入。
 *
 * ## 复用而不是重写
 * 导入逻辑一行都不重写：直接调 `@knowself/chat-ingest` 的 `ingestExport`
 * （与 CLI `apps/server/src/cli/ingest-chat.ts` 同一函数、同一参数），
 * 提案侧复用 `proposal-sink.ts` 的 `makeIngestionProposalSink`，
 * 落档侧用 `createChatMessageCommitter(store)`。本文件只负责：参数校验 → 装配 → 编排 → 汇报。
 *
 * ## 幂等
 * 重复导入同一份靠 chat-ingest 既有游标（`ingest_cursors`）与
 * `messages.insertOrIgnore` 双保险，本文件**不额外**做去重。
 *
 * ## 挖掘失败不回滚
 * 导入成功后立刻跑 `runMiningPipeline({write:true})`；挖掘抛错只记 `mining_warning`，
 * 已导入的消息**保留**（它们是真实数据，重算随时可再来）。
 *
 * ## 边界
 * - 只读传入目录，不扫描任何默认路径（不写死本机微信目录）；
 * - 不做「猜编码/猜格式」之外的猜测：reader 由调用方指定（默认 txt）。
 */
import { existsSync, statSync } from "node:fs";
import { createChatMessageCommitter, ingestExport } from "@knowself/chat-ingest";
import { runAutoArchive } from "../archive-policy.js";
import { runMiningPipeline } from "@knowself/mining";
import type { PersonStore } from "@knowself/person-store";
import type { KnowselfServices } from "../services.js";
import { makeIngestionProposalSink } from "../proposal-sink.js";
import { BadRequestError, degradedBody, type DispatchResult } from "./http.js";

/** 可注入的协作者（测试用；缺省走真实实现）。 */
export interface ChatImportDeps {
  /** 导入器（默认 `@knowself/chat-ingest` 的 `ingestExport`）。 */
  ingest?: typeof ingestExport;
  /** 挖掘器（默认 `@knowself/mining` 的 `runMiningPipeline`）。 */
  mine?: typeof runMiningPipeline;
}

/** `POST /write/chat-import` 的请求体。 */
interface ChatImportBody {
  /** 导出产物目录（只读）。与 `source_id` 二选一。 */
  source_path?: string;
  /** 已存在的资料 id（用于把本次导入挂到那条资料下）。 */
  source_id?: string;
  /** reader：默认 txt（P0 实测产物）。 */
  reader?: "txt" | "json";
  /** 关键字过滤（会话标题/键）。 */
  only?: string[];
  /**
   * 导入后是否**自动采纳**本次生成的 proposals（默认 `false`）。
   *
   * 为什么默认 false：`ingestExport` 只写 staging + 生成 proposal，**不落 chat_messages**；
   * 落库要等 proposal 被 accept。默认自动接受等于替用户做了复核决定。
   * 打开开关必须同时给 `auto_commit_reason`（进审计日志）。
   */
  auto_commit?: boolean;
  /** 打开 `auto_commit` 时必填的自由文本理由（写进结构化审计日志）。 */
  auto_commit_reason?: string;
  /**
   * 导出产物的来源平台（W-34-T02）。
   *
   * 类型故意用 `unknown` 而不是联合类型：非法值（数字 / 对象 / 未枚举的字符串）也要
   * 回带 `code: "INVALID_PLATFORM"` 的 400，而值域校验放在 `importChat` 的平台闸里做
   * （`BadRequestError` 只带 message、不带 code，满足不了契约）。
   */
  platform?: unknown;
}

/** 解析请求体；非法即 400。 */
function parseBody(raw: unknown): ChatImportBody {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  const body = raw as Record<string, unknown>;
  const out: ChatImportBody = {};

  const sourcePath = body.source_path;
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
      throw new BadRequestError("字段 source_path 必须是非空字符串");
    }
    out.source_path = sourcePath.trim();
  }
  const sourceId = body.source_id;
  if (sourceId !== undefined) {
    if (typeof sourceId !== "string" || sourceId.trim() === "") {
      throw new BadRequestError("字段 source_id 必须是非空字符串");
    }
    out.source_id = sourceId.trim();
  }
  if (out.source_path === undefined && out.source_id === undefined) {
    throw new BadRequestError("必须提供 source_path 或 source_id 之一");
  }
  const reader = body.reader;
  if (reader !== undefined) {
    if (reader !== "txt" && reader !== "json") {
      throw new BadRequestError("字段 reader 只能是 txt / json");
    }
    out.reader = reader;
  }
  const only = body.only;
  if (only !== undefined) {
    if (!Array.isArray(only) || only.some((v) => typeof v !== "string")) {
      throw new BadRequestError("字段 only 必须是字符串数组");
    }
    out.only = only as string[];
  }

  const autoCommit = body.auto_commit;
  if (autoCommit !== undefined) {
    if (typeof autoCommit !== "boolean") throw new BadRequestError("字段 auto_commit 必须是布尔");
    out.auto_commit = autoCommit;
  }
  const reason = body.auto_commit_reason;
  if (reason !== undefined) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new BadRequestError("字段 auto_commit_reason 必须是非空字符串");
    }
    out.auto_commit_reason = reason.trim().slice(0, 200);
  }
  // 打开自动采纳必须能说清「谁让它自动的」——否则事后无法追责/复现
  if (out.auto_commit === true && out.auto_commit_reason === undefined) {
    throw new BadRequestError("auto_commit=true 时必须提供 auto_commit_reason");
  }

  // W-34-T02：平台**只做搬运，不做校验**。值域校验在 `importChat` 的平台闸里做，
  // 因为那里要回 `{ error, code }` 两个字段，而 `BadRequestError` 只能带 message。
  const platform = body.platform;
  if (platform !== undefined) out.platform = platform;
  return out;
}

/**
 * `POST /write/chat-import`：导入聊天记录 → 立即挖掘 → 返回结果。
 *
 * @param services 装配后的服务
 * @param raw 请求体
 * @param deps 可注入协作者（测试用）
 * @returns `{ conversations, messages:{inserted,ignored}, persons_created, snapshot_id, nodes, edges }`
 */
export async function importChat(
  services: KnowselfServices,
  raw: unknown,
  deps: ChatImportDeps = {},
): Promise<DispatchResult> {
  const body = parseBody(raw);

  // ── W-34-T02：平台闸（**必须有**）──
  //
  // 为什么服务端要自己拦，而不是只靠 UI 禁用按钮：绕过 UI 直接调接口时，
  // QQ/抖音 的导出目录会被微信解析器硬读 → 产出无法回溯的脏数据（人/会话/消息全错位）。
  // 用 400 而不是 501：客户端 `if (!res.ok) throw new Error(\`…HTTP ${status}\`)` 会把 501
  // 渲染成「导入失败：HTTP 501」这种黑话，400 + 中文 error 才是用户能看懂的东西。
  const platform = body.platform ?? "wechat";
  if (platform !== "wechat" && platform !== "qq" && platform !== "douyin") {
    return { status: 400, body: { error: "不支持的平台", code: "INVALID_PLATFORM" } };
  }
  if (platform !== "wechat") {
    return {
      status: 400,
      body: {
        error: `平台 ${platform === "qq" ? "QQ" : "抖音"} 的解析器尚未实现`,
        code: "PLATFORM_NOT_SUPPORTED",
      },
    };
  }

  // 降级（503）：人物层 / 摄入层任一缺失都无法导入
  const personStore = services.personStore;
  const ingestion = services.ingestion;
  if (personStore === undefined || ingestion === undefined) {
    const layer = personStore === undefined ? "person" : "ingestion";
    // 0.3.6：把"配置缺失"从"摄入层未就绪"里分出来。
    // 全新安装时摄入层失败的真实原因是根本没配 provider（pickDistillProviderId 抛错），
    // 而旧文案会让用户以为功能坏了，不知道该去填配置。
    if (layer === "ingestion" && isProviderConfigMissing(services)) {
      return degradedBody(
        "还没有可用的模型 provider（蒸馏需要它）。打开设置填入 provider 与 api_key 后重试。",
        layer,
      );
    }
    return degradedBody(`聊天导入需要${layer === "person" ? "人物层" : "摄入层"}，当前未就绪`, layer);
  }

  // source_path 必须是存在的目录
  let dir = body.source_path;
  let sourceId = body.source_id;
  if (dir !== undefined) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new BadRequestError(`source_path 不是可读目录：${dir}`);
    }
  }

  // 没有 source_id 时建一条 paste 资料作为载体（与 CLI 同策略，便于 UI 追溯）
  if (sourceId === undefined) {
    const created = await ingestion.createSource({
      kind: "paste",
      text: `聊天记录导入：${dir ?? "(已有资料)"}`,
      original_name: `chat-import-${Date.now()}`,
      user_note: "",
      user_tags: [],
    });
    sourceId = created.id;
  } else {
    // sources.get 对未知 id 抛错；只做存在性判定
    try {
      services.profileStore.sources.get(sourceId);
    } catch {
      return { status: 404, body: { error: "not_found" } };
    }
  }

  if (dir === undefined) {
    // 只给了 source_id 却没有目录：没有可导入的产物，直接 400（不猜「资料里存放路径」）
    throw new BadRequestError("仅提供 source_id 时还需提供 source_path（导出产物目录）");
  }

  const ingest = deps.ingest ?? ingestExport;
  const mine = deps.mine ?? runMiningPipeline;
  const personsBefore = personStore.listPersons().length;
  const messagesBefore = personStore.messages.count();

  // 记下本次创建的 proposal id：`auto_commit` 只采纳**这一次**导入产生的，不碰历史 pending
  const createdProposalIds: string[] = [];
  const baseSink = makeIngestionProposalSink(ingestion, services.profileStore);
  const recordingSink: typeof baseSink = {
    ...baseSink,
    create: (draft) => {
      baseSink.create(draft);
      const raw = draft as unknown as { proposal_id?: unknown; id?: unknown };
      const id = typeof raw.proposal_id === "string" ? raw.proposal_id : raw.id;
      if (typeof id === "string") createdProposalIds.push(id);
    },
  };

  const result = await ingest({
    store: personStore,
    dir,
    source_id: sourceId,
    proposalSink: recordingSink,
    chatCommitter: createChatMessageCommitter(personStore),
    ...(body.reader === undefined ? {} : { reader: body.reader }),
    ...(body.only === undefined || body.only.length === 0 ? {} : { only: body.only }),
  });

  // 批次 2（B2-3/B2-4）：自动归档判定 + 按策略采纳 + material 自动蒸馏。
  // 判定失败/蒸馏失败都只记 warning，**不阻断导入**（导入成功与否只看上面那段）。
  const archive = await runAutoArchive({
    services,
    store: personStore,
    batchId: result.batch_id,
    sourceId,
  });

  // 自动采纳（默认关）。单条失败不打断其余，最终以计数为准。
  let autoCommitted = 0;
  if (body.auto_commit === true) {
    for (const proposalId of createdProposalIds) {
      try {
        recordingSink.accept(proposalId);
        autoCommitted += 1;
      } catch {
        /* 单条失败：不中断，计数如实反映 */
      }
    }
    // 审计留痕：谁把开关打开的、采纳了多少条，必须事后可查
    try {
      console.error(
        `[knowself][chat-import] ${JSON.stringify({
          event: "chat_import_auto_commit",
          source_id: sourceId,
          batch_id: result.batch_id,
          created: createdProposalIds.length,
          committed: autoCommitted,
          reason: body.auto_commit_reason ?? null,
          at: new Date().toISOString(),
        })}`,
      );
    } catch {
      /* stderr 不可用不影响主流程 */
    }
  }

  // P1：批量重算人物派生统计（`msg_count` / `conv_count` / 首末时间）。
  //
  // 为什么必须在导入后跑：`commitStaged` 只写消息与别名，**不动** `persons.msg_count`；
  // 于是全量导入后 1,072 个人的 `msg_count` 全是 0，UI 上每一行都显示"0 条消息"，
  // 整个界面看起来像假的。单人的 `recomputeStats` 是每人一次视图扫描（1,072 次很慢），
  // 这里用批量版（一条 GROUP BY + 事务批量 UPDATE，实测 1,072 人 555ms）。
  // 失败只告警，不影响已导入的数据。
  let statsRefresh: { updated: number; elapsed_ms: number } | null = null;
  try {
    const startedAt = Date.now();
    const refreshed = personStore.persons.recomputeAllStats(new Date().toISOString());
    statsRefresh = { updated: refreshed.updated, elapsed_ms: Date.now() - startedAt };
  } catch (err) {
    archive.warnings.push(
      `统计重算失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 挖掘：失败只告警，不回滚已导入消息
  let snapshotId: string | null = null;
  let nodes: number | null = null;
  let edges: number | null = null;
  let miningWarning: string | null = null;
  try {
    const mined = await mine({ store: personStore, write: true });
    snapshotId = mined.snapshotId;
    nodes = mined.graph?.snapshot.nodes.length ?? null;
    edges = mined.graph?.snapshot.edges.length ?? null;
  } catch (err) {
    miningWarning = err instanceof Error ? err.message : String(err);
  }

  const personsAfter = personStore.listPersons().length;
  // 「其中 N 条无法识别发送者」：只统计**这次导入**落库的消息（按 batch_id 圈定）。
  // 排除 role='system' —— 系统消息不参与关系分析，算进去会让「已修好」的库永远非 0。
  const unattributed = personStore.messages.countUnattributed({
    batch_id: result.batch_id,
  });

  return {
    status: 200,
    body: {
      source_id: sourceId,
      batch_id: result.batch_id,
      conversations: result.conversation_count,
      // parsed = 解析条数（**必须有**：否则「解析 40 条但 committed=0」看起来像一条都没读到）
      messages: {
        parsed: result.message_count,
        committed: result.committed,
        ignored: result.skipped,
        // 已落库但归属不到人的条数（sender_person_id IS NULL，排除 system）
        unattributed,
      },
      persons_created: Math.max(0, personsAfter - personsBefore),
      // 默认 0（auto_commit=false）。UI 据此区分「等待确认」与「已自动采纳」
      // auto_committed = 采纳的 **proposal** 数（chat-ingest 按会话产 proposal，1 会话 = 1 条）
      auto_committed: autoCommitted,
      // messages_committed = 实际落库的**消息**数（采纳 1 条 proposal 可能带入 80 条消息）
      messages_committed: Math.max(0, personStore.messages.count() - messagesBefore),
      // 批次 2：自动归档判定与采纳情况（判定一定记录，采纳看开关）
      auto_archive: archive,
      // P1：人物派生统计重算结果（`msg_count` 等；失败时为 null 并记在 auto_archive.warnings）
      stats_refresh: statsRefresh,
      snapshot_id: snapshotId,
      nodes,
      edges,
      ...(miningWarning === null ? {} : { mining_warning: miningWarning }),
    },
  };
}

/**
 * **幂等 backfill**：确保每个平台的 self alias 存在（W-9）。
 *
 * 为什么需要：C 的 alias 是**导入时**建的。对「已经导入过、之后只跑 mining-run」的库，
 * 没人再 import ⇒ alias 永远不存在 ⇒ 历史里 `sender_id='me'` 的行永远解析不出 person，
 * 「我」的 degree 永远 0。视图是查询期 JOIN，所以补上 alias 后**历史行立刻生效**，不必重写消息。
 *
 * 用 `conversations.list()` 的平台集合而不是扫 `chat_messages`：有消息必有会话，而会话表小得多；
 * `upsertExtractor` 本身幂等（samePerson → created:false），重复跑不会增行。
 *
 * **不静默 no-op**：若平台集合为空却在 `chat_messages` 里看到 `sender_id='me'` 的行，
 * 说明会话表与消息表已不一致——这不是「没数据」，必须喊出来（warning + 计数），
 * 否则又是一处「看起来什么都没做」的坑。
 *
 * @param store 人物库
 * @returns 补齐的平台列表、self 消息条数、不一致告警（正常为 `null`）
 */
export interface SelfAliasBackfillResult {
  /** 已补算的平台（去重后） */
  platforms: string[];
  /** 库里 `sender_id='me'` 的原始消息条数（0 表示根本没有 self 消息） */
  selfMessageCount: number;
  /** 会话表与消息表不一致时非 null */
  warning: string | null;
}

/** chat-ingest 写入 self 消息时用的哨兵发送者 ID（与 `lines.ts` 一致）。 */
const SELF_SENDER_ID = "me";

function backfillSelfAliases(store: PersonStore): SelfAliasBackfillResult {
  const platforms = [...new Set(store.conversations.list().map((c) => c.platform))];
  const selfMessageCount = store.messages.countBySenderId(SELF_SENDER_ID);

  let warning: string | null = null;
  if (platforms.length === 0 && selfMessageCount > 0) {
    warning =
      `会话表为空，但 chat_messages 里有 ${selfMessageCount} 条 sender_id='me' 的消息：` +
      `会话表与消息表不一致，self alias 无法补算（「我」将保持孤立）`;
    try {
      console.error(
        `[knowself][mining-run] ${JSON.stringify({
          event: "self_alias_backfill_skipped",
          self_message_count: selfMessageCount,
          at: new Date().toISOString(),
        })}`,
      );
    } catch {
      /* stderr 不可用不影响主流程 */
    }
    return { platforms, selfMessageCount, warning };
  }

  const now = new Date().toISOString();
  for (const platform of platforms) {
    store.aliases.upsertExtractor({
      person_id: SELF_SENDER_ID,
      platform,
      alias: SELF_SENDER_ID,
      normalized: SELF_SENDER_ID,
      alias_kind: "platform_uid",
      confidence: 1,
      now,
    });
  }
  return { platforms, selfMessageCount, warning };
}

/**
 * `POST /write/mining-run`：只跑挖掘、不导入（给已有数据补算）。
 *
 * @param services 装配后的服务
 * @param deps 可注入挖掘器（测试用）
 * @returns `{ snapshot_id, nodes, edges, persons, scopes, warnings, self_alias_platforms,
 *   self_message_count, stats_refresh }`
 */
export async function runMining(
  services: KnowselfServices,
  deps: ChatImportDeps = {},
): Promise<DispatchResult> {
  const personStore = services.personStore;
  if (personStore === undefined) {
    return degradedBody("挖掘需要人物层，当前未就绪", "person");
  }
  // 补算路径也要保证 self alias 存在，否则「我」永远不进图谱（C 的 alias 只在导入时建）
  const backfill = backfillSelfAliases(personStore);
  const mine = deps.mine ?? runMiningPipeline;
  const result = await mine({ store: personStore, write: true });

  // 重算人物派生统计（`msg_count` / `conv_count` / 首末时间）。
  //
  // 为什么这里也要跑：`mine` 只产出图快照，**不动** `persons.msg_count`；用户改完数据点
  // 「重新挖掘」后若不重算，人物列表上的消息数仍是旧值，与图谱自相矛盾。语义与
  // `POST /write/chat-import` 完全同构（字段名、单位一致），失败只告警、不阻断挖掘结果。
  let statsRefresh: { updated: number; elapsed_ms: number } | null = null;
  let statsWarning: string | null = null;
  try {
    const startedAt = Date.now();
    const refreshed = personStore.persons.recomputeAllStats(new Date().toISOString());
    statsRefresh = { updated: refreshed.updated, elapsed_ms: Date.now() - startedAt };
  } catch (err) {
    statsWarning = `统计重算失败：${err instanceof Error ? err.message : String(err)}`;
  }

  const warnings = [...result.warnings];
  if (backfill.warning !== null) warnings.push(backfill.warning);
  if (statsWarning !== null) warnings.push(statsWarning);

  return {
    status: 200,
    body: {
      snapshot_id: result.snapshotId,
      nodes: result.graph?.snapshot.nodes.length ?? null,
      edges: result.graph?.snapshot.edges.length ?? null,
      persons: result.persons,
      scopes: result.scopes,
      warnings,
      // 证据字段：补了哪些平台、库里到底有多少 self 消息
      self_alias_platforms: backfill.platforms,
      self_message_count: backfill.selfMessageCount,
      // 人物派生统计重算结果（失败时为 null 并记在 warnings）
      stats_refresh: statsRefresh,
    },
  };
}

/**
 * 判断摄入层降级是否由「没有可用的模型 provider」引起。
 *
 * 依据：`services.ts` 在 layer3 失败时把原始异常原文写进 `degraded.reasons`，
 * 而 `pickDistillProviderId()` 抛出的文案里含 "provider"。这里只做**判定**，
 * 不改写原始 reason —— 原始信息仍保留在 degraded 里供排查。
 */
function isProviderConfigMissing(services: KnowselfServices): boolean {
  const reasons = services.degraded?.reasons ?? [];
  return reasons.some((reason) => /provider/i.test(reason));
}
