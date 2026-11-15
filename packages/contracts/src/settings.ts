/**
 * settings.ts — knowSelf 应用配置契约
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/settings.ts` 抄录。
 *
 * 工作单元：所有人都依赖
 *   - profile-store     无直接消费（profile/ 路径来自 packages/config）
 *   - provider-adapter  消费 settings.providers
 *   - mcp-host          消费 settings.mcp_servers / builtin_tools / tool_defaults
 *   - context-router    消费 settings.retrieval
 *   - chat-engine       消费 settings.app + settings.conversation
 *   - web-ui            通过 GET /api/settings 取回完整对象（api_key 字段会被 server 屏蔽）
 *
 * 持久化路径：项目根 `settings.json`（不提交，与 settings.example.json 同形）。
 * 由 `packages/config/src/settings.ts` 实现读写，所有跨包消费方走 getSettings()。
 *
 * 弱模型实施提示：
 *   1. 读盘后先 Zod parse；解析失败时不要尝试修复，直接抛 SettingsParseError 让用户改 JSON。
 *   2. 写盘前一律走 Zod parse 校验，避免 UI 把空字符串或 null 写进必填字段。
 *   3. **永远**在 GET /api/settings 的响应里把 api_key 字段替换为掩码（如 "sk-***"），
 *      原值仅在 server 内部消费。
 *   4. settings.schema_version 固定 1；未来字段不兼容变更时自增并在 packages/config 里加 migrator。
 *   5. 本文件大量字段引用其他 contract 文件的 schema；为避免文件循环引用，
 *      此处用宽松占位（z.array(z.record(...))），实施时改成真实 import。
 */

import { z } from "zod";
import { ProviderConfigSchema } from "./provider";
import { McpServerConfigSchema, BuiltinToolConfigSchema, ToolDefaultsSchema } from "./mcp";
import { RetrieverConfigSchema } from "./retrieval";

// ──────────────────────────────────────────────────────────────────────────
//  AppSettings — 顶层
// ──────────────────────────────────────────────────────────────────────────

/**
 * 主题模式。
 *   system    跟随系统
 *   light / dark 强制
 */
export const ThemeModeSchema = z.enum(["system", "light", "dark"]);

/**
 * App 级别配置（与具体业务无关的东西）。
 */
export const AppSectionSchema = z.object({
  /** UI 语言；目前仅 zh-CN，留 en-US 占位 V2。 */
  locale: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
  theme: ThemeModeSchema.default("system"),
  /** 历史兼容配置；当前 dsh Desktop 不使用浏览器启动开关。 */
  open_browser_on_start: z.boolean().default(true),
  /** 历史兼容配置；当前 dsh Desktop 本地服务由宿主配置。 */
  server_port: z.number().int().min(1024).max(65535).default(9527),
  /** 启用的功能开关，方便弱模型一处看全。 */
  feature_flags: z.object({
    /** 自动回写（蒸馏小模型把对话内容写回 profile）。 */
    auto_writeback: z.boolean().default(true),
    /** 系统状态页（/system 路由）。 */
    system_status_page: z.boolean().default(true),
    /** 工具调用气泡内的"完整请求"调试开关。 */
    debug_panel: z.boolean().default(false),
  }),
});

// ──────────────────────────────────────────────────────────────────────────
//  Conversation 配置
// ──────────────────────────────────────────────────────────────────────────

/**
 * 对话相关配置。
 */
export const ConversationSectionSchema = z.object({
  /** 默认主对话 provider id；空字符串时取 providers 中首个 default_for=chat 的。 */
  default_provider_id: z.string().max(64).default(""),
  /** 默认是否启用工具循环。 */
  default_tools_enabled: z.boolean().default(true),
  /** 默认是否触发自动回写。 */
  default_write_back: z.boolean().default(true),
  /** 工具循环每次对话的最大迭代次数（防止无限 tool_use 循环）。 */
  max_tool_iterations: z.number().int().min(1).max(20).default(8),
  /** 历史保留天数；0 表示永不自动删除。 */
  history_retention_days: z.number().int().min(0).max(3650).default(0),
  /** 单会话历史消息上限；超过则把最早的若干条挪进 archive 表。 */
  history_messages_per_conversation: z.number().int().min(20).max(10_000).default(500),
  /** 蒸馏 provider id；空字符串时取 default_for=distill 的。 */
  writeback_provider_id: z.string().max(64).default(""),
});

// ──────────────────────────────────────────────────────────────────────────
//  Storage 配置
// ──────────────────────────────────────────────────────────────────────────

/**
 * 存储路径与备份策略。
 *
 * 字段说明：
 *   profile_dir          相对项目根的档案目录（默认 "profile"）
 *   data_dir             SQLite 与模型缓存目录（默认 "data"）
 *   backup_enabled       是否每日打包备份 profile/
 *   backup_keep_days     保留多少天的备份
 */
export const StorageSectionSchema = z.object({
  profile_dir: z.string().min(1).max(512).default("profile"),
  data_dir: z.string().min(1).max(512).default("data"),
  backup_enabled: z.boolean().default(false),
  backup_keep_days: z.number().int().min(1).max(365).default(30),
});

/**
 * settings.providers — 详见 provider.ts ProviderConfig。
 */
export const ProvidersSectionSchema = z.array(ProviderConfigSchema).max(32);

/**
 * settings.mcp_servers — 详见 mcp.ts McpServerConfig。
 */
export const McpServersSectionSchema = z.array(McpServerConfigSchema).max(16);

/**
 * settings.builtin_tools — 详见 mcp.ts BuiltinToolConfig（V2 启用，MVP 必须留空数组）。
 */
export const BuiltinToolsSectionSchema = z.array(BuiltinToolConfigSchema).max(16);

/**
 * settings.tool_defaults — 详见 mcp.ts ToolDefaults。
 */
export const ToolDefaultsSectionSchema = ToolDefaultsSchema;
export type ToolDefaultsSection = z.infer<typeof ToolDefaultsSectionSchema>;

/**
 * settings.retrieval — 详见 retrieval.ts RetrieverConfig。
 */
export const RetrievalSectionSchema = RetrieverConfigSchema;
export type RetrievalSection = z.infer<typeof RetrievalSectionSchema>;

// ──────────────────────────────────────────────────────────────────────────
//  Automation 配置（DESIGN-16 §10；加法式）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 任务调度窗口（4 类）。
 *   interval  固定间隔（`interval_ms`）
 *   daily     每天 `at_hhmm`
 *   weekly    每周 `weekday` + `at_hhmm`（0=周日）
 *   monthly   每月 `day_of_month` + `at_hhmm`
 */
export const AutomationScheduleSchema = z.object({
  kind: z.enum(["interval", "daily", "weekly", "monthly"]),
  interval_ms: z.number().int().min(60_000).max(604_800_000).default(21_600_000), // 6h
  at_hhmm: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("09:00"),
  weekday: z.number().int().min(0).max(6).default(1), // 周一
  day_of_month: z.number().int().min(1).max(28).default(1),
});

/** 单个任务的配置（`task_id` 定稿 5 值，不得自创）。 */
export const AutomationTaskConfigSchema = z.object({
  task_id: z.enum(["ingest", "tag", "report_weekly", "report_monthly", "mcp_service"]),
  enabled: z.boolean().default(false),
  /** FR-10.5：默认预演。 */
  dry_run: z.boolean().default(true),
  catch_up: z.boolean().default(true),
  max_runtime_ms: z.number().int().min(10_000).max(3_600_000).default(1_800_000),
  schedule: AutomationScheduleSchema,
  options: z
    .object({
      /** DESIGN-14 §3.1：语义 L1 默认关闭。 */
      semantic_l1: z.boolean().default(false),
      /** 复用 DESIGN-12 §3.4 的 `MAX_LLM_CALLS` 成本闸。 */
      max_llm_calls: z.number().int().min(0).max(10_000).default(200),
    })
    .default({}),
});

/** A configured user-exported WeChat directory with a stable source id. */
export const WechatImportConfigSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .max(64),
  source_path: z.string().trim().min(1).max(2048),
  source_id: z.string().trim().min(1).max(256),
  enabled: z.boolean().default(false),
  reader: z.enum(["txt", "json"]).default("txt"),
  only: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
});

const WechatImportConfigsSchema = z
  .array(WechatImportConfigSchema)
  .max(16)
  .superRefine((entries, ctx) => {
    const ids = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: "wechat_imports id must be unique",
        });
      }
      ids.add(entry.id);
    }
  });

/**
 * Desktop WeChat assistance guardrails.
 *
 * This config describes authorization policy only. The actual transport stays
 * in the dsh host adapter so the domain packages never depend on WeChat or
 * Electron APIs.
 */
export const WechatAssistSectionSchema = z.object({
  /** Feature gate; disabled by default. */
  enabled: z.boolean().default(false),
  /** Explicit send gate; drafts remain available when this is false. */
  send_enabled: z.boolean().default(false),
  /** Keep every generated message as a draft until a user sends it explicitly. */
  drafts_only: z.boolean().default(true),
  /** Contact identifiers allowed to receive a sent message. */
  allowlist: z.array(z.string().trim().min(1).max(256)).max(256).default([]),
  /** Maximum successful sends in a rolling hour. */
  max_messages_per_hour: z.number().int().min(1).max(60).default(6),
  /** Minimum delay between successful sends. */
  cooldown_ms: z.number().int().min(0).max(86_400_000).default(300_000),
});

/**
 * settings.automation（DESIGN-16 §8.3/§10）。
 * 默认值原则：`enabled=false` + `dry_run=true` + 每个 `task.enabled=false`
 * → **装上不生效、生效先预演**（FR-10.5）。
 */
export const AutomationSectionSchema = z.object({
  /** 总开关，默认关。 */
  enabled: z.boolean().default(false),
  /** 全局 dry-run，默认开。 */
  dry_run: z.boolean().default(true),
  tick_ms: z.number().int().min(10_000).max(3_600_000).default(60_000),
  tasks: z.array(AutomationTaskConfigSchema).max(16).default([]),
  wechat_imports: WechatImportConfigsSchema.default([]),
  wechat_assist: WechatAssistSectionSchema.default({}),
  /** 空 = 不推送（只落 exports）。 */
  report_push_dir: z.string().max(512).default(""),
  alert_suppress_ms: z.number().int().min(0).max(86_400_000).default(3_600_000),
  notify: z
    .object({
      badge: z.boolean().default(true),
      /** 待决 D16 Q2。 */
      os_notification: z.boolean().default(false),
    })
    .default({}),
});

// ──────────────────────────────────────────────────────────────────────────
//  AppSettings 顶层
// ──────────────────────────────────────────────────────────────────────────

/**
 * 顶层 settings.json 形状。
 *
 * 字段说明（按惯例放最常改的在最前面）：
 *   schema_version   字段不兼容变更时自增；目前固定 1
 *   app              主题 / 语言 / feature flag
 *   conversation     默认 provider / 工具开关 / 历史策略
 *   providers        ProviderConfig[]（provider.ts）
 *   mcp_servers      McpServerConfig[]（mcp.ts）
 *   builtin_tools    BuiltinToolConfig[]（mcp.ts，V2）
 *   tool_defaults    ToolDefaults（mcp.ts）
 *   retrieval        RetrieverConfig（retrieval.ts）
 *   storage          路径与备份
 *
 * `default_for` 一致性约束（schema 不强制，packages/config 在 saveSettings 时校验）：
 *   - 同一 ProviderPurpose 在 providers[] 中至多有一个 default_for 包含该 purpose
 *   - conversation.default_provider_id 若非空，必须能在 providers[] 中找到
 *   - retrieval.rerank_provider_id / classifier_provider_id 同上
 *   - mcp.fetch_fallback_policy.primary_source_id / fallback_source_id 必须能在
 *     mcp_servers[] 中找到对应 id
 */
/**
 * 自动归档（批次 2 / B2-3）。
 *
 * **默认关闭**：先让人看着跑（每条仍进「待整理」），规则与阈值稳了再开。
 * 关闭时判定结果照样入库（`suggested_target`），只是不自动采纳 —— 关掉不等于不判。
 */
export const AutoArchiveSectionSchema = z.object({
  /** 总开关；false 时只记录判定、不自动采纳。 */
  enabled: z.boolean().default(false),
  /** 自动采纳的置信度下限（含）。 */
  min_confidence: z.number().min(0).max(1).default(0.8),
  /** 群聊"人多"阈值：发言人数 > 该值 → chat_only。 */
  group_speaker_threshold: z.number().int().min(2).max(500).default(5),
  /** 单聊"剔噪"阈值：消息数 > 该值才建档（只剔一两句寒暄，不再当主判据）。 */
  direct_message_threshold: z.number().int().min(1).max(100000).default(3),
  /** target=material 且被自动采纳时，是否顺带触发 distill。 */
  auto_distill_material: z.boolean().default(true),
  /** 是否启用 LLM 兜底（规则判不了时才调；关闭则一律进 review）。 */
  use_llm: z.boolean().default(false),
});

export const AppSettingsSchema = z.object({
  schema_version: z.literal(1),
  app: AppSectionSchema,
  conversation: ConversationSectionSchema,
  providers: ProvidersSectionSchema,
  mcp_servers: McpServersSectionSchema,
  builtin_tools: BuiltinToolsSectionSchema.default([]),
  tool_defaults: ToolDefaultsSectionSchema,
  retrieval: RetrievalSectionSchema,
  storage: StorageSectionSchema,
  /** 自动化（DESIGN-16 §10）。**可选**：缺省 = 不启用任何任务。 */
  automation: AutomationSectionSchema.optional(),
  /** 自动归档（批次 2）。**可选**：缺省 = 关闭（只记录判定，不自动采纳）。 */
  auto_archive: AutoArchiveSectionSchema.optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  PartialAppSettings — PATCH /api/settings 入参
//  浅层 partial 即可（顶层段独立，section 内部仍做完整 parse）
// ──────────────────────────────────────────────────────────────────────────

export const PartialAppSettingsSchema = z.object({
  app: AppSectionSchema.partial().optional(),
  conversation: ConversationSectionSchema.partial().optional(),
  providers: ProvidersSectionSchema.optional(),
  mcp_servers: McpServersSectionSchema.optional(),
  builtin_tools: BuiltinToolsSectionSchema.optional(),
  tool_defaults: ToolDefaultsSectionSchema.optional(),
  retrieval: RetrievalSectionSchema.optional(),
  storage: StorageSectionSchema.partial().optional(),
  /** 自动化（DESIGN-16 §10）；PATCH 可只传要改的键（缺省键保持原值，不注入默认）。 */
  automation: AutomationSectionSchema.partial().optional(),
  /** 自动归档（批次 2）；同样支持只传要改的键。 */
  auto_archive: AutoArchiveSectionSchema.partial().optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  Masked 输出 — GET /api/settings 给 web-ui 的形状
//  api_key 字段必须被 server 替换为掩码字符串
// ──────────────────────────────────────────────────────────────────────────

/**
 * 返回给 web-ui 的 settings 仍走 AppSettingsSchema 形状校验，
 * 但 server 在序列化前要把以下字段替换为 "***":
 *   - providers[].api_key
 *   - mcp_servers[].transport_config.env.* 中名字含 KEY/TOKEN/SECRET 的值
 *   - mcp_servers[].transport_config.auth_token / headers 中疑似敏感值
 *   - builtin_tools[].api_key
 *
 * 实现细节由 chat-engine `routes/settings.ts` 完成；本契约不引入"masked"专门 schema。
 * 弱模型实施时把"屏蔽规则"写成一个纯函数 `maskSettings(s) → s`，
 * 单元测试覆盖每条字段。
 */

// ──────────────────────────────────────────────────────────────────────────
//  错误码
// ──────────────────────────────────────────────────────────────────────────

export const SettingsErrorCodeSchema = z.enum([
  "PARSE_FAILED", // settings.json 不是合法 JSON
  "VALIDATION", // Zod 校验失败
  "WRITE_FAILED", // 原子写盘失败
  "REFERENCE_INVALID", // default_provider_id 等引用关系失败
  "VERSION_MISMATCH", // schema_version 与代码不兼容（需要 migrator）
]);

export const SettingsErrorPayloadSchema = z.object({
  code: SettingsErrorCodeSchema,
  message: z.string().min(1).max(512),
  /** 失败字段路径（"providers[2].api_key" 等）。 */
  path: z.string().max(256).optional(),
  trace_id: z.string().min(8).max(64).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type ThemeMode = z.infer<typeof ThemeModeSchema>;
export type AppSection = z.infer<typeof AppSectionSchema>;
export type ConversationSection = z.infer<typeof ConversationSectionSchema>;
export type StorageSection = z.infer<typeof StorageSectionSchema>;
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;
export type AutomationTaskConfig = z.infer<typeof AutomationTaskConfigSchema>;
export type WechatImportConfig = z.infer<typeof WechatImportConfigSchema>;
export type WechatAssistSection = z.infer<typeof WechatAssistSectionSchema>;
export type AutomationSection = z.infer<typeof AutomationSectionSchema>;
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type PartialAppSettings = z.infer<typeof PartialAppSettingsSchema>;
export type SettingsErrorCode = z.infer<typeof SettingsErrorCodeSchema>;
export type SettingsErrorPayload = z.infer<typeof SettingsErrorPayloadSchema>;
