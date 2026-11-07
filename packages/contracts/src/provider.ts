/**
 * provider.ts — knowSelf 模型适配层契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/provider.ts` 抄录。
 *
 * 工作单元：provider-adapter
 * 关联模块：
 *   - chat-engine     调 ProviderAdapter.runWithTools / chat
 *   - context-router  L2 分类与 Reranker 通过本契约调"便宜小 provider"
 *   - mcp-host        提供 ToolRegistry，但与本文件解耦（见 tool.ts）
 *   - settings        ProviderConfig 由 settings.providers 持久化
 *
 * 协议级抽象（DESIGN.md §4.4）：
 *   不按厂商分，按协议分。
 *   - openai      兼容 /v1/chat/completions（DeepSeek / OpenRouter / Together / 多数聚合）
 *   - anthropic   兼容 /v1/messages（DeepSeek anthropic 端点 / Anthropic 官方 / Bedrock 网关）
 *   - custom      预留口子，MVP 不实现，让弱模型一眼看到分支位置
 *
 * 弱模型实施提示：
 *   1. 永远从 settings.providers 读 ProviderConfig，不要硬编码 base_url / api_key。
 *   2. cache_control 仅在 protocol === "anthropic" 时有效，其他协议要静默丢弃，不要报错。
 *   3. supports_tools / supports_caching 是**运行时探测结果**，不要从 settings 读取后当真，
 *      启动 healthcheck 才是权威来源。
 *   4. 工具循环 runWithTools 实现位于 provider-adapter（见 tool.ts ToolRegistry 接口），
 *      本文件只定义"调 LLM"的入参/出参，不定义工具循环细节。
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";

// ──────────────────────────────────────────────────────────────────────────
//  公共原子
// ──────────────────────────────────────────────────────────────────────────

/**
 * Provider ID — 用户在 settings.json 里给的稳定标识，UI 顶部下拉显示用。
 * 全局唯一；含字母数字下划线 dash 点。
 */
export const ProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "provider id 只允许字母数字 . _ -");

/** 协议方言。 */
export const ProtocolSchema = z.enum(["openai", "anthropic", "custom"]);

/**
 * 用途标签 — 一个 provider 可同时承担多种用途，UI 与各调用方按 purpose 选 provider。
 *   chat       主对话（默认 UI 顶部下拉只列含 chat 的）
 *   rerank     L3 检索的 LLM Reranker（context-router）
 *   classify   L2 卡片分类器（context-router）
 *   distill    自动回写蒸馏（chat-engine 触发，写回 profile-store）
 *   embed      句向量（MVP 不用，留 V2 接外部 embed 服务）
 */
export const ProviderPurposeSchema = z.enum(["chat", "rerank", "classify", "distill", "embed"]);

// ──────────────────────────────────────────────────────────────────────────
//  ProviderConfig — settings.providers[] 的形状
//  （在 settings.ts 中被复用为 settings.providers 字段类型）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 单个 provider 的用户配置。
 *
 * 字段说明：
 *   id                ProviderId（用户起的稳定名）
 *   label             UI 显示的人类可读名称
 *   protocol          openai / anthropic / custom
 *   base_url          API 根地址；不需要尾斜杠
 *   api_key           API key；从 settings.json 读，永远不进日志、不返回前端
 *   model             默认模型名（聚合平台的 routing key 也走这个字段）
 *   purposes          本 provider 承担的用途集合，至少 1 个
 *   default_for       本 provider 是某用途的默认选项时打钩；同一 purpose 至多一个 default
 *   request_timeout_ms 单次请求超时（含 SSE 全程读取时间）
 *   max_retries       网络层重试次数；不含工具循环
 *   max_concurrency   单进程对该 provider 的最大并发请求数
 *   extra_headers     透传给 fetch 的额外 header（少数聚合平台需要 X-Source 等）
 *   declared_supports_tools   用户声明本 provider 支持 tool use（启动时 healthcheck 复核）
 *   declared_supports_caching 用户声明本 provider 支持 prompt cache（启动时 healthcheck 复核）
 *   tags              UI 过滤用的自由标签（"国内"、"便宜"、"长文本"...）
 */
export const ProviderConfigSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1).max(64),
  protocol: ProtocolSchema,
  base_url: z.string().url(),
  api_key: z.string().min(1).max(512),
  model: z.string().min(1).max(128),
  purposes: z.array(ProviderPurposeSchema).min(1).max(5),
  default_for: z.array(ProviderPurposeSchema).max(5).default([]),
  request_timeout_ms: z.number().int().min(1000).max(600_000).default(120_000),
  max_retries: z.number().int().min(0).max(5).default(2),
  max_concurrency: z.number().int().min(1).max(32).default(4),
  extra_headers: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
  declared_supports_tools: z.boolean().default(false),
  declared_supports_caching: z.boolean().default(false),
  tags: z.array(z.string().min(1).max(32)).max(8).default([]),
});

// ──────────────────────────────────────────────────────────────────────────
//  Healthcheck — 启动时探测每个 provider 的真实能力
// ──────────────────────────────────────────────────────────────────────────

/** failover 状态机的三态。 */
export const ProviderHealthStateSchema = z.enum(["healthy", "degraded", "dead"]);

/**
 * 单个 provider 的健康记录（运行时内存态，不入 settings）。
 *
 * 状态机（实施位于 provider-adapter/failover.ts）：
 *   healthy ─ 1 次失败  ─► degraded
 *   degraded ─ 1 次成功 ─► healthy
 *   degraded ─ 连续 3 次失败 ─► dead
 *   dead ─ 5 分钟后 ─► degraded（半开）
 *
 * 字段说明：
 *   provider_id              对应 ProviderConfig.id
 *   state                    healthy / degraded / dead
 *   probed_supports_tools    healthcheck 实测结果（覆盖 declared_supports_tools）
 *   probed_supports_caching  同上
 *   latency_p50_ms           最近 N 次成功调用的中位延迟（failover 排序用）
 *   consecutive_failures     连续失败计数
 *   last_error               最近一次错误的简短描述（不含敏感信息）
 *   last_checked_at          最近一次 healthcheck / 真实调用时间
 *   reactivate_at            state=dead 时，何时允许半开重试
 */
export const ProviderHealthSchema = z.object({
  provider_id: ProviderIdSchema,
  state: ProviderHealthStateSchema,
  probed_supports_tools: z.boolean(),
  probed_supports_caching: z.boolean(),
  latency_p50_ms: z.number().int().min(0).max(600_000).nullable(),
  consecutive_failures: z.number().int().min(0).max(999).default(0),
  last_error: z.string().max(512).nullable(),
  last_checked_at: IsoTimestampSchema.nullable(),
  reactivate_at: IsoTimestampSchema.nullable(),
});

/** healthcheck 探测请求时本次需要测什么。 */
export const HealthcheckProbeSchema = z.object({
  /** 测 ping（一次极小 chat 请求）。 */
  ping: z.boolean().default(true),
  /** 测 tool use（让 provider 调一个 echo 工具）。 */
  tools: z.boolean().default(true),
  /** 测 prompt cache（带 cache_control 看是否报错并返回 cache_read_tokens）。 */
  caching: z.boolean().default(true),
});

/** 单次 healthcheck 的结果（每项独立判定）。 */
export const HealthcheckResultSchema = z.object({
  provider_id: ProviderIdSchema,
  ping_ok: z.boolean(),
  tools_ok: z.boolean(),
  caching_ok: z.boolean(),
  /** 主观延迟（包括 SSE 第一字节）。 */
  rtt_ms: z.number().int().min(0).max(600_000),
  /** 探测时间。 */
  checked_at: IsoTimestampSchema,
  /** 任一子项失败时的错误描述。 */
  error: z.string().max(512).nullable(),
});

// ──────────────────────────────────────────────────────────────────────────
//  ChatOptions — 调 LLM 的入参
//  注意：messages / tools 不在本 schema，runWithTools 入参另行约定（见 tool.ts）。
//  这里只是"协议级"调用的最小通用入参。
// ──────────────────────────────────────────────────────────────────────────

/**
 * 提供给 provider 的工具描述（tool.ts 中 ToolDescriptor 的精简版）。
 * 真实 ToolRegistry 接口在 tool.ts；这里只是 ChatOptions.tools 字段需要引用的形状。
 * 运行时由 provider-adapter 把 ToolRegistry.list() 转成本结构后注入请求。
 */
export const ToolDescriptorRefSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024),
  /** JSON Schema 形态的 input 描述；provider 直接透传给 LLM。 */
  input_schema: z.record(z.string(), z.unknown()),
});

/** 推断模式开关 — 仅 Anthropic 兼容协议有效，其他协议忽略。 */
export const ThinkingConfigSchema = z.object({
  enabled: z.boolean(),
  /** 推断 token 上限。 */
  budget_tokens: z.number().int().min(1024).max(64_000).optional(),
});

/**
 * 调 provider 的入参。
 *
 * 字段说明：
 *   provider_id    选哪个 provider；server 据此查找 ProviderConfig
 *   messages       已经过 context-router 加工的 ProviderMessage[]（见 chat.ts）
 *   tools          本轮要带的工具描述列表；不带工具循环则传空数组
 *   stream         是否流式（默认 true）
 *   max_tokens     completion token 上限
 *   temperature    0–2；默认 0（DESIGN-14 §2.5(b) 抗抖动；省略即 0）
 *   top_p          0–1
 *   stop_sequences 停止串
 *   thinking       Anthropic 推断模式（仅 anthropic 兼容协议有效）
 *   metadata       透传给 provider 的自定义 metadata（聚合平台用于路由 / 计费）
 *   abort_signal   不在 schema（实现层用 AbortController），此处仅注释提示
 */
export const ChatOptionsSchema = z.object({
  provider_id: ProviderIdSchema,
  /** 引用 chat.ts 的 ProviderMessage；为避免文件循环引用，这里用宽松 record 占位，
   *  实施时改成 `import { ProviderMessageSchema } from "./chat"`。 */
  messages: z.array(z.record(z.string(), z.unknown())).min(1).max(256),
  tools: z.array(ToolDescriptorRefSchema).max(64).default([]),
  stream: z.boolean().default(true),
  max_tokens: z.number().int().min(1).max(64_000).default(4096),
  temperature: z.number().min(0).max(2).default(0),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string().min(1).max(64)).max(4).default([]),
  thinking: ThinkingConfigSchema.optional(),
  metadata: z.record(z.string().min(1).max(64), z.string().max(256)).default({}),
});

// ──────────────────────────────────────────────────────────────────────────
//  ChatChunk — provider-adapter 内部流式输出
//
//  与 chat.ts 的 ChatEvent 区分：
//    ChatChunk  是 provider-adapter 直接吐给 chat-engine 的低层 chunk
//    ChatEvent  是 chat-engine 二次包装后给 web-ui 的 SSE 事件
//  chat-engine 的转换规则：
//    text          → text_delta
//    tool_use      → tool_use_start + tool_use_end
//    tool_result   → tool_result（chat-engine 自己调 mcp-host 后产出，不来自 provider）
//    message_end   → message_end
//    error         → error
//  弱模型实施提示：provider-adapter 永远不直接发 SSE；那是 chat-engine 的职责。
// ──────────────────────────────────────────────────────────────────────────

export const ChatChunkTextSchema = z.object({
  type: z.literal("text"),
  delta: z.string().max(8000),
});

export const ChatChunkToolUseSchema = z.object({
  type: z.literal("tool_use"),
  /** provider 给的 tool_use_id，跨 chunk 唯一。 */
  tool_use_id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  /** 入参整体（流中片段在 provider-adapter 内部已聚合）。 */
  input: z.unknown(),
});

/** stop_reason 来自 provider，含义统一到 chat.ts 的同名 enum。 */
export const ChatChunkMessageEndSchema = z.object({
  type: z.literal("message_end"),
  stop_reason: z.enum(["end_turn", "tool_use", "max_tokens", "stop_sequence"]),
});

export const ChatChunkErrorSchema = z.object({
  type: z.literal("error"),
  /** provider 端透传的错误码（HTTP status 或 SDK error code）。 */
  upstream_status: z.number().int().min(100).max(699).nullable(),
  message: z.string().min(1).max(512),
  /** 是否可重试（速率限制 / 网络抖动 → true；鉴权失败 / 模型不存在 → false）。 */
  retryable: z.boolean(),
});

export const ChatChunkSchema = z.discriminatedUnion("type", [
  ChatChunkTextSchema,
  ChatChunkToolUseSchema,
  ChatChunkMessageEndSchema,
  ChatChunkErrorSchema,
]);

// ──────────────────────────────────────────────────────────────────────────
//  失败语义：ProviderError
// ──────────────────────────────────────────────────────────────────────────

/**
 * provider-adapter 抛出的错误码白名单。
 * chat-engine 收到后映射 chat.ts 的 ChatEventError.code：
 *   PROVIDER_NOT_FOUND   → BAD_REQUEST
 *   PROVIDER_DEAD        → NOT_READY
 *   AUTH_FAILED          → UNAUTHORIZED
 *   RATE_LIMITED         → PROVIDER_FAIL（retryable=true）
 *   UPSTREAM_5XX         → PROVIDER_FAIL
 *   STREAM_BROKEN        → PROVIDER_FAIL
 *   TOOL_LOOP_OVERFLOW   → TOOL_FAIL（循环超过 max_tool_iterations）
 *   ABORTED              → ABORTED
 */
export const ProviderErrorCodeSchema = z.enum([
  "PROVIDER_NOT_FOUND",
  "PROVIDER_DEAD",
  "AUTH_FAILED",
  "RATE_LIMITED",
  "UPSTREAM_5XX",
  "STREAM_BROKEN",
  "TOOL_LOOP_OVERFLOW",
  "ABORTED",
]);

export const ProviderErrorPayloadSchema = z.object({
  code: ProviderErrorCodeSchema,
  provider_id: ProviderIdSchema.optional(),
  message: z.string().min(1).max(512),
  /** 上游 HTTP status（若有）。 */
  upstream_status: z.number().int().min(100).max(699).nullable(),
  retryable: z.boolean(),
  trace_id: z.string().min(8).max(64).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type Protocol = z.infer<typeof ProtocolSchema>;
export type ProviderPurpose = z.infer<typeof ProviderPurposeSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export type ProviderHealthState = z.infer<typeof ProviderHealthStateSchema>;
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type HealthcheckProbe = z.infer<typeof HealthcheckProbeSchema>;
export type HealthcheckResult = z.infer<typeof HealthcheckResultSchema>;

export type ToolDescriptorRef = z.infer<typeof ToolDescriptorRefSchema>;
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type ChatOptions = z.infer<typeof ChatOptionsSchema>;

export type ChatChunk = z.infer<typeof ChatChunkSchema>;
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;
export type ProviderErrorPayload = z.infer<typeof ProviderErrorPayloadSchema>;
