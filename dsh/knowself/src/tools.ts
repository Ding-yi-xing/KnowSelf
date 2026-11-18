/**
 * tools —— 17 个 knowSelf 领域工具（dsh ToolDefinition 形态）。
 *
 * 每个工具 = dsh `ToolDefinition`：入参 `parameters` 由领域库 Zod schema 经
 * schema-bridge 生成（单一真相源）；`execute` 只做「Zod.parse → 调领域函数 →
 * 投影返回」，不重写任何业务守卫。写工具复用领域库 provenance / Tier 判定。
 *
 * W2/T02：`knowself_ingest` 的 `parameters` 改用手写常量（见 tools/ingest-schema.ts）；
 * W2/T03：`get_journal` 精确 catch、`append_journal` 移除 provenance 入参。
 * W3/T05：`ToolSpec.requires` 按真实依赖打标签，`makeTools` 按 `services.degraded`
 * 与实际服务实体过滤，只注册依赖已满足的工具；可选服务用 `requireService` 收窄，
 * 保证「被保留的工具运行时必能拿到非空服务」且构造阶段不因 undefined 抛错。
 *
 * 真实依赖标签（逐行核对，不照 05 表格字面）：
 *   仅 profileStore（核心，必成功）：get_profile / get_card / get_journal / append_journal
 *   personStore（人物层）          ：list_persons / get_person / person_events / metrics / network / chat_messages
 *   不依赖任何服务实体（纯函数）    ：intent（classifyMessages）
 *   contextRouter（检索层）        ：search（另用核心层 settings 推导 provider_id）
 *   ingestion（摄入层）            ：ingest / list_proposals / decide_proposal
 *   person + ingestion            ：import_chat（source_id 路径用 chatIngest + ingestion）
 */
import { z } from "zod";
import type { ToolDefinition, JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { MiningMessageRow } from "@knowself/person-store";
import { ProfileNotFoundError } from "@knowself/profile-store";
import { getPersonMetrics, getGraphSnapshot, classifyMessages } from "@knowself/mining";
import {
  BuildContextInputSchema,
  type BuildContextInput,
  type WriteRequest,
  type CreateSourceRequest,
  type IngestRequest,
} from "@knowself/contracts";
import { zodToJsonSchema } from "./schema-bridge.js";
import { INGEST_PARAMETERS } from "./tools/ingest-schema.js";
import { pickRetrievalProviderId } from "./services.js";
import { makeIngestionProposalSink } from "./proposal-sink.js";
import type { KnowselfServices } from "./services.js";

/** 出参统一声明为「任意 JSON 值」——dsh 允许省略约束；渲染交给 render。 */
const ANY_OUTPUT: JsonSchemaNode = {};

/** 工具可依赖的能力层（与 services.ts 的 DegradedLayer 子集一致）。 */
type ToolLayer = "person" | "retrieval" | "ingestion";

/** 通用渲染：把 canonical JSON 值投影成模型可读文本块。 */
function jsonText(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/**
 * 取一个可选服务实体；缺失即抛明确错误。
 * 正常情况下过滤逻辑保证被保留的工具依赖一定非空，此分支不可达；
 * 它同时让 TypeScript 把 `T | undefined` 收窄为 `T`（零 `as any`）。
 */
function requireService<T>(value: T | undefined, layer: string): T {
  if (value === undefined) {
    throw new Error(`knowSelf：${layer}不可用，该工具不应被注册（装配降级）`);
  }
  return value;
}

interface ToolSpec {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  /**
   * 可选：手写 parameters 覆盖（仅 `knowself_ingest` 使用）。
   * 判别联合 + 交叉类型展平会丢判别信息，故由调用方手写「给模型看的提示」；
   * 真校验仍由下方 `execute` 首行 `input.parse(args)` 承担。
   */
  parameters?: JsonSchemaNode;
  /**
   * W3/T05：该工具依赖的能力层（数组，因为 import_chat 同时依赖多层）。
   * 未标注 = 只依赖核心层（必成功）或纯函数，永远注册。
   */
  requires?: ToolLayer[];
  run: (args: any) => unknown | Promise<unknown>;
}

function buildTool(services: KnowselfServices, spec: ToolSpec): ToolDefinition {
  const input = spec.input;
  return {
    name: spec.name,
    description: spec.description,
    parameters: (spec.parameters ?? zodToJsonSchema(input)) as Record<string, unknown>,
    output: {
      schema: ANY_OUTPUT,
      render: (_args, value) => jsonText(value),
    },
    execute: async (args: unknown) => {
      const parsed = input.parse(args);
      return await spec.run(parsed);
    },
  };
}

/**
 * 解析当前可用的能力层。
 *
 * 防御性处理：`degraded` 缺失 = W1/W2 的 130 条既有测试桩（以及 `makeTools({})`
 * 这类只构造 ToolDefinition 的调用方）→ 视为**全部层可用**，保持既有行为不回退。
 * 真实装配返回的对象带 degraded，则同时校验 missing 与服务实体是否为空。
 */
function availableLayers(services: KnowselfServices): Set<ToolLayer> {
  if (services.degraded === undefined) {
    return new Set<ToolLayer>(["person", "retrieval", "ingestion"]);
  }
  const missing = services.degraded.missing ?? [];
  const layers = new Set<ToolLayer>();
  if (!missing.includes("person") && services.personStore !== undefined) {
    layers.add("person");
  }
  if (!missing.includes("retrieval") && services.contextRouter !== undefined) {
    layers.add("retrieval");
  }
  if (
    !missing.includes("ingestion") &&
    services.ingestion !== undefined &&
    services.chatIngest !== undefined
  ) {
    layers.add("ingestion");
  }
  return layers;
}

/** 构造 tool spec 并按依赖层过滤后生成 ToolDefinition 列表。 */
export function makeTools(services: KnowselfServices): ToolDefinition[] {
  const { profileStore, personStore, contextRouter, ingestion, chatIngest } = services;

  const specs: ToolSpec[] = [
    // 1. 读 L1 核心（核心层）
    {
      name: "knowself_get_profile",
      description: "读取用户画像 L1 核心（display_name / locale / section_tags / body / updated_at）。",
      input: z.object({}),
      run: () => profileStore.core.get(),
    },

    // 2. 读单张 L2 卡片（核心层）
    {
      name: "knowself_get_card",
      description:
        "按 key 读取一张 L2 画像卡片（含分区正文 sections）。key 由 knowself_list_cards 获取；" +
        "若 key 不存在，错误信息会列出当前可用 key，可直接改用。",
      input: z.object({ key: z.string() }),
      run: (a) => {
        const card = profileStore.cards.get(a.key);
        if (!card) {
          const keys = profileStore.cards.list().map((item) => item.key);
          const shown = keys.slice(0, 20).join(", ");
          const suffix = keys.length > 20 ? ` 等 ${keys.length} 个` : "";
          throw new Error(`卡片不存在: ${a.key}；可用 key: ${shown}${suffix}`);
        }
        return card;
      },
    },

    // 2b. 列出全部 L2 卡片（核心层）—— 让调用方不必猜 key
    {
      name: "knowself_list_cards",
      description:
        "列出全部 L2 画像卡片摘要（key / title / summary / section_tags / updated_at）。" +
        "需要卡片正文时，用返回的 key 调 knowself_get_card。",
      input: z.object({}),
      run: () => profileStore.cards.list(),
    },

    // 3. 混合检索（检索层；settings 属核心层）
    {
      name: "knowself_search",
      description:
        "混合检索：注入 query（provider_id 可省略，缺省自动从已配置 providers 推导），返回召回的上下文消息与元数据（命中来源见 metadata.l3_doc_ids）。",
      requires: ["retrieval"],
      input: BuildContextInputSchema.extend({
        provider_id: z.string().optional(),
      }),
      run: async (a) => {
        const router = requireService(contextRouter, "检索层");
        const providerId = a.provider_id ?? pickRetrievalProviderId(services.settings);
        const result = await router.buildContext({
          ...a,
          provider_id: providerId,
        } as unknown as BuildContextInput);
        return { messages: result.messages, metadata: result.metadata };
      },
    },

    // 4. 读 L3 日记（核心层）
    // T03：只捕获领域库明确的「未找到」错误类，其余异常上抛让模型看到真实失败。
    {
      name: "knowself_get_journal",
      description: "按日期读取 L3 日记条目（YYYY-MM-DD）。",
      input: z.object({ date: z.string() }),
      run: (a) => {
        try {
          return profileStore.journal.get(a.date);
        } catch (err) {
          // 依据：packages/profile-store/src/repository/journal.ts:52-60 —— journal.get()
          // 直接 `SELECT ... WHERE date = ?`，无数据时返回 `{ date, records: [] }`
          // 而**不抛错**；领域库唯一「未找到」类错误是 ProfileNotFoundError
          // （errors.ts:35，code "PROFILE_NOT_FOUND"）。因此这里只兜底该错误类，
          // DB_BUSY / DB_CORRUPT / 约束违规等一律上抛（05 §3 T03(b)）。
          if (err instanceof ProfileNotFoundError) return null;
          throw err;
        }
      },
    },

    // 5. 追加 L3 日记（核心层）
    // T03：移除 provenance 入参 —— 领域守卫只接受 user，暴露该字段只会制造必然失败的调用轮次。
    {
      name: "knowself_append_journal",
      description: "向 L3 日记追加一条记录（provenance 固定为 user，callerKind=ui，复用领域库写入守卫）。",
      input: z.object({
        body: z.string(),
        date: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      run: (a) => {
        const date = a.date ?? new Date().toISOString().slice(0, 10);
        const req = {
          target: "journal",
          date,
          body: a.body,
          tags: a.tags ?? [],
          provenance: "user",
        } as unknown as WriteRequest;
        profileStore.write(req, { callerKind: "ui" });
        return { ok: true, date };
      },
    },

    // 6. 列出多主体人物（人物层）
    {
      name: "knowself_list_persons",
      description: "列出多主体人物档案（可按 subject_kind / status / keyword 过滤）。",
      requires: ["person"],
      input: z.object({
        subject_kind: z.string().optional(),
        status: z.string().optional(),
        keyword: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      }),
      run: (a) => requireService(personStore, "人物层").listPersons(a as never),
    },

    // 7. 读单个人物（人物层；PersonRow 不含 message_id）
    {
      name: "knowself_get_person",
      description: "读取单个多主体人物档案。注意：联系人维度表不含 message_id，来源信息在 events / aliases 中。",
      requires: ["person"],
      input: z.object({ person_id: z.string() }),
      run: (a) => requireService(personStore, "人物层").getPerson(a.person_id) ?? null,
    },

    // 8. 人物事件时间线（人物层）
    {
      name: "knowself_person_events",
      description: "拉取某人物的事件时间线（timeline）。",
      requires: ["person"],
      input: z.object({
        person_id: z.string(),
        from_date: z.string().optional(),
        to_date: z.string().optional(),
        min_importance: z.number().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      }),
      run: (a) =>
        requireService(personStore, "人物层").events.timeline(a.person_id, {
          from_date: a.from_date,
          to_date: a.to_date,
          min_importance: a.min_importance,
          limit: a.limit,
          offset: a.offset,
        } as never),
    },

    // 9. 人格/行为指标（人物层）
    {
      name: "knowself_metrics",
      description: "读取某人物的人格/行为指标聚合（persona metrics）。",
      requires: ["person"],
      input: z.object({
        person_id: z.string(),
        period: z.string().optional(),
        period_key: z.string().optional(),
        keys: z.array(z.string()).optional(),
      }),
      run: (a) =>
        getPersonMetrics(requireService(personStore, "人物层"), a.person_id, a as never),
    },

    // 10. 关系/共现图谱（人物层）
    {
      name: "knowself_network",
      description: "读取关系/共现图谱快照（graph snapshot）。",
      requires: ["person"],
      input: z.object({
        scope_kind: z.string().optional(),
        scope_id: z.string().optional(),
        snapshot_id: z.string().optional(),
        min_strength: z.number().optional(),
        communities: z.array(z.string()).optional(),
        relation_types: z.array(z.string()).optional(),
        edge_kinds: z.array(z.string()).optional(),
        min_interaction: z.number().optional(),
      }),
      run: (a) =>
        getGraphSnapshot(requireService(personStore, "人物层"), a as never) ?? null,
    },

    // 11. 意图分类（纯函数 classifyMessages，不依赖任何服务实体）
    {
      name: "knowself_intent",
      description:
        "对一批消息做意图分类（9 类：consult / after_sales / business / work / social / family / finance / notice / other）。",
      input: z.object({
        messages: z.array(
          z.object({
            message_id: z.string(),
            content: z.string(),
            conversation_id: z.string().optional(),
            role: z.string().optional(),
            sender_person_id: z.string().nullable().optional(),
            ts_ms: z.number().optional(),
          }),
        ),
      }),
      run: (a) => {
        const rows = (a.messages as any[]).map((m) => ({
          message_id: m.message_id,
          conversation_id: m.conversation_id ?? "",
          platform: "unknown",
          role: (m.role ?? "user") as never,
          sender_id: "",
          sender_person_id: m.sender_person_id ?? null,
          ts_ms: m.ts_ms ?? Date.now(),
          msg_date: new Date(m.ts_ms ?? Date.now()).toISOString().slice(0, 10),
          content: m.content,
          content_type: "text",
          reply_to: null,
          meta: {},
        })) as unknown as MiningMessageRow[];
        return classifyMessages(rows);
      },
    },

    // 12. 资料源创建 + 蒸馏（摄入层）
    // T02：parameters 用 INGEST_PARAMETERS（手写，见 tools/ingest-schema.ts）；
    // execute 首行仍是 input.parse(args) 真校验，Zod 是唯一真相源。
    {
      name: "knowself_ingest",
      description: "创建资料源（file / url / paste）并蒸馏出画像提案。file 可通过 file_bytes_base64 内联。",
      requires: ["ingestion"],
      parameters: INGEST_PARAMETERS,
      input: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z.literal("file"),
            name: z.string(),
            mime_type: z.string().optional(),
            file_bytes_base64: z.string().optional(),
          }),
          z.object({ kind: z.literal("url"), url: z.string() }),
          z.object({ kind: z.literal("paste"), name: z.string().optional(), text: z.string() }),
        ])
        .and(
          z.object({
            max_proposals: z.number().int().optional(),
            focus_hints: z.array(z.string()).optional(),
          }),
        ),
      run: async (a) => {
        const ing = requireService(ingestion, "摄入层");
        let fileBytes: Buffer | undefined;
        let req: CreateSourceRequest;
        if (a.kind === "file") {
          if (a.file_bytes_base64) fileBytes = Buffer.from(a.file_bytes_base64, "base64");
          req = { kind: "file", name: a.name, mime_type: a.mime_type } as unknown as CreateSourceRequest;
        } else if (a.kind === "url") {
          req = { kind: "url", url: a.url } as unknown as CreateSourceRequest;
        } else {
          req = { kind: "paste", name: a.name, text: a.text } as unknown as CreateSourceRequest;
        }
        const source = await ing.createSource(req, fileBytes);
        const ingestReq = {
          max_proposals: a.max_proposals,
          focus_hints: a.focus_hints,
        } as unknown as IngestRequest;
        const response = await ing.runDistill(source, ingestReq);
        const proposals = (response as { proposals?: unknown[] })?.proposals ?? [];
        return {
          source_id: (source as { id: string }).id,
          status: (source as { status: string }).status,
          proposal_count: proposals.length,
        };
      },
    },

    // 13. 列出蒸馏提案（摄入层）
    {
      name: "knowself_list_proposals",
      description: "按状态列出蒸馏提案（pending / processing / accepted / edited / rejected / all）。",
      requires: ["ingestion"],
      input: z.object({
        status: z.enum(["pending", "processing", "accepted", "edited", "rejected", "all"]).optional(),
        limit: z.number().int().optional(),
      }),
      run: (a) =>
        requireService(ingestion, "摄入层").listProposalsByStatus(a.status, a.limit),
    },

    // 14. 决议蒸馏提案（摄入层）
    // 注：领域库 DecideProposalRequestSchema 仅含 decision（accept/edit/reject），
    // 不含 proposal_id；故工具入参自定义为 decision + proposal_id + body(edit 时)。
    {
      name: "knowself_decide_proposal",
      description: "决议一条蒸馏提案：accept / edit（需 body）/ reject；会话蒸馏审核只能 accept 或 reject。",
      requires: ["ingestion"],
      input: z.object({
        proposal_id: z.string(),
        decision: z.enum(["accept", "edit", "reject"]),
        body: z.string().optional(),
      }),
      run: async (a) => {
        const ing = requireService(ingestion, "摄入层");
        const pending = ing
          .listProposalsByStatus("pending")
          .find((proposal) => proposal.id === a.proposal_id);
        if (a.decision === "accept" && pending?.target.kind === "source_distill") {
          return await ing.acceptSourceDistillProposal(a.proposal_id);
        }
        if (a.decision === "edit") {
          if (pending?.target.kind === "source_distill") {
            throw new Error("source_distill requests cannot be edited");
          }
          return ing.editProposal(a.proposal_id, a.body ?? "");
        }
        return ing.rejectProposal(a.proposal_id);
      },
    },

    // 16. 读取已导入的聊天消息（直聊 / 群聊，供模型检索聊天原文）
    {
      name: "knowself_chat_messages",
      description:
        "读取已导入的聊天消息：query 做关键词检索；conversation_id 读指定会话；person_id 读与某人的直聊；" +
        "group_only=true 且无其它过滤时列出群聊目录。",
      requires: ["person"],
      input: z.object({
        query: z.string().optional(),
        conversation_id: z.string().optional(),
        person_id: z.string().optional(),
        group_only: z.boolean().optional(),
        limit: z.number().int().optional(),
      }),
      run: (a) => {
        const store = requireService(personStore, "人物层");
        const limit = Math.min(Math.max(a.limit ?? 30, 1), 100);
        const project = (row: {
          message_id: string;
          conversation_id: string;
          sender_name: string;
          role: string;
          msg_date: string;
          content: string;
          content_type: string;
        }) => ({
          message_id: row.message_id,
          conversation_id: row.conversation_id,
          sender_name: row.sender_name,
          role: row.role,
          msg_date: row.msg_date,
          content_type: row.content_type,
          content: row.content.slice(0, 500),
        });
        const query = a.query?.trim() ?? "";
        if (query !== "") {
          const rows = store.messages.searchContent({
            keyword: query,
            ...(a.conversation_id === undefined ? {} : { conversation_id: a.conversation_id }),
            ...(a.person_id === undefined ? {} : { person_id: a.person_id }),
            ...(a.group_only === true ? { conversation_kind: "group" } : {}),
          });
          return rows.slice(-limit).reverse().map(project);
        }
        if (a.conversation_id !== undefined) {
          const total = store.messages.count({ conversation_id: a.conversation_id });
          if (total === 0) return [];
          return store.messages
            .list({ conversation_id: a.conversation_id, limit, offset: Math.max(0, total - limit) })
            .reverse()
            .map(project);
        }
        if (a.person_id !== undefined) {
          const conversationKind = a.group_only === true ? "group" : "direct";
          const total = store.messages.count({ person_id: a.person_id, conversation_kind: conversationKind });
          if (total === 0) return [];
          return store.messages
            .list({
              person_id: a.person_id,
              conversation_kind: conversationKind,
              limit,
              offset: Math.max(0, total - limit),
            })
            .reverse()
            .map(project);
        }
        if (a.group_only === true) {
          return store.conversations.list({ kind: "group", limit }).map((group) => ({
            conversation_id: group.conversation_id,
            title: group.title,
            member_count: group.member_count,
            msg_count: group.msg_count,
            last_msg_at: group.last_msg_at,
          }));
        }
        throw new Error("需要 query / conversation_id / person_id，或 group_only=true 列出群聊");
      },
    },

    // 17. 聊天记录摄入（人物层 + 摄入层；source_id 路径用 chatIngest + ingestion）
    {
      name: "knowself_import_chat",
      description:
        "从导出目录摄入聊天记录，写入多主体人物库。可选 source_id 走 pipeline（含 chatCommitter / proposalSink）。",
      requires: ["person", "ingestion"],
      input: z.object({
        dir: z.string(),
        source_id: z.string().optional(),
        only: z.array(z.string()).optional(),
        reader: z.enum(["txt", "json"]).optional(),
      }),
      run: async (a) => {
        const person = requireService(personStore, "人物层");
        const chat = requireService(chatIngest, "摄入层");
        const ing = requireService(ingestion, "摄入层");
        const opts: Record<string, unknown> = {
          store: person,
          dir: a.dir,
        };
        if (a.source_id) opts.source_id = a.source_id;
        if (a.only) opts.only = a.only;
        if (a.reader) opts.reader = a.reader;
        if (a.source_id) {
          opts.chatCommitter = chat.createChatMessageCommitter(person);
          // A1-2：接入真实 ingestion 提案系统（pipeline 路径提案真正落 pending）。
          opts.proposalSink = makeIngestionProposalSink(ing, profileStore);
        }
        return await chat.ingestExport(opts as never);
      },
    },
  ];

  const available = availableLayers(services);
  return specs
    .filter((spec) => (spec.requires ?? []).every((layer) => available.has(layer)))
    .map((spec) => buildTool(services, spec));
}
