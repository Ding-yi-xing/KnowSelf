/**
 * profile.ts — knowSelf 档案存储层契约（SQLite 主存版）
 *
 * 定位：纯文档形态的 Zod schema 单一真相源。本文件**不是** npm 包源码。
 * 阶段 3 实施时由 `packages/contracts/src/profile.ts` 抄录。
 *
 * 工作单元：profile-store
 * 关联模块：
 *   - context-router  订阅 ProfileChangeEvent 增量重建索引
 *   - chat-engine     UI CRUD 路由 + 自动回写经 ingestion 提议
 *   - ingestion       proposals 落档时调本契约的 WriteRequest 入口
 *
 * 重要变更（DESIGN-09 §3 决议后回炉）：
 *   - 档案存储从"profile/ 目录 + markdown frontmatter"切到 "data/profile.sqlite + 5 张表"
 *   - 不再有 frontmatter 概念；落盘形状以 SQLite 行为准
 *   - 自动回写不再直接落档，统一走 ingestion proposal 审阅管线（详见 source.ts）
 *   - WriteRequest.target=core 与 target=card 仍允许（UI 编辑器调）
 *   - 用户"掌控数据"通过：UI 编辑 + 多种导出（.db / markdown 快照 / JSON）保证
 *
 * 三层档案：
 *   L1 CoreProfile  — `core_profile` 表（单行；id 永远为 1）
 *   L2 Card         — `cards` 表（每 key 一行）+ `card_sections` 表（每 section 一行）
 *   L3 JournalEntry — `journal_records` 表（每 record 一行）
 *
 * Stored vs Input：
 *   - `XxxStored`  从 store 读出的形状，含 store 自动维护的派生字段
 *   - `XxxInput`   写入入参，调用方提供业务字段；store 内部补 timestamps / id
 *
 * 弱模型实施提示：
 *   1. 所有写入必须包在事务里；多表写（如 saveCard 改 cards + card_sections）必须原子。
 *   2. 不再有"原子写文件"概念；SQLite 自带 ACID。
 *   3. WAL 模式 + better-sqlite3 同步 API；不要 wrap promise。
 *   4. ProfileChangeEvent 在 commit 之后 emit；commit 失败不 emit。
 *   5. 自动回写代码**不允许**直接调 WriteRequest；必须走 ingestion.createProposal。
 *      只有 UI 编辑器（provenance="user"）和 ingestion.acceptProposal 可调本契约写入。
 */

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
//  公共原子
// ──────────────────────────────────────────────────────────────────────────

export const IsoTimestampSchema = z.string().datetime({ offset: true });

/** Card 稳定 key — 等同文件名时代的 cardKey 约束。 */
export const CardKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "cardKey 必须以小写字母/数字开头，且只含 a-z 0-9 _ -");

/** 日记日期：YYYY-MM-DD。 */
export const JournalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "journal date 必须是 YYYY-MM-DD");

/**
 * 来源标签 — 写入档案时必带的审计字段。
 *   user        UI 编辑器手动写
 *   assistant   ingestion proposal 接受落档（包括对话自动蒸馏与上传资料蒸馏）
 *   import      未来"批量导入"功能（V2）
 *   migration   schema 升级时迁移生成
 */
export const ProvenanceSchema = z.enum(["user", "assistant", "import", "migration"]);

// ──────────────────────────────────────────────────────────────────────────
//  L1：CoreProfile — Stored / Input
// ──────────────────────────────────────────────────────────────────────────

/**
 * core_profile 表落库形状。
 * 表结构永远只有 1 行（id=1）；store 内部强制单例。
 */
export const CoreProfileStoredSchema = z.object({
  /** UI 显示用人类可读名。 */
  display_name: z.string().min(1).max(64),
  /** 语言；默认 zh-CN。 */
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  /** 文件级语义标签。 */
  section_tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  /** 叙述式画像正文。 */
  body: z.string().max(8000, "core body 不应超过 8000 字符（≈ 2k token）"),
  /** 最近一次写入时间。 */
  updated_at: IsoTimestampSchema,
  /** 数据 schema 版本。 */
  schema_version: z.literal(1),
});

/**
 * 写入入参（saveCore 用）。仅 UI 编辑器调；自动回写禁止整体覆盖。
 */
export const CoreProfileInputSchema = z.object({
  body: z.string().max(8000),
  display_name: z.string().min(1).max(64).optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
  section_tags: z.array(z.string().min(1).max(32)).max(16).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  L2：Card — Stored / Input
// ──────────────────────────────────────────────────────────────────────────

/**
 * card_sections 表一行。
 *
 * 字段说明：
 *   id          自增 INTEGER，主键
 *   card_key    所属 cards.key
 *   title       小节标题
 *   body        小节正文
 *   ord         显示顺序，store 维护
 *   updated_at  最近一次写入时间
 */
export const CardSectionStoredSchema = z.object({
  id: z.number().int().min(1),
  card_key: CardKeySchema,
  title: z.string().min(1).max(80),
  body: z.string().max(4000),
  ord: z.number().int().min(0).max(31),
  updated_at: IsoTimestampSchema,
});

/** 写入入参版本：id / card_key / ord / updated_at 由 store 维护。 */
export const CardSectionInputSchema = CardSectionStoredSchema.omit({
  id: true,
  card_key: true,
  ord: true,
  updated_at: true,
});

/**
 * cards 表一行（不含 sections，sections 单表）。
 */
export const CardStoredSchema = z.object({
  key: CardKeySchema,
  title: z.string().min(1).max(64),
  summary: z.string().min(1).max(280),
  section_tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  updated_at: IsoTimestampSchema,
  schema_version: z.literal(1),
});

/** 读出含 sections 的聚合形状（getCard 返回）。 */
export const CardWithSectionsSchema = z.object({
  card: CardStoredSchema,
  sections: z.array(CardSectionStoredSchema).max(32),
});

/** 写入整张卡的入参（saveCard 用）。 */
export const CardInputSchema = z.object({
  key: CardKeySchema,
  title: z.string().min(1).max(64),
  summary: z.string().min(1).max(280),
  section_tags: z.array(z.string().min(1).max(32)).max(16).optional(),
  sections: z.array(CardSectionInputSchema).max(32),
});

// ──────────────────────────────────────────────────────────────────────────
//  L3：JournalEntry — Stored / Input
// ──────────────────────────────────────────────────────────────────────────

/**
 * journal_records 表一行。
 *
 * 字段说明：
 *   id            自增 INTEGER，主键
 *   date          YYYY-MM-DD
 *   ordinal       同一 date 内的次序号（store 维护，max+1）
 *   recorded_at   记录时刻
 *   provenance    来源
 *   tags          语义标签
 *   body          正文
 */
export const JournalRecordStoredSchema = z.object({
  id: z.number().int().min(1),
  date: JournalDateSchema,
  ordinal: z.number().int().min(1).max(9999),
  recorded_at: IsoTimestampSchema,
  provenance: ProvenanceSchema,
  tags: z.array(z.string().min(1).max(32)).max(8).default([]),
  body: z.string().min(1).max(4000),
});

/** 单日聚合形状（getJournal 返回）。 */
export const JournalEntryStoredSchema = z.object({
  date: JournalDateSchema,
  records: z.array(JournalRecordStoredSchema).max(64),
});

// ──────────────────────────────────────────────────────────────────────────
//  写入与变更：WriteRequest / ProfileChangeEvent
//
//  WriteRequest 是统一写入入口，按 target 字段路由：
//    - core          覆盖 L1 整体          （UI 编辑器；ingestion 接受 core proposal）
//    - card          覆盖 L2 整张卡        （仅 UI 编辑器）
//    - card_section  追加 L2 某卡某 section（UI 编辑器；ingestion 接受 proposal）
//    - journal       追加 L3 一条 record   （UI 编辑器；ingestion 接受 proposal）
// ──────────────────────────────────────────────────────────────────────────

export const WriteCoreSchema = CoreProfileInputSchema.extend({
  target: z.literal("core"),
  provenance: ProvenanceSchema,
});

export const WriteCardSchema = CardInputSchema.extend({
  target: z.literal("card"),
  provenance: ProvenanceSchema,
});

export const AppendCardSectionSchema = z.object({
  target: z.literal("card_section"),
  key: CardKeySchema,
  section: z.string().min(1).max(80),
  body: z.string().min(1).max(4000),
  provenance: ProvenanceSchema,
});

export const AppendJournalSchema = z.object({
  target: z.literal("journal"),
  date: JournalDateSchema,
  body: z.string().min(1).max(4000),
  tags: z.array(z.string().min(1).max(32)).max(8).default([]),
  provenance: ProvenanceSchema,
});

export const WriteRequestSchema = z.discriminatedUnion("target", [
  WriteCoreSchema,
  WriteCardSchema,
  AppendCardSectionSchema,
  AppendJournalSchema,
]);

/**
 * 变更事件 — 写入 commit 后 emit 给订阅方（主要是 retriever 增量重建索引）。
 *
 * 字段说明：
 *   kind      add / update / delete
 *   ref_kind  core / card / card_section / journal_record
 *   ref_id    ref_kind 对应的稳定 ID（"core_main" / "card_work" /
 *             "card_section:42" / "journal_record:128"）；与 source.ts ProfileSourceLink.profile_id 形态一致
 *   occurred_at
 *   provenance 触发来源
 */
export const ProfileChangeKindSchema = z.enum(["add", "update", "delete"]);
export const ProfileRefKindSchema = z.enum(["core", "card", "card_section", "journal_record"]);

export const ProfileChangeEventSchema = z.object({
  kind: ProfileChangeKindSchema,
  ref_kind: ProfileRefKindSchema,
  ref_id: z.string().min(1).max(128),
  occurred_at: IsoTimestampSchema,
  provenance: ProvenanceSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  Store 公开 API 派生 schema（list / get 返回项）
// ──────────────────────────────────────────────────────────────────────────

export const CardSummarySchema = CardStoredSchema.pick({
  key: true,
  title: true,
  summary: true,
  section_tags: true,
  updated_at: true,
});

export const JournalDateSummarySchema = z.object({
  date: JournalDateSchema,
  record_count: z.number().int().min(0).max(9999),
  updated_at: IsoTimestampSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  导出 / 备份（DESIGN-09 §3.A 决议：SQLite 主存 + 三种导出）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 导出格式。
 *   sqlite     完整 .zip（profile.sqlite + sources/ 整目录）
 *   markdown   markdown 快照（按 L1/L2/L3 dump 成 .md，供其他工具读）
 *   json       结构化 JSON（接其他自研工具）
 */
export const ExportFormatSchema = z.enum(["sqlite", "markdown", "json", "zip-stream"]);

export const ExportRequestSchema = z.object({
  format: ExportFormatSchema,
  /** 是否包含 sources（原始字节文件），仅 sqlite/zip 路径有效。 */
  include_sources: z.boolean().default(true),
});

export const ExportResponseSchema = z.object({
  /** 服务端临时文件路径（前端走 GET 拉），相对 data/exports/。 */
  download_path: z.string().min(1).max(256),
  format: ExportFormatSchema,
  size_bytes: z
    .number()
    .int()
    .min(0)
    .max(2 ** 53 - 1),
  generated_at: IsoTimestampSchema,
});

// ──────────────────────────────────────────────────────────────────────────
//  V2-06：导入 / 备份
// ──────────────────────────────────────────────────────────────────────────

export const ImportModeSchema = z.enum(["replace", "merge", "dry-run"]);
export const ImportRequestSchema = z.object({
  file_path: z.string().min(1).max(512),
  mode: ImportModeSchema,
});
export const ImportResponseSchema = z.object({
  mode: ImportModeSchema,
  imported: z.object({
    tables: z.record(z.string(), z.number().int()),
    sources: z.number().int(),
  }),
  conflicts: z.array(
    z.object({
      table: z.string(),
      key: z.string(),
      local: z.string(),
      remote: z.string(),
      resolution: z.enum(["local_wins", "remote_wins", "skipped"]),
    }),
  ),
});
export const BackupScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  interval: z.enum(["daily", "weekly"]),
  keep: z.number().int().min(1).max(30).default(7),
});

// ──────────────────────────────────────────────────────────────────────────
//  错误码
// ──────────────────────────────────────────────────────────────────────────

/**
 * profile-store 抛出的错误码白名单。
 * chat-engine 错误中间件按此 code 映射 HTTP 状态：
 *   PROFILE_NOT_FOUND       → 404
 *   DB_BUSY                 → 503  （SQLite SQLITE_BUSY，重试）
 *   DB_CORRUPT              → 500
 *   CONSTRAINT_VIOLATION    → 422  （UNIQUE / CHECK 失败）
 *   INVALID_TARGET_REF      → 400  （cardKey / date 越界）
 *   AUTOWRITE_REJECTED      → 403  （provenance=assistant 直接调写入；必须走 ingestion）
 */
export const ProfileErrorCodeSchema = z.enum([
  "PROFILE_NOT_FOUND",
  "DB_BUSY",
  "DB_CORRUPT",
  "CONSTRAINT_VIOLATION",
  "INVALID_TARGET_REF",
  "AUTOWRITE_REJECTED",
]);

export const ProfileErrorPayloadSchema = z.object({
  code: ProfileErrorCodeSchema,
  message: z.string().min(1).max(512),
  ref_kind: ProfileRefKindSchema.optional(),
  ref_id: z.string().max(128).optional(),
  trace_id: z.string().min(8).max(64).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
//  TS 类型导出
// ──────────────────────────────────────────────────────────────────────────

export type CardKey = z.infer<typeof CardKeySchema>;
export type JournalDate = z.infer<typeof JournalDateSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;

export type CoreProfileStored = z.infer<typeof CoreProfileStoredSchema>;
export type CoreProfileInput = z.infer<typeof CoreProfileInputSchema>;

export type CardStored = z.infer<typeof CardStoredSchema>;
export type CardInput = z.infer<typeof CardInputSchema>;
export type CardSectionStored = z.infer<typeof CardSectionStoredSchema>;
export type CardSectionInput = z.infer<typeof CardSectionInputSchema>;
export type CardWithSections = z.infer<typeof CardWithSectionsSchema>;
export type CardSummary = z.infer<typeof CardSummarySchema>;

export type JournalRecordStored = z.infer<typeof JournalRecordStoredSchema>;
export type JournalEntryStored = z.infer<typeof JournalEntryStoredSchema>;
export type JournalDateSummary = z.infer<typeof JournalDateSummarySchema>;

export type WriteRequest = z.infer<typeof WriteRequestSchema>;
export type WriteCore = z.infer<typeof WriteCoreSchema>;
export type WriteCard = z.infer<typeof WriteCardSchema>;
export type AppendCardSection = z.infer<typeof AppendCardSectionSchema>;
export type AppendJournal = z.infer<typeof AppendJournalSchema>;

export type ProfileChangeEvent = z.infer<typeof ProfileChangeEventSchema>;
export type ProfileChangeKind = z.infer<typeof ProfileChangeKindSchema>;
export type ProfileRefKind = z.infer<typeof ProfileRefKindSchema>;

export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
export type ExportResponse = z.infer<typeof ExportResponseSchema>;

export type ImportMode = z.infer<typeof ImportModeSchema>;
export type ImportRequest = z.infer<typeof ImportRequestSchema>;
export type ImportResponse = z.infer<typeof ImportResponseSchema>;
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;

export type ProfileErrorCode = z.infer<typeof ProfileErrorCodeSchema>;
export type ProfileErrorPayload = z.infer<typeof ProfileErrorPayloadSchema>;
