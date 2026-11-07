/**
 * mcp.ts — knowSelf MCP host 配置与运行时契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/mcp.ts` 抄录。
 *
 * 工作单元：mcp-host
 * 关联模块：
 *   - settings        McpServerConfig / BuiltinToolConfig 由 settings.json 持久化
 *   - provider-adapter 通过 ToolRegistry 间接消费（见 tool.ts）
 *   - chat-engine     通过 /api/system/status 暴露 McpServerStatus 给 web-ui
 *   - web-ui          设置页展示连接状态、工具列表、错误日志
 *
 * 关键决策（2026-05-27 落档）：
 *   - MVP 工具来源仅 2 个外部 stdio MCP：fetch（主力）+ chrome-devtools（兜底）
 *   - 内置 REST wrapper（builtin）接口预留，MVP 不实现，V2 加 Bocha / Tavily / Brave
 *   - Fetch 透明 fallback：mcp-host 内部判定反爬，自动切 chrome-devtools，对 LLM 隐藏
 *
 * 反爬判定多重条件（任一命中即触发 fallback；阈值见 FetchFallbackPolicy）：
 *   - 内容长度 < min_content_length
 *   - 含 fallback_keywords 任一关键词
 *   - HTTP 状态非 2xx
 *
 * 弱模型实施提示：
 *   1. settings.mcp_servers[] 的形状即 McpServerConfig；不要在 mcp-host 内部重新定义。
 *   2. McpServerStatus 是**运行时内存态**，不写回 settings；启动时从零重建。
 *   3. spawn 子进程要在应用退出时 SIGTERM 5s 后 SIGKILL；这条规则不在 schema 而在 lifecycle.ts。
 *   4. 内置 wrapper 接口（BuiltinToolConfig）MVP 不出现实例，留作 V2 入口；
 *      schema 必须现在定，避免 V2 改 settings.json 形状。
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";
import { ToolSourceIdSchema } from "./tool";

// ──────────────────────────────────────────────────────────────────────────
//  McpServerConfig — settings.mcp_servers[] 的形状
// ──────────────────────────────────────────────────────────────────────────

/**
 * MCP server 传输方式。
 *   stdio          子进程 + JSON-RPC over stdio（MVP 唯一启用）
 *   streamable_http  HTTP + SSE（V2，远程 MCP server）
 */
export const McpTransportSchema = z.enum(["stdio", "streamable_http"]);

/** stdio 传输的子进程启动参数。 */
export const McpStdioConfigSchema = z.object({
  transport: z.literal("stdio"),
  /** 可执行命令，如 "npx" / "node" / 绝对路径。 */
  command: z.string().min(1).max(256),
  /** 命令参数列表。 */
  args: z.array(z.string().max(512)).max(32).default([]),
  /** 子进程环境变量（覆盖父进程环境）。 */
  env: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
  /** 工作目录；不填用应用根。 */
  cwd: z.string().max(512).optional(),
});

/** streamable_http 传输（V2）。 */
export const McpHttpConfigSchema = z.object({
  transport: z.literal("streamable_http"),
  url: z.string().url(),
  /** Bearer token / API key。 */
  auth_token: z.string().max(2048).optional(),
  headers: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
});

export const McpTransportConfigSchema = z.discriminatedUnion("transport", [
  McpStdioConfigSchema,
  McpHttpConfigSchema,
]);

/**
 * McpServerConfig — 用户在 settings.mcp_servers[] 配置的形状。
 *
 * 字段说明：
 *   id                ToolSourceId；同时是工具命名空间前缀
 *   label             UI 显示名
 *   transport_config  按 transport 分支的具体配置
 *   enabled           是否启用；false 时不 spawn
 *   purpose           人类可读用途（"primary_web_reader" / "fallback_when_fetch_fails" 等）
 *   startup_timeout_ms server spawn 到 ready 的超时
 *   request_timeout_ms 单次工具调用超时
 *   max_concurrency   并发调用上限
 *   restart_on_crash  崩溃后自动重启
 *   max_restarts      连续失败几次后标记 dead（默认 3）
 *   dead_cooldown_ms  dead 后多久半开重试（默认 5 分钟）
 */
export const McpServerConfigSchema = z.object({
  id: ToolSourceIdSchema,
  label: z.string().min(1).max(64),
  transport_config: McpTransportConfigSchema,
  enabled: z.boolean().default(true),
  purpose: z.string().max(64).default(""),
  startup_timeout_ms: z.number().int().min(5_000).max(120_000).default(30_000),
  request_timeout_ms: z.number().int().min(1_000).max(600_000).default(60_000),
  max_concurrency: z.number().int().min(1).max(16).default(4),
  restart_on_crash: z.boolean().default(true),
  max_restarts: z.number().int().min(0).max(10).default(3),
  dead_cooldown_ms: z.number().int().min(60_000).max(3_600_000).default(300_000),
});

// ──────────────────────────────────────────────────────────────────────────
//  BuiltinToolConfig — settings.builtin_tools[] 的形状（V2 启用）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 内置 REST wrapper 类型。
 * MVP 不启用；V2 加搜索后端时按 kind 路由实现：
 *   bocha      Bocha 联网搜索（国内主力候选）
 *   tavily     Tavily AI 搜索
 *   brave      Brave Search API
 *   custom     自定义 REST endpoint（开放扩展点）
 */
export const BuiltinToolKindSchema = z.enum(["bocha", "tavily", "brave", "custom"]);

export const BuiltinToolConfigSchema = z.object({
  id: ToolSourceIdSchema,
  label: z.string().min(1).max(64),
  kind: BuiltinToolKindSchema,
  enabled: z.boolean().default(false),
  /** REST endpoint 根地址；kind=custom 时必填。 */
  base_url: z.string().url().optional(),
  api_key: z.string().min(1).max(512).optional(),
  /** 请求超时。 */
  request_timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
  /** 自由配置；不同 kind 的具体字段在实施时定（rate_limit / region / safe_search ...）。 */
  options: z.record(z.string(), z.unknown()).default({}),
});

// ──────────────────────────────────────────────────────────────────────────
//  ToolDefaults — settings.tool_defaults 的形状
// ──────────────────────────────────────────────────────────────────────────

/**
 * fetch 透明 fallback 策略（mcp-host 内部用，不暴露给 LLM）。
 *
 * 字段说明：
 *   enabled              是否启用 fallback
 *   primary_source_id    主力来源（默认 "fetch"）
 *   fallback_source_id   兜底来源（默认 "chrome-devtools"）
 *   min_content_length   返回内容低于此长度视为反爬触发
 *   fallback_keywords    命中任一即触发 fallback（不区分大小写）
 *   trigger_on_non_2xx   HTTP 状态非 2xx 时是否触发 fallback
 *   include_hint         fallback 后是否在 tool_result 输出末尾附加提示文字
 */
export const FetchFallbackPolicySchema = z.object({
  enabled: z.boolean().default(true),
  primary_source_id: ToolSourceIdSchema.default("fetch"),
  fallback_source_id: ToolSourceIdSchema.default("chrome-devtools"),
  min_content_length: z.number().int().min(0).max(10_000).default(100),
  fallback_keywords: z
    .array(z.string().min(1).max(64))
    .max(32)
    .default(["请验证", "机器人", "Access Denied", "403", "verify", "captcha", "forbidden"]),
  trigger_on_non_2xx: z.boolean().default(true),
  include_hint: z.boolean().default(false),
});

/**
 * 工具默认行为（settings.tool_defaults）。
 *
 * 字段说明：
 *   enabled_globally      全局工具开关（用户设置里"禁用所有联网工具"）
 *   fetch_fallback_policy 上面那个 fallback 策略
 *   per_template          各对话模板的工具开关（V2 起细化）；MVP 仅 free_chat 一项
 *   system_prompt_addendum 注入到 system prompt 的工具使用规范文字
 */
export const PerTemplateToggleSchema = z.record(z.string().min(1).max(64), z.boolean());

export const ToolDefaultsSchema = z.object({
  enabled_globally: z.boolean().default(true),
  fetch_fallback_policy: FetchFallbackPolicySchema.default({}),
  per_template: PerTemplateToggleSchema.default({ free_chat: true }),
  system_prompt_addendum: z.string().max(2048).default(""),
});

// ──────────────────────────────────────────────────────────────────────────
//  McpServerStatus — 运行时内存态
//  通过 mcp-host.getStatus() 暴露给 chat-engine → web-ui 设置页
// ──────────────────────────────────────────────────────────────────────────

export const McpHealthStateSchema = z.enum([
  "starting", // spawn 中，未 ready
  "healthy", // 工具可用
  "degraded", // 最近一次调用失败但未到 dead 阈值
  "dead", // 连续失败超阈值，等冷却
  "disabled", // settings.enabled=false
]);

/**
 * 单个 server 的运行时状态。
 *
 * 字段说明：
 *   server_id           McpServerConfig.id
 *   state               健康状态机
 *   pid                 stdio 子进程 PID（streamable_http 为 null）
 *   started_at          spawn 时间
 *   ready_at            首次 list_tools 成功时间
 *   last_error          最近一次错误描述
 *   restart_count       已重启次数
 *   reactivate_at       state=dead 时何时半开
 *   tool_names          当前注册到 ToolRegistry 的工具全名（含命名空间前缀）
 */
export const McpServerStatusSchema = z.object({
  server_id: ToolSourceIdSchema,
  state: McpHealthStateSchema,
  pid: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .nullable(),
  started_at: IsoTimestampSchema.nullable(),
  ready_at: IsoTimestampSchema.nullable(),
  last_error: z.string().max(512).nullable(),
  restart_count: z.number().int().min(0).max(999),
  reactivate_at: IsoTimestampSchema.nullable(),
  tool_names: z.array(z.string().min(3).max(160)).max(128),
});

/** mcp-host 启动时的快照——所有 server 的状态合集。 */
export const McpHostSnapshotSchema = z.object({
  servers: z.array(McpServerStatusSchema),
  /** 当前 ToolRegistry 中工具总数。 */
  tool_count: z.number().int().min(0).max(1024),
  /** 是否所有 server 都至少 ready 过一次（启动收敛标志）。 */
  all_ready: z.boolean(),
  collected_at: IsoTimestampSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  错误码
// ──────────────────────────────────────────────────────────────────────────

export const McpErrorCodeSchema = z.enum([
  "SERVER_NOT_FOUND", // server_id 不存在
  "SERVER_DISABLED", // 用户已禁用
  "SPAWN_FAILED", // 子进程启动失败
  "STARTUP_TIMEOUT", // 30s 内未 ready
  "RPC_TIMEOUT", // 工具调用超时
  "RPC_ERROR", // MCP 协议层错误（JSON-RPC error response）
  "DEAD_COOLDOWN", // 处于 dead 冷却期
  "INVALID_TRANSPORT", // transport 配置不一致（少见）
]);

export const McpErrorPayloadSchema = z.object({
  code: McpErrorCodeSchema,
  server_id: ToolSourceIdSchema.optional(),
  message: z.string().min(1).max(512),
  trace_id: z.string().min(8).max(64).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpStdioConfig = z.infer<typeof McpStdioConfigSchema>;
export type McpHttpConfig = z.infer<typeof McpHttpConfigSchema>;
export type McpTransportConfig = z.infer<typeof McpTransportConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export type BuiltinToolKind = z.infer<typeof BuiltinToolKindSchema>;
export type BuiltinToolConfig = z.infer<typeof BuiltinToolConfigSchema>;

export type FetchFallbackPolicy = z.infer<typeof FetchFallbackPolicySchema>;
export type ToolDefaults = z.infer<typeof ToolDefaultsSchema>;

export type McpHealthState = z.infer<typeof McpHealthStateSchema>;
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
export type McpHostSnapshot = z.infer<typeof McpHostSnapshotSchema>;

export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;
export type McpErrorPayload = z.infer<typeof McpErrorPayloadSchema>;
