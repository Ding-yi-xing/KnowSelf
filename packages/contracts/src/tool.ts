/**
 * tool.ts — knowSelf 工具调用契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/tool.ts` 抄录。
 *
 * 工作单元：双归属——形状由 mcp-host 与 provider-adapter 协商
 *   - mcp-host          实现 ToolRegistry，把 stdio MCP servers 与 builtin REST wrappers
 *                       注册成统一的 ToolDescriptor，并执行 invoke
 *   - provider-adapter  消费 ToolRegistry，在 runWithTools 工具循环中调用 invoke
 *
 * 关键解耦（DESIGN.md §4.6b）：
 *   provider-adapter 只认 ToolDescriptor + ToolInvocation 两个形状，不关心工具来源；
 *   mcp-host 把外部 stdio MCP / 内置 REST / fetch fallback 全部抽象成 ToolDescriptor。
 *
 * 命名空间（决策 2026-05-27）：
 *   所有工具名加前缀 `<sourceId>__<toolName>`。例：
 *     fetch__fetch
 *     chrome-devtools__navigate_page
 *     chrome-devtools__take_snapshot
 *   ToolRegistry 调用时按 `__` 第一段拆分回真实来源。
 *
 * Fetch → Chrome DevTools 透明 fallback（A 方案，PROGRESS.md 已记 DESIGN-04 复核）：
 *   LLM 看到的是 fetch__fetch；mcp-host 内部判定反爬后自动切到 chrome-devtools，
 *   仍以 fetch__fetch 名义返回。本文件不暴露 fallback 字段（保持透明）。
 *
 * 弱模型实施提示：
 *   1. ToolDescriptor.input_schema 是 JSON Schema（非 Zod schema）。MCP server 返回的就是
 *      JSON Schema，直接透传给 LLM。Zod 校验仅在调用 invoke 前对 input 做（可选）。
 *   2. invoke 永远返回 ToolResult，不抛异常。失败要把错误描述放到 output 字段并 is_error=true。
 *   3. 工具名 `__` 是双下划线；不要写成单下划线。
 */

import { z } from "zod";
import { IsoTimestampSchema } from "./profile";

// ──────────────────────────────────────────────────────────────────────────
//  公共原子
// ──────────────────────────────────────────────────────────────────────────

/**
 * 工具来源 ID — 与 settings.mcp_servers[].id 或 settings.builtin_tools[].id 对应。
 * 字符约束严于 cardKey：禁止 `__`（避免与命名空间分隔符冲突）。
 */
export const ToolSourceIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "tool source id 只允许 a-z 0-9 -，且不允许双下划线")
  .refine((s) => !s.includes("__"), "source id 内不允许出现 `__`");

/**
 * 工具裸名 — MCP server 自报或 builtin wrapper 内部命名，不含来源前缀。
 * 不约束 `__`（部分 MCP server 工具名内部含双下划线，要兼容）。
 */
export const ToolBareNameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9._-]+$/, "tool bare name 只允许字母数字 . _ -");

/**
 * 工具全名 — `<sourceId>__<bareName>`。LLM 看到的就是这个。
 * 形状校验（不做语义拆分；语义拆分由 ToolRegistry 实现）。
 */
export const ToolFullNameSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9-]*__[a-zA-Z0-9._-]+$/, "tool full name 必须形如 sourceId__toolName");

/** tool_use_id：provider 生成；tool.ts 不规定具体形态（参见 chat.ts）。 */
export const ToolUseIdSchema = z.string().min(1).max(128);

// ──────────────────────────────────────────────────────────────────────────
//  ToolDescriptor — 注册到 ToolRegistry 的工具描述
//  这是 LLM 看到的工具元信息，input_schema 是 JSON Schema 透传
// ──────────────────────────────────────────────────────────────────────────

/**
 * ToolDescriptor 字段说明：
 *   name           工具全名（含命名空间前缀），ToolRegistry 用它寻址
 *   source_id      所属来源 ID（解析自 name 前缀，注册时 ToolRegistry 自动填）
 *   bare_name      去掉前缀的工具名
 *   description    给 LLM 看的说明（一般 1-3 句话；MCP server 提供）
 *   input_schema   JSON Schema 形态（Draft-07 兼容子集）；provider-adapter 直接透传给 LLM
 *   tags           自由标签（"web"、"file"、"shell" ...），UI 展示用
 *   declared_dangerous 用户在 settings 里把这个工具标为"危险"——UI 调用时弹确认
 *   timeout_ms     单次 invoke 的超时上限（mcp-host 级别）
 *   created_at     注册时间
 *
 * 注意：
 *   input_schema 不做 Zod 化，因为 MCP server 给的就是 JSON Schema 字符串/对象，
 *   做 Zod 校验只能加层失败点。Zod 仅校验本对象的元字段。
 */
export const ToolDescriptorSchema = z.object({
  name: ToolFullNameSchema,
  source_id: ToolSourceIdSchema,
  bare_name: ToolBareNameSchema,
  description: z.string().min(1).max(2048),
  input_schema: z.record(z.string(), z.unknown()),
  tags: z.array(z.string().min(1).max(32)).max(8).default([]),
  declared_dangerous: z.boolean().default(false),
  timeout_ms: z.number().int().min(1000).max(600_000).default(60_000),
  created_at: IsoTimestampSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  ToolUse / ToolInvocation / ToolResult
//  对应 chat.ts 的 ToolUseBlock / ToolResultBlock，但加了执行元数据
// ──────────────────────────────────────────────────────────────────────────

/**
 * ToolUse — provider-adapter 收齐流式 tool_use 之后的形状。
 * runWithTools 据此调 ToolRegistry.invoke。
 */
export const ToolUseSchema = z.object({
  tool_use_id: ToolUseIdSchema,
  name: ToolFullNameSchema,
  /** 原样透传给 invoke 的 input，类型由 input_schema 决定。 */
  input: z.unknown(),
});

/**
 * ToolInvocation — invoke 的实际入参，比 ToolUse 多了执行上下文。
 *   conversation_id  来自 chat.ts；mcp-host 据此做审计与速率限制
 *   message_id       触发本次工具调用的 assistant message
 *   trace_id         全链路追踪 ID
 *   abort_signal     不在 schema（实现层用 AbortController）
 */
export const ToolInvocationSchema = z.object({
  tool_use_id: ToolUseIdSchema,
  name: ToolFullNameSchema,
  input: z.unknown(),
  conversation_id: z.string().uuid(),
  message_id: z.string().uuid(),
  trace_id: z.string().min(8).max(64),
  /** invoke 时的 client request id，重复调用幂等用（V2 启用）。 */
  request_id: z.string().min(8).max(64).optional(),
});

/**
 * ToolResult — invoke 的返回。无论成功失败都返回这个形状，**永不抛异常**。
 *
 * 字段说明：
 *   tool_use_id     回引 ToolUse
 *   name            工具全名（用于事后审计；冗余但无坏处）
 *   is_error        true 时 output 是错误描述
 *   output          JSON 序列化后的字符串（为兼容 LLM 协议；最大 64KB）
 *   error_code      仅 is_error=true 时有意义；详见 ToolErrorCode
 *   started_at      mcp-host 发起调用的时间
 *   finished_at     调用结束时间
 *   duration_ms     finished - started
 *   source_id       实际执行来源（fallback 后可能与 name 前缀不一致——这是唯一暴露 fallback 的字段）
 */
export const ToolErrorCodeSchema = z.enum([
  "TOOL_NOT_FOUND", // 工具名不存在或已被禁用
  "INPUT_VALIDATION", // input 不符合 input_schema
  "TIMEOUT", // 超过 ToolDescriptor.timeout_ms
  "SOURCE_DEAD", // 工具来源（MCP server）当前不可用
  "UPSTREAM_ERROR", // 工具执行时 MCP server / REST API 报错
  "ABORTED", // 被 AbortController 中断
  "DANGEROUS_REJECTED", // declared_dangerous=true 且用户在 UI 拒绝执行
]);

export const ToolResultSchema = z.object({
  tool_use_id: ToolUseIdSchema,
  name: ToolFullNameSchema,
  is_error: z.boolean(),
  output: z.string().max(65536),
  error_code: ToolErrorCodeSchema.nullable(),
  started_at: IsoTimestampSchema,
  finished_at: IsoTimestampSchema,
  duration_ms: z.number().int().min(0).max(600_000),
  /** 实际执行工具的来源 ID（fallback 时可能与 name 前缀不一致）。 */
  source_id: ToolSourceIdSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  ToolRegistry —— 接口约定（schema 形态描述，仅供阅读）
//
//  ToolRegistry 不是 schema 类型，是接口；本契约只列方法签名供两方对齐。
//  实施位于 `packages/mcp-host/src/index.ts`。
//  provider-adapter 仅依赖以下 4 个方法：list / get / invoke / onChange
//
//  list()                           读取当前所有 ToolDescriptor，启动 / 重连后会变化
//  get(name)                        按全名取一个 ToolDescriptor，找不到返回 null
//  invoke(invocation)               执行调用，永远返回 ToolResult；不抛异常
//  onChange(listener)               工具列表变更时通知，listener 收到全量新列表
//
//  注意：runWithTools 在每轮 LLM 请求前都要 list() 一次取最新工具集，避免使用过期描述。
// ──────────────────────────────────────────────────────────────────────────

/** ToolRegistry 变更事件 — onChange 回调收到的负载。 */
export const ToolRegistryChangeSchema = z.object({
  /** 触发原因。 */
  reason: z.enum([
    "init", // 启动首次注册
    "source_added", // 新加来源
    "source_removed", // 移除来源
    "source_reconnected", // MCP server 重连后工具列表变了
    "settings_updated", // 用户改了 settings 触发刷新
  ]),
  /** 变更后全量工具列表。 */
  tools: z.array(ToolDescriptorSchema),
  occurred_at: IsoTimestampSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type ToolSourceId = z.infer<typeof ToolSourceIdSchema>;
export type ToolBareName = z.infer<typeof ToolBareNameSchema>;
export type ToolFullName = z.infer<typeof ToolFullNameSchema>;
export type ToolUseId = z.infer<typeof ToolUseIdSchema>;

export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export type ToolUse = z.infer<typeof ToolUseSchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;
export type ToolRegistryChange = z.infer<typeof ToolRegistryChangeSchema>;
