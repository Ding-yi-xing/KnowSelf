/**
 * system.ts — knowSelf 系统状态契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/system.ts` 抄录。
 *
 * 工作单元：chat-engine 出口 / web-ui 入口
 * 关联模块：
 *   - chat-engine routes/system.ts 实现 GET /api/system/status，输出本契约形状
 *   - web-ui useSystemStore 消费本契约
 *
 * 设计取舍（DESIGN-09 §3.5 决议）：
 *   SystemStatusResponse 不属于任何单一 packages 内部域，独立成 contracts/system.ts。
 *   它聚合 ProviderHealth / McpHostSnapshot 等其他 contracts 的形状作为字段类型。
 *
 * 弱模型实施提示：
 *   1. 本文件只描述出参形状；入参（POST /system/healthcheck）已在 provider.ts 定义。
 *   2. SystemStatusResponse.uptime_seconds 来自 server 启动时记录的 boot_at。
 *   3. ready 中各 packages 状态由 chat-engine readinessSnapshot() 计算。
 */

import { z } from "zod";
import { ProviderHealthSchema } from "./provider";
import { McpHostSnapshotSchema } from "./mcp";
import { ProposalStatusSchema, SourceStatusSchema } from "./source";

// ──────────────────────────────────────────────────────────────────────────
//  ready 子段
// ──────────────────────────────────────────────────────────────────────────

export const ReadinessSchema = z.object({
  profile_store: z.boolean(),
  context_router: z.boolean(),
  provider_adapter: z.boolean(),
  mcp_host: z.boolean(),
  ingestion: z.boolean(),
  /** 任一 false 时 overall=false。 */
  overall: z.boolean(),
});

/** ProviderHealth 数组（详见 provider.ts）。 */
export const ProvidersHealthListSchema = z.array(ProviderHealthSchema).max(32);

/** McpHostSnapshot（详见 mcp.ts）。 */
export { McpHostSnapshotSchema };

export const RetrieverStatusSchema = z.object({
  embedding_model_loaded: z.boolean(),
  chunk_count: z.number().int().min(0).max(1_000_000),
  last_full_index_at: z.string().datetime({ offset: true }).nullable(),
  last_incremental_at: z.string().datetime({ offset: true }).nullable(),
  degraded_to_fts5_only: z.boolean(),
});

export const ConversationsStatusSchema = z.object({
  total: z.number().int().min(0).max(1_000_000),
  latest_at: z.string().datetime({ offset: true }).nullable(),
});

export const IngestionStatusSchema = z.object({
  /** 当前 pending 的 proposal 数（UI 角标用）。 */
  pending_proposal_count: z.number().int().min(0).max(100_000),
  /** 当前 source 总数。 */
  source_count: z.number().int().min(0).max(100_000),
  /** 最近一次蒸馏时间。 */
  last_distill_at: z.string().datetime({ offset: true }).nullable(),
  /** 蒸馏 provider 是否就绪（providers 列表里能找到且 healthy）。 */
  distill_provider_ready: z.boolean(),
  source_status_counts: z.record(SourceStatusSchema, z.number().int().min(0).max(100_000)),
  proposal_status_counts: z.record(ProposalStatusSchema, z.number().int().min(0).max(100_000)),
});

export const EnvironmentStatusSchema = z.object({
  node_version: z.string().min(1).max(64),
  node_required: z.string().min(1).max(64),
  node_ok: z.boolean(),
  platform: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  sqlite_available: z.boolean(),
});

// ──────────────────────────────────────────────────────────────────────────
//  顶层
// ──────────────────────────────────────────────────────────────────────────

export const SystemStatusResponseSchema = z.object({
  ready: ReadinessSchema,
  providers: ProvidersHealthListSchema,
  mcp: McpHostSnapshotSchema,
  retriever: RetrieverStatusSchema,
  conversations: ConversationsStatusSchema,
  ingestion: IngestionStatusSchema,
  environment: EnvironmentStatusSchema,
  uptime_seconds: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
  schema_version: z.literal(1),
  /** 当前 server 的版本号（package.json 读出，便于 UI 显示）。 */
  app_version: z.string().min(1).max(32),
  collected_at: z.string().datetime({ offset: true }),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type Readiness = z.infer<typeof ReadinessSchema>;
export type RetrieverStatus = z.infer<typeof RetrieverStatusSchema>;
export type ConversationsStatus = z.infer<typeof ConversationsStatusSchema>;
export type IngestionStatus = z.infer<typeof IngestionStatusSchema>;
export type EnvironmentStatus = z.infer<typeof EnvironmentStatusSchema>;
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;

