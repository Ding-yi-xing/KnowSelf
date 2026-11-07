/**
 * export-api.ts — `exportMining`（DESIGN-12 §8.5-R4 的导出接口）
 *
 * 职责：把注入 store 里的存量数据组装成 `ExportInput`，交 `Exporter.build`（§7.1 三形态 /
 * §7.2 信封）产出文件集，按 `format` 过滤后经 `Exporter.write` 落盘到 §7.4 约定目录。
 *
 * ── 与设计的对齐与缺口（均已登记 `docs/units/mining/status.md`）──
 * - `export_kind`：§7.2 定稿五值（`weekly` / `monthly` / `person` / `graph` / `ranking`）；
 *   §8.5 **未给默认值** → 本函数**要求必填**（不替设计猜默认）
 * - `format`：§8.5 只登记参数名、**全文未定义取值** → 取 §7.1 三形态自身的词汇
 *   （`report` / `json` / `markdown`）+ `all`（默认；`Exporter.build` 本就一次产出全部）
 * - `scope` / `range`：分别映射 §7.2 信封的 `scope` 与 `data_range`；缺省 `{global,''}`
 *   与 `{from:null,to:null}`
 * - `quality`：§7.3 第 6 节要求「未解析发送者数 / 已回滚批次数 / 降级会话数」，但前两者
 *   **当前无 store 能力面** → 只接线 `degraded_sessions`（来自快照 stats），其余**回告警**
 *   `EXPORT_QUALITY_PARTIAL`，不静默留空
 * - 落盘：§7.4 `data/mining/exports/<ISO 时间戳>/`；时间戳做 Windows 路径净化（`:` 非法）
 *
 * 只读语义：除 `write`（默认 true，§8.5 明确「导出写文件除外」）外不写库；`now` 可注入以保确定性。
 */
import { join } from "node:path";
import type { ScopeKind } from "@knowself/contracts";
import type { ChatConversationRow, MetricRow, PersonRow } from "@knowself/person-store";
import {
  EXPORT_ROOT,
  Exporter,
  type ExportArtifacts,
  type ExportEnvelope,
  type ExportGroupRef,
  type ExportInput,
  type ExportKind,
  type ExportMetricRow,
  type ExportPersonRef,
  type ExportQuality,
} from "./exporter";
import { getGraphSnapshot, type MiningReadStore } from "./read";
import { SCORE_FEATURES, type FeatureBreakdown, type ScoredPerson, type ScoreFeature } from "./value-scorer";

// ── 常量 ────────────────────────────────────────────────────────────────────

/** §7.1 的三种形态 + `all`（默认）。`format` 的取值设计未定稿 → 取 §7.1 自身词汇。 */
export const EXPORT_FORMATS = ["report", "json", "markdown", "all"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const DEFAULT_EXPORT_FORMAT: ExportFormat = "all";

/** §7.1 的产物文件名（`Exporter` 同源）。 */
export const REPORT_FILE = "report.md";
export const JSON_FILE = "data.json";

export const WARN_EXPORT_QUALITY_PARTIAL = "EXPORT_QUALITY_PARTIAL";
export const WARN_EXPORT_RANKING_BREAKDOWN_MISSING = "EXPORT_RANKING_BREAKDOWN_MISSING";

/** §6.4 的第三键（解释行）。 */
const VALUE_BREAKDOWN_KEY = "value_score_breakdown";

// ── store 注入面 ─────────────────────────────────────────────────────────────

/** 导出需要的 person-store 能力面（读层 + 会话列表 + 消息计数）。 */
export interface MiningExportStore extends MiningReadStore {
  conversations: {
    list(q?: { kind?: ChatConversationRow["kind"] }): ChatConversationRow[];
  };
  messages: {
    count(q?: { from_ms?: number; to_ms?: number }): number;
  };
}

// ── 查询 / 结果 ─────────────────────────────────────────────────────────────

export interface ExportMiningQuery {
  /** §7.2 五值；§8.5 未给默认 → 必填。 */
  readonly export_kind: ExportKind;
  /** 默认 {@link DEFAULT_EXPORT_FORMAT}。 */
  readonly format?: ExportFormat;
  /** 缺省 `{ scope_kind: 'global', scope_id: '' }`。 */
  readonly scope?: { readonly scope_kind: ScopeKind; readonly scope_id: string };
  /** 缺省 `{ from: null, to: null }`（不限）。 */
  readonly range?: { readonly from: string | null; readonly to: string | null };
  /** 是否落盘（默认 `true`；§8.5 明确导出写文件）。 */
  readonly write?: boolean;
  /** 落盘目录；缺省按 §7.4 生成 `data/mining/exports/<时间戳>`。 */
  readonly outDir?: string;
  /** 注入「现在」（`generated_at` 与目录时间戳）以保确定性；缺省取系统时间。 */
  readonly now?: string;
  /** 覆盖 `produced_by`；缺省 `mining:export-v1`。 */
  readonly producedBy?: string;
  /** 外部追加告警（与内部告警合并）。 */
  readonly warnings?: readonly string[];
}

export interface ExportFileRef {
  /** 相对导出根目录的路径。 */
  readonly path: string;
  /** UTF-8 字节数。 */
  readonly bytes: number;
}

export interface ExportMiningResult {
  readonly envelope: ExportEnvelope;
  readonly warnings: readonly string[];
  readonly files: readonly ExportFileRef[];
  /** 实际落盘的相对路径（`write:false` 时为空）。 */
  readonly written: readonly string[];
  readonly outDir: string | null;
}

// ── 主函数 ──────────────────────────────────────────────────────────────────

export function exportMining(store: MiningExportStore, q: ExportMiningQuery): ExportMiningResult {
  const now = q.now ?? new Date().toISOString();
  const format = q.format ?? DEFAULT_EXPORT_FORMAT;
  const scope: { scope_kind: ScopeKind; scope_id: string } = q.scope ?? {
    scope_kind: "global",
    scope_id: "",
  };
  const dataRange = q.range ?? { from: null, to: null };
  const warnings: string[] = [...(q.warnings ?? [])];

  const persons = store.listPersons();
  const displayNames = new Map(persons.map((person) => [person.person_id, person.display_name]));
  const conversations = store.conversations.list();

  // 图谱：§7.2 规定只有 export_kind='graph' 时进信封；但 quality 的 degraded_sessions 始终取自快照
  const snapshot = getGraphSnapshot(store, {
    scope_kind: scope.scope_kind,
    scope_id: scope.scope_id,
  });
  const graph = snapshot === null ? null : snapshot.snapshot;

  const metrics = sortMetrics(
    store.metrics.list({ scope_kind: scope.scope_kind, scope_id: scope.scope_id }),
  );
  const { ranking, missingBreakdown } = assembleRanking(metrics);
  if (missingBreakdown > 0) {
    warnings.push(WARN_EXPORT_RANKING_BREAKDOWN_MISSING);
  }

  // §7.3 第 6 节的三项里，未解析发送者数 / 已回滚批次数当前无 store 能力面 → 回告警，不静默留空
  warnings.push(WARN_EXPORT_QUALITY_PARTIAL);
  const quality: ExportQuality =
    graph === null ? {} : { degraded_sessions: graph.stats.degraded_sessions };

  const input: ExportInput = {
    exportKind: q.export_kind,
    generatedAt: now,
    ...(q.producedBy === undefined ? {} : { producedBy: q.producedBy }),
    dataRange,
    scope,
    counts: {
      messages: store.messages.count(rangeToMs(dataRange)),
      persons: persons.length,
      conversations: conversations.length,
    },
    warnings,
    persons: persons.map(toPersonRef),
    groups: conversations.filter((row) => row.kind === "group").map(toGroupRef),
    metrics: metrics.map((row) => toExportMetricRow(row, displayNames)),
    ranking,
    graph: q.export_kind === "graph" ? graph : null,
    quality,
  };

  const built = Exporter.build(input);
  const artifacts = filterArtifacts(built, format);

  const shouldWrite = q.write ?? true;
  const outDir = shouldWrite ? (q.outDir ?? join(EXPORT_ROOT, timestampDir(now))) : null;
  const written = outDir === null ? [] : Exporter.write(outDir, artifacts);

  const files: ExportFileRef[] = [...artifacts.files]
    .map(([path, content]) => ({ path, bytes: Buffer.byteLength(content, "utf8") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { envelope: built.envelope, warnings: built.warnings, files, written, outDir };
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** §7.1：`format` 选中的形态（`all` 不过滤）。 */
function matchesFormat(path: string, format: ExportFormat): boolean {
  if (format === "all") {
    return true;
  }
  if (format === "report") {
    return path === REPORT_FILE;
  }
  if (format === "json") {
    return path === JSON_FILE;
  }
  // markdown 快照（§7.1 第三形态）：`index.md` + `persons/*` + `groups/*` + `graph/*`
  return path !== REPORT_FILE && path !== JSON_FILE;
}

function filterArtifacts(artifacts: ExportArtifacts, format: ExportFormat): ExportArtifacts {
  if (format === "all") {
    return artifacts;
  }
  const files = new Map([...artifacts.files].filter(([path]) => matchesFormat(path, format)));
  return { ...artifacts, files };
}

/** §7.4 目录名净化：`:` 在 Windows 路径非法。 */
function timestampDir(now: string): string {
  return now.replace(/[:.]/g, "-");
}

/** `range` 的 `'YYYY-MM-DD'` → 消息计数用的毫秒区间（UTC 零点起，与 pipeline 同口径）。 */
function rangeToMs(range: { readonly from: string | null; readonly to: string | null }): {
  from_ms?: number;
  to_ms?: number;
} {
  const out: { from_ms?: number; to_ms?: number } = {};
  if (range.from !== null) {
    const ms = Date.parse(`${range.from}T00:00:00Z`);
    if (!Number.isNaN(ms)) {
      out.from_ms = ms;
    }
  }
  if (range.to !== null) {
    const ms = Date.parse(`${range.to}T00:00:00Z`);
    if (!Number.isNaN(ms)) {
      out.to_ms = ms;
    }
  }
  return out;
}

/** 指标行排序：store 未保证顺序，排序后导出产物才可逐字节复现（不变量 #6）。 */
function sortMetrics(rows: readonly MetricRow[]): MetricRow[] {
  return [...rows].sort((a, b) => {
    const left = `${a.person_id} ${a.scope_kind} ${a.scope_id} ${a.period} ${a.period_key} ${a.metric_key}`;
    const right = `${b.person_id} ${b.scope_kind} ${b.scope_id} ${b.period} ${b.period_key} ${b.metric_key}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function toPersonRef(person: PersonRow): ExportPersonRef {
  return { person_id: person.person_id, display_name: person.display_name };
}

/** §7.1 要求 2：不以内部 id 作唯一标识 → 群用 `title` 作显示名。 */
function toGroupRef(conversation: ChatConversationRow): ExportGroupRef {
  return { conversation_id: conversation.conversation_id, display_name: conversation.title };
}

function toExportMetricRow(row: MetricRow, displayNames: Map<string, string>): ExportMetricRow {
  return {
    person_id: row.person_id,
    display_name: displayNames.get(row.person_id) ?? row.person_id,
    metric_key: row.metric_key,
    metric_value: row.metric_value,
    metric_value_json: row.metric_value_json,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    period: row.period,
    period_key: row.period_key,
  };
}

/**
 * §6.4 的价值三键 → `ScoredPerson[]`。
 * 缺 `value_score` 或 `value_rank` 者不进榜（与 `getRanking` 同口径）；
 * 缺 / 坏 `value_score_breakdown` 者跳过并计入 `missingBreakdown`（回告警，不静默）。
 */
function assembleRanking(metrics: readonly MetricRow[]): {
  ranking: ScoredPerson[];
  missingBreakdown: number;
} {
  const byPerson = new Map<string, { score?: MetricRow; rank?: MetricRow; breakdown?: MetricRow }>();
  for (const row of metrics) {
    if (
      row.metric_key !== "value_score" &&
      row.metric_key !== "value_rank" &&
      row.metric_key !== VALUE_BREAKDOWN_KEY
    ) {
      continue;
    }
    const entry = byPerson.get(row.person_id) ?? {};
    if (row.metric_key === "value_score") {
      entry.score = row;
    } else if (row.metric_key === "value_rank") {
      entry.rank = row;
    } else {
      entry.breakdown = row;
    }
    byPerson.set(row.person_id, entry);
  }

  const ranking: ScoredPerson[] = [];
  let missingBreakdown = 0;
  for (const [personId, entry] of byPerson) {
    if (entry.score === undefined || entry.rank === undefined) {
      continue;
    }
    const breakdown = parseBreakdown(entry.breakdown);
    if (breakdown === null) {
      missingBreakdown += 1;
      continue;
    }
    ranking.push({
      person_id: personId,
      value_score: entry.score.metric_value ?? 0,
      value_rank: entry.rank.metric_value ?? 0,
      breakdown,
    });
  }

  // 确定性：rank 升序，并列按 person_id 字典序（与 getRanking 同口径）
  ranking.sort(
    (a, b) =>
      a.value_rank - b.value_rank ||
      (a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0),
  );
  return { ranking, missingBreakdown };
}

/** 解析 §6.3 的 `value_score_breakdown.metric_value_json`；8 个特征缺一或字段类型不符即视为无效。 */
function parseBreakdown(row: MetricRow | undefined): Record<ScoreFeature, FeatureBreakdown> | null {
  if (row === undefined || row.metric_value_json === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metric_value_json);
  } catch {
    return null; // 解析失败由调用方计入 missingBreakdown 告警，不静默丢弃
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const source = parsed as Record<string, unknown>;
  const out = {} as Record<ScoreFeature, FeatureBreakdown>;
  for (const key of SCORE_FEATURES) {
    const item = source[key];
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const entry = item as Record<string, unknown>;
    const norm = entry["norm"];
    const weight = entry["weight"];
    const contrib = entry["contrib"];
    if (typeof norm !== "number" || typeof weight !== "number" || typeof contrib !== "number") {
      return null;
    }
    const raw = entry["raw"];
    out[key] = { raw: typeof raw === "number" ? raw : null, norm, weight, contrib };
  }
  return out;
}
