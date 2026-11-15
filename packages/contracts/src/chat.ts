/**
 * chat.ts — knowSelf 对话引擎契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/chat.ts` 抄录。
 *
 * 工作单元：chat-engine
 * 关联模块：
 *   - web-ui          通过 Transport 调本契约定义的 ChatRequest / ChatEvent
 *   - context-router  消费 ChatHistoryMessage 构造 messages
 *   - provider-adapter 产出 ChatChunk（与 ChatEvent 一一映射）
 *   - profile-store   通过 ChatRequest.write_back_targets 给自动回写打标
 *
 * 三个抽象层次（弱模型不许混淆）：
 *   1. ChatHistoryMessage  — 对话历史，落 conversations.sqlite，跨会话持久化
 *   2. ProviderMessage     — 喂给 LLM provider 的 messages[]，由 context-router 组装；
 *                            含 system prompt 注入、L1/L2 注入、检索注入；不持久化
 *   3. ChatEvent           — SSE 流事件，从 server 推到 web-ui；不持久化
 *
 *   ChatHistoryMessage 与 ProviderMessage 形状不同：
 *     - History 只关心"用户/助手/工具"三方说了什么，不含 system 注入与 cache_control
 *     - Provider 经 context-router 加工后含 system messages、cache_control、tool_use blocks
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";

// ──────────────────────────────────────────────────────────────────────────
//  公共：会话 / 消息 ID
// ──────────────────────────────────────────────────────────────────────────

/** 会话 ID：UUID v4。前端发起新会话时本地生成，server 不二次校验。 */
export const ConversationIdSchema = z.string().uuid("conversation_id 必须是 UUID v4");

/** 消息 ID：UUID v4。一条消息一份 ID，跨 history 与 SSE 事件保持一致。 */
export const MessageIdSchema = z.string().uuid("message_id 必须是 UUID v4");

// ──────────────────────────────────────────────────────────────────────────
//  ChatHistoryMessage — 落库形状（conversations.sqlite）
//
//  存储策略：一条消息一行；assistant 含 tool_use 时把 tool_use blocks 序列化进 content
//  字段；tool 角色单独一行存 tool_result。这样能严格按照 LLM provider 协议复原。
// ──────────────────────────────────────────────────────────────────────────

export const ChatRoleSchema = z.enum(["user", "assistant", "tool"]);

/**
 * tool_use 引用 — assistant 决定要调工具时，把这个 block 写进 content。
 * 命名空间形式见 mcp.ts：`<sourceId>__<toolName>`。
 */
export const ToolUseBlockSchema = z.object({
  kind: z.literal("tool_use"),
  /** tool_use ID，由 provider 生成；后续 tool_result 必须带同一个 id 回引。 */
  tool_use_id: z.string().min(1).max(128),
  /** 工具全名（含命名空间前缀）。 */
  name: z.string().min(1).max(128),
  /** 工具入参，原样存（透传给 mcp-host）。 */
  input: z.unknown(),
});

/**
 * tool_result block — 工具执行完毕的回写。
 * is_error=true 时 output 是错误描述（string），LLM 据此决定是否重试。
 */
export const ToolResultBlockSchema = z.object({
  kind: z.literal("tool_result"),
  /** 与对应 tool_use_id 相同。 */
  tool_use_id: z.string().min(1).max(128),
  /** 是否错误结果（不抛异常，由 LLM 自行决定回退策略）。 */
  is_error: z.boolean().default(false),
  /** 工具返回值；JSON 序列化后落库，长度上限 64KB。 */
  output: z.string().max(65536),
});

export const TextBlockSchema = z.object({
  kind: z.literal("text"),
  text: z.string().max(65536),
});

/** 一条 history 消息的 content 是 block 列表，用 discriminated union。 */
export const ContentBlockSchema = z.discriminatedUnion("kind", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

/**
 * 落库的对话消息（不含 system；system 由 context-router 在每次请求时即时注入）。
 *
 * 字段说明：
 *   id              MessageId（UUID v4）
 *   conversation_id 所属会话 ID
 *   role            user / assistant / tool
 *   content         block 列表；user/tool 通常单条 text/tool_result，assistant 可混排 text+tool_use
 *   created_at      消息生成时间（server 写入时赋值）
 *   provider_id     生成本条消息的 provider id（仅 assistant 有；user/tool 为 null）
 *   model           生成本条消息所用的 model 名（仅 assistant 有）
 *
 * 弱模型实施提示：
 *   - tool 角色的 content 必须是单个 ToolResultBlock，不允许混 text。
 *   - 同一 turn 的 (assistant.tool_use, tool.tool_result) 通过 tool_use_id 关联。
 */
export const ChatHistoryMessageSchema = z.object({
  id: MessageIdSchema,
  conversation_id: ConversationIdSchema,
  role: ChatRoleSchema,
  content: z.array(ContentBlockSchema).min(1).max(64),
  created_at: IsoTimestampSchema,
  provider_id: z.string().min(1).max(64).nullable(),
  model: z.string().min(1).max(128).nullable(),
});

/** 一次会话的元数据（SQLite 单独一行）。 */
export const ConversationRecordSchema = z.object({
  id: ConversationIdSchema,
  /** 用户可改的标题；首次创建时由小模型从 user 首条消息提炼，UI 可手编。 */
  title: z.string().min(1).max(128),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  /** 消息条数缓存，避免每次 listConversations 都 count。 */
  message_count: z.number().int().min(0).max(99_999),
  /** 最近一次使用的 provider id（UI 默认带回这个）。 */
  last_provider_id: z.string().min(1).max(64).nullable(),
});

// ──────────────────────────────────────────────────────────────────────────
//  ProviderMessage — 喂给 provider-adapter 的 messages[]
//
//  与 ChatHistoryMessage 的区别：
//    - 含 system 角色（由 context-router 注入 L1/L2/检索结果）
//    - 含 cache_control 标记（仅 Anthropic 兼容协议会用，OpenAI 兼容协议会忽略）
//    - 不含 created_at / token_usage 等元数据（这些是落库才需要的）
//  ChatHistoryMessage 经过 context-router.buildContext() 转成 ProviderMessage 数组。
// ──────────────────────────────────────────────────────────────────────────

export const ProviderRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

/**
 * cache_control 标记：Anthropic 兼容协议透传到 SDK；OpenAI 兼容协议忽略。
 * type=ephemeral 表示"缓存到本会话结束即可"，type=persistent 留给 V2 长缓存。
 */
export const CacheControlSchema = z.object({
  type: z.enum(["ephemeral", "persistent"]),
});

export const ProviderMessageSchema = z.object({
  role: ProviderRoleSchema,
  content: z.array(ContentBlockSchema).min(1).max(64),
  /** 仅 system 与 user 大块（如 L1 注入）会带；assistant/tool 不带。 */
  cache_control: CacheControlSchema.optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  HTTP API：ChatRequest / ChatResponse(非流式) / ChatEvent(SSE)
// ──────────────────────────────────────────────────────────────────────────

/**
 * 对话请求 —— POST /api/chat。
 *
 * 字段说明：
 *   conversation_id   必填；前端 UUID v4 生成；server 不存在时自动建会话
 *   user_message      用户本轮输入（纯文本；图片 / 文件附件 V2 再加）
 *   provider_id       必填；UI 顶部下拉选定的 provider；server 校验存在性
 *   stream            是否流式（默认 true）；false 时走非流式 ChatResponse
 *   tools_enabled     本轮是否启用工具循环（默认 true）
 *   write_back        本轮结束后是否触发自动回写蒸馏（默认 true，V2 可关）
 */
export const ChatRequestSchema = z.object({
  conversation_id: ConversationIdSchema,
  user_message: z.string().min(1).max(16_000),
  provider_id: z.string().min(1).max(64),
  stream: z.boolean().default(true),
  tools_enabled: z.boolean().default(true),
  write_back: z.boolean().default(true),
});

/** 非流式响应：仅 stream=false 时使用，主要给测试与脚本场景。 */
export const ChatResponseSchema = z.object({
  conversation_id: ConversationIdSchema,
  message: ChatHistoryMessageSchema,
  /** 本次请求服务端组装的 messages 总 token 估算，调试用。 */
  prompt_token_estimate: z.number().int().min(0).max(2_000_000),
});

// ──────────────────────────────────────────────────────────────────────────
//  SSE 事件协议（ChatEvent）
//
//  传输形态：每个 chunk 是一行 SSE，形如：
//    event: <type>\n
//    data: <JSON>\n\n
//  data 的 JSON 形状即下面 ChatEvent 各分支。
//
//  事件顺序契约（弱模型实施时严格遵守）：
//    1. message_start                    （声明本轮 assistant 消息 id）
//    2. text_delta * N                   （流式文本增量；可与 tool_* 交错）
//    3. tool_use_start / tool_use_end    （收齐 tool_use 一次发；含 input）
//    4. tool_result                      （server 调 mcp-host 返回的结果）
//    5. （回到 1，进入下一轮 LLM 续写）
//    6. message_end
//    7. done                             （会话级终止；后续任何事件都不该再来）
//    出错时任意阶段插入 error 后必须关闭流；error 之后不再发 done。
// ──────────────────────────────────────────────────────────────────────────

export const ChatEventMessageStartSchema = z.object({
  type: z.literal("message_start"),
  conversation_id: ConversationIdSchema,
  message_id: MessageIdSchema,
  /** 服务端的本次请求追踪 id，便于 web-ui 与 server 日志对齐。 */
  trace_id: z.string().min(8).max(64),
  occurred_at: IsoTimestampSchema,
});

export const ChatEventTextDeltaSchema = z.object({
  type: z.literal("text_delta"),
  message_id: MessageIdSchema,
  /** 增量文本片段（已经过 SSE 解码）。 */
  delta: z.string().max(8000),
});

export const ChatEventToolUseStartSchema = z.object({
  type: z.literal("tool_use_start"),
  message_id: MessageIdSchema,
  tool_use_id: z.string().min(1).max(128),
  /** 工具全名（含命名空间前缀）。 */
  name: z.string().min(1).max(128),
});

export const ChatEventToolUseEndSchema = z.object({
  type: z.literal("tool_use_end"),
  message_id: MessageIdSchema,
  tool_use_id: z.string().min(1).max(128),
  /** 入参收齐后整体抛出（避免 web-ui 拼接增量 JSON）。 */
  input: z.unknown(),
});

export const ChatEventToolResultSchema = z.object({
  type: z.literal("tool_result"),
  message_id: MessageIdSchema,
  tool_use_id: z.string().min(1).max(128),
  is_error: z.boolean().default(false),
  /** 工具返回的可读输出；UI 直接展示。 */
  output: z.string().max(65536),
  /** 调用耗时（毫秒），UI 可显示。 */
  duration_ms: z.number().int().min(0).max(600_000),
});

export const ChatEventMessageEndSchema = z.object({
  type: z.literal("message_end"),
  message_id: MessageIdSchema,
  stop_reason: z.enum(["end_turn", "tool_use", "max_tokens", "stop_sequence"]),
});

export const ChatEventDoneSchema = z.object({
  type: z.literal("done"),
  conversation_id: ConversationIdSchema,
  /** 是否触发了自动回写（异步进行，UI 可显示一个小角标）。 */
  write_back_triggered: z.boolean(),
});

export const ChatEventErrorSchema = z.object({
  type: z.literal("error"),
  /** 错误码白名单；UI 据此决定提示文案与是否可重试。 */
  code: z.enum([
    "BAD_REQUEST", // 400
    "UNAUTHORIZED", // 401
    "NOT_FOUND", // 404
    "LOCK_BUSY", // 409 — 档案被另一进程锁定
    "VALIDATION", // 422 — Zod 校验失败
    "INTERNAL", // 500
    "NOT_READY", // 503 — provider/mcp/retriever 还在启动
    "PROVIDER_FAIL", // 502 — provider 上游报错
    "TOOL_FAIL", // 502 — 工具执行失败到无法续写
    "ABORTED", // 499 — 用户/客户端断开
  ]),
  message: z.string().min(1).max(512),
  /** 触发错误时正在处理的 message_id（如有）。 */
  message_id: MessageIdSchema.optional(),
  trace_id: z.string().min(8).max(64).optional(),
});

export const ChatEventSchema = z.discriminatedUnion("type", [
  ChatEventMessageStartSchema,
  ChatEventTextDeltaSchema,
  ChatEventToolUseStartSchema,
  ChatEventToolUseEndSchema,
  ChatEventToolResultSchema,
  ChatEventMessageEndSchema,
  ChatEventDoneSchema,
  ChatEventErrorSchema,
]);

// ──────────────────────────────────────────────────────────────────────────
//  会话管理 API：list / get / delete / rename
// ──────────────────────────────────────────────────────────────────────────

/** GET /api/conversations 查询参数。 */
export const ListConversationsQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});

export const ListConversationsResponseSchema = z.object({
  items: z.array(ConversationRecordSchema),
  total: z.number().int().min(0).max(1_000_000),
});

/** GET /api/conversations/:id 返回会话元数据 + 全部 history。 */
export const GetConversationResponseSchema = z.object({
  conversation: ConversationRecordSchema,
  messages: z.array(ChatHistoryMessageSchema),
});

/** PATCH /api/conversations/:id 入参（仅允许改 title）。 */
export const RenameConversationRequestSchema = z.object({
  title: z.string().min(1).max(128),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出（z.infer 推导，禁止手写 interface 重复）
// ──────────────────────────────────────────────────────────────────────────

export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;

export type ChatRole = z.infer<typeof ChatRoleSchema>;
export type ProviderRole = z.infer<typeof ProviderRoleSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type CacheControl = z.infer<typeof CacheControlSchema>;

export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>;

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;

export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;
export type GetConversationResponse = z.infer<typeof GetConversationResponseSchema>;
export type RenameConversationRequest = z.infer<typeof RenameConversationRequestSchema>;

// ──────────────────────────────────────────────────────────────────────────
//  W-34-T02：聊天记录**导入平台**
// ──────────────────────────────────────────────────────────────────────────

/**
 * 聊天记录**导入平台**（W-34-T02）。
 *
 * 与 `person.ts` 的 `AliasPlatformSchema` **不是一回事**，两者不得互相复用：
 *   - 本 schema 描述「这份导出产物由哪个客户端产生、该用哪个解析器读」；
 *     值域只放**真的有解析器**的平台；
 *   - `AliasPlatformSchema` 是**别名命名空间**（wechat / qq / telegram / discord / other），
 *     含 telegram / discord 这类永远不会出现在导入链路上的值。
 * 合并二者会造出「接口声称支持 telegram 导入、实际根本没有解析器」这种谎。
 *
 * 新增枚举值的前提：先落地对应 reader/parser，再加值。加值当天必须同步
 * `dsh/knowself/src/routes/chat-import.ts` 的平台闸——
 * 当前 QQ / 抖音一律 400 `PLATFORM_NOT_SUPPORTED`。
 */
export const ChatPlatformSchema = z.enum(["wechat", "qq", "douyin"]);

export type ChatPlatform = z.infer<typeof ChatPlatformSchema>;
