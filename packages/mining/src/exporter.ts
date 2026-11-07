/**
 * `Exporter`（DESIGN-12 §7）：三种导出形态 —— 报告 / JSON / markdown 快照。
 * 共同要求（§7.1）：每个文件头含生成时间 / 数据范围 / `produced_by` / 数据条数；
 * 不出现内部 id 作为唯一标识（必须带 `display_name`）；含口径声明与已知缺口。
 * §7.4：**默认不含消息正文**——本模块的输入类型里没有正文字段，违规在类型层面不可表达。
 * 只读快照：产出的 markdown 不接受回灌（DESIGN-10 §8.4 / DESIGN-09 §3a）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphSnapshot, ScopeKind } from "@knowself/contracts";
import type { ScoredPerson } from "./value-scorer";

/** §7.2 `envelope.schema_version`。 */
const EXPORT_SCHEMA_VERSION = "1";
/** §7.2 `envelope.produced_by` 默认值。 */
export const DEFAULT_EXPORT_PRODUCED_BY = "mining:export-v1";
/** §7.4 落盘根目录（`data/` 已在 `.gitignore`）。 */
export const EXPORT_ROOT = "data/mining/exports";
/** 报告默认 Top-N（§7.3）。 */
const DEFAULT_TOP_N = 10;
/** §3.3.2 的口径声明（每个文件头必带）。 */
const CALIBER_NOTE =
  "口径声明：session_duration_* 为对话窗口长度（非注意力时长）；active_duration_* 为保守下界；" +
  "指标为窗口内聚合而非抽样；跨天会话不按自然日截断。";

export type ExportKind = "weekly" | "monthly" | "person" | "graph" | "ranking";

const KIND_LABEL: Readonly<Record<ExportKind, string>> = {
  weekly: "周报",
  monthly: "月报",
  person: "画像报告",
  graph: "图谱报告",
  ranking: "排名报告",
};

export interface ExportPersonRef {
  readonly person_id: string;
  readonly display_name: string;
}

export interface ExportGroupRef {
  readonly conversation_id: string;
  readonly display_name: string;
}

/** 导出用指标行（person-store `MetricRow` 的可读投影；**不含消息正文**）。 */
export interface ExportMetricRow {
  readonly person_id: string;
  readonly display_name: string;
  readonly metric_key: string;
  readonly metric_value: number | null;
  readonly metric_value_json: string | null;
  readonly scope_kind: string;
  readonly scope_id: string;
  readonly period: string;
  readonly period_key: string;
}

/** §7.3 第 6 节的数据质量输入。 */
export interface ExportQuality {
  readonly unresolved_senders?: number;
  readonly reverted_batches?: number;
  readonly degraded_sessions?: number;
}

export interface ExportInput {
  readonly exportKind: ExportKind;
  readonly generatedAt?: string;
  readonly producedBy?: string;
  readonly dataRange: { readonly from: string | null; readonly to: string | null };
  readonly scope?: { readonly scope_kind: ScopeKind; readonly scope_id: string };
  readonly counts: {
    readonly messages: number;
    readonly persons: number;
    readonly conversations: number;
  };
  readonly warnings?: readonly string[];
  readonly persons: readonly ExportPersonRef[];
  readonly groups?: readonly ExportGroupRef[];
  readonly metrics?: readonly ExportMetricRow[];
  readonly ranking?: readonly ScoredPerson[];
  readonly graph?: GraphSnapshot | null;
  readonly quality?: ExportQuality;
  readonly topN?: number;
}

/** §7.2 信封（含 §7.1 要求的口径声明与已知缺口字段）。 */
export interface ExportEnvelope {
  readonly schema_version: string;
  readonly export_kind: ExportKind;
  readonly generated_at: string;
  readonly produced_by: string;
  readonly data_range: { readonly from: string | null; readonly to: string | null };
  readonly scope: { readonly scope_kind: ScopeKind; readonly scope_id: string };
  readonly counts: ExportInput["counts"];
  readonly warnings: readonly string[];
  readonly 口径声明: string;
  readonly 已知缺口: readonly string[];
}

export interface ExportArtifacts {
  /** 相对路径 → 文件内容。 */
  readonly files: ReadonlyMap<string, string>;
  readonly envelope: ExportEnvelope;
  readonly warnings: readonly string[];
}

/** 文件名净化：`:` / 空格等非法字符 → `_`（Windows 兼容）。 */
function sanitizeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** markdown 表格单元转义。 */
function cell(text: string): string {
  return text.replace(/\|/g, "/").replace(/\n/g, " ");
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : String(value);
}

interface HeaderContext {
  readonly generatedAt: string;
  readonly producedBy: string;
  readonly dataRange: { readonly from: string | null; readonly to: string | null };
  readonly counts: ExportInput["counts"];
  readonly warnings: readonly string[];
  readonly dataRows: number;
}

/** §7.1 共同要求：每个文件头部块。 */
function header(title: string, context: HeaderContext): string {
  const from = context.dataRange.from ?? "不限";
  const to = context.dataRange.to ?? "不限";
  const gaps = context.warnings.length === 0 ? "（无）" : context.warnings.join("；");
  return [
    `# ${title}`,
    "",
    `> 生成时间：${context.generatedAt} ｜ 数据范围：${from} ~ ${to} ｜ produced_by：${context.producedBy}`,
    `> 数据条数：消息 ${context.counts.messages} 条 / 人物 ${context.counts.persons} 人 / 会话 ${context.counts.conversations} 个（本文件数据行 ${context.dataRows}）`,
    `> ${CALIBER_NOTE}`,
    `> 已知缺口：${gaps}`,
    "",
  ].join("\n");
}

export function buildExport(input: ExportInput): ExportArtifacts {
  const producedBy = input.producedBy ?? DEFAULT_EXPORT_PRODUCED_BY;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const scope = input.scope ?? { scope_kind: "global" as ScopeKind, scope_id: "" };
  const topN = input.topN ?? DEFAULT_TOP_N;
  const warnings = new Set<string>(input.warnings ?? []);
  const nameById = new Map(input.persons.map((p) => [p.person_id, p.display_name]));

  // 不猜：display_name 缺失时回退 person_id 并记 warning（每个 id 只记一次）
  const resolveName = (personId: string, given?: string): string => {
    const resolved =
      given !== undefined && given.length > 0 ? given : (nameById.get(personId) ?? "");
    if (resolved.length > 0) return resolved;
    warnings.add(`display_name_missing:${personId}`);
    return personId;
  };

  // 第一遍（预扫描）：解析全部引用到的展示名，把 warning 一次性收齐——
  // 否则后生成的文件头会漏掉本次新增的缺口（求值顺序陷阱）。
  const metrics = (input.metrics ?? []).map((row) => ({
    ...row,
    display_name: resolveName(row.person_id, row.display_name),
  }));
  const rankingEntries = (input.ranking ?? []).map((scored) => ({
    scored,
    display_name: resolveName(scored.person_id),
  }));
  const resolvedNames = new Map<string, string>();
  for (const row of metrics) resolvedNames.set(row.person_id, row.display_name);
  for (const entry of rankingEntries) {
    resolvedNames.set(entry.scored.person_id, entry.display_name);
  }
  /** 已解析的展示名（不再产生 warning）。 */
  const displayName = (personId: string, given?: string): string => {
    const resolved = given !== undefined && given.length > 0 ? given : resolvedNames.get(personId);
    return resolved !== undefined && resolved.length > 0 ? resolved : personId;
  };

  const ranking = rankingEntries.map((entry) => entry.scored);
  const graph = input.graph ?? null;
  const groups = input.groups ?? [];
  const quality = input.quality ?? {};

  // 有数据的人物才产出 persons/*.md（metrics 或 ranking 引用到的）
  const personIds = new Set<string>();
  for (const row of metrics) personIds.add(row.person_id);
  for (const scored of ranking) personIds.add(scored.person_id);

  const warningList = [...warnings].sort();
  const baseContext: HeaderContext = {
    generatedAt,
    producedBy,
    dataRange: input.dataRange,
    counts: input.counts,
    warnings: warningList,
    dataRows: metrics.length,
  };

  const envelope: ExportEnvelope = {
    schema_version: EXPORT_SCHEMA_VERSION,
    export_kind: input.exportKind,
    generated_at: generatedAt,
    produced_by: producedBy,
    data_range: { from: input.dataRange.from, to: input.dataRange.to },
    scope: { scope_kind: scope.scope_kind, scope_id: scope.scope_id },
    counts: input.counts,
    warnings: warningList,
    口径声明: CALIBER_NOTE,
    已知缺口: warningList,
  };

  const files = new Map<string, string>();

  // ── 形态 2：JSON（§7.2）────────────────────────────────────────────────
  const rankingJson = rankingEntries.map(({ scored, display_name }) => ({
    person_id: scored.person_id,
    display_name,
    value_score: scored.value_score,
    value_rank: scored.value_rank,
    breakdown: scored.breakdown,
  }));
  files.set(
    "data.json",
    `${JSON.stringify(
      {
        envelope,
        metrics: metrics.map((row) => ({
          ...row,
          display_name: displayName(row.person_id, row.display_name),
        })),
        ranking: rankingJson,
        graph,
      },
      null,
      2,
    )}\n`,
  );

  // ── 形态 1：报告（§7.3）────────────────────────────────────────────────
  files.set(
    "report.md",
    buildReport({
      input,
      context: baseContext,
      metrics,
      ranking,
      graph,
      groups,
      quality,
      topN,
      displayName,
    }),
  );

  // ── 形态 3：markdown 快照（§7.1；只读，不接受回灌）──────────────────────
  const snapshotContext: HeaderContext = { ...baseContext, dataRows: personIds.size };
  files.set(
    "index.md",
    buildIndex({ input, context: snapshotContext, personIds, ranking, groups, graph }),
  );
  for (const personId of [...personIds].sort()) {
    files.set(
      `persons/${sanitizeFileName(personId)}.md`,
      buildPersonDoc({
        personId,
        displayName: displayName(personId),
        metrics,
        ranking,
        graph,
        context: {
          ...baseContext,
          dataRows: metrics.filter((m) => m.person_id === personId).length,
        },
      }),
    );
  }
  for (const group of groups) {
    files.set(
      `groups/${sanitizeFileName(group.conversation_id)}.md`,
      buildGroupDoc({ group, graph, context: { ...baseContext, dataRows: 1 } }),
    );
  }
  files.set(
    "graph/communities.md",
    buildCommunitiesDoc({
      graph,
      context: { ...baseContext, dataRows: graph?.communities.length ?? 0 },
    }),
  );

  return { files, envelope, warnings: warningList };
}

interface ReportArgs {
  readonly input: ExportInput;
  readonly context: HeaderContext;
  readonly metrics: readonly ExportMetricRow[];
  readonly ranking: readonly ScoredPerson[];
  readonly graph: GraphSnapshot | null;
  readonly groups: readonly ExportGroupRef[];
  readonly quality: ExportQuality;
  readonly topN: number;
  readonly displayName: (personId: string, given?: string) => string;
}

function buildReport(args: ReportArgs): string {
  const { input, context, metrics, ranking, graph, quality, topN, displayName } = args;
  const title = `${KIND_LABEL[input.exportKind]} · ${input.dataRange.to ?? "不限"}`;
  const lines: string[] = [header(title, context)];

  // 1. 总览
  lines.push("## 1. 总览");
  lines.push("");
  lines.push("| 指标 | 本期 | 上期 | 变化 |");
  lines.push("| ---- | ---- | ---- | ---- |");
  lines.push(`| 消息条数 | ${context.counts.messages} | — | — |`);
  lines.push(`| 人物数 | ${context.counts.persons} | — | — |`);
  lines.push(`| 会话数 | ${context.counts.conversations} | — | — |`);
  lines.push("");
  lines.push("> 上期对比需传入上期指标集（未提供时显示 —）。");
  lines.push("");

  // 2. 互动变化 Top / Bottom
  const freq = metrics
    .filter((row) => row.metric_key === "msg_count_other" && row.metric_value !== null)
    .sort((a, b) => (b.metric_value ?? 0) - (a.metric_value ?? 0));
  lines.push("## 2. 互动变化 Top 10 / Bottom 10");
  lines.push("");
  lines.push("| 方向 | 人物 | 对方消息数 |");
  lines.push("| ---- | ---- | ---- |");
  for (const row of freq.slice(0, topN)) {
    lines.push(
      `| Top | ${cell(displayName(row.person_id, row.display_name))} | ${formatNumber(row.metric_value)} |`,
    );
  }
  const bottom = [...freq].reverse().filter((row) => (row.metric_value ?? 0) > 0);
  for (const row of bottom.slice(0, topN)) {
    lines.push(
      `| Bottom | ${cell(displayName(row.person_id, row.display_name))} | ${formatNumber(row.metric_value)} |`,
    );
  }
  if (freq.length === 0) lines.push("| — | （无 msg_count_other 指标） | — |");
  lines.push("");

  // 3. 话题与意图分布
  lines.push("## 3. 话题与意图分布");
  lines.push("");
  const intentTotals = new Map<string, number>();
  for (const row of metrics) {
    if (row.metric_key !== "intent_dist" || row.metric_value_json === null) continue;
    try {
      const parsed = JSON.parse(row.metric_value_json) as Record<string, number>;
      for (const [intent, count] of Object.entries(parsed)) {
        intentTotals.set(intent, (intentTotals.get(intent) ?? 0) + count);
      }
    } catch {
      // 非法 JSON 的指标行跳过（不猜）
    }
  }
  lines.push("| 意图 | 条数 |");
  lines.push("| ---- | ---- |");
  for (const [intent, count] of [...intentTotals.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${cell(intent)} | ${count} |`);
  }
  if (intentTotals.size === 0) lines.push("| （无 intent_dist 指标） | — |");
  lines.push("");
  const topics = (graph?.nodes ?? []).filter((node) => node.kind === "topic");
  lines.push("| 话题 | 命中次数 |");
  lines.push("| ---- | ---- |");
  for (const topic of topics.slice(0, topN)) {
    lines.push(`| ${cell(topic.label)} | ${topic.size_raw} |`);
  }
  if (topics.length === 0) lines.push("| （本期无话题节点） | — |");
  lines.push("");

  // 4. 小圈子（社区）
  lines.push("## 4. 小圈子（社区）");
  lines.push("");
  lines.push("| 社区 | 人数 | 凝聚度 |");
  lines.push("| ---- | ---- | ---- |");
  for (const community of graph?.communities ?? []) {
    lines.push(
      `| ${cell(community.label)} | ${community.size} | ${community.cohesion.toFixed(3)} |`,
    );
  }
  if ((graph?.communities.length ?? 0) === 0) lines.push("| （本期未发现社区） | — | — |");
  lines.push("");
  lines.push(
    `> 模块度 modularity = ${(graph?.stats.modularity ?? 0).toFixed(3)}（低于 0.3 时社区结构不显著）。`,
  );
  lines.push("");

  // 5. 价值 Top-N
  lines.push(`## 5. 价值 Top-${topN}`);
  lines.push("");
  lines.push("| 排名 | 人物 | 价值分 |");
  lines.push("| ---- | ---- | ---- |");
  for (const scored of ranking.slice(0, topN)) {
    lines.push(
      `| ${scored.value_rank} | ${cell(displayName(scored.person_id))} | ${scored.value_score.toFixed(4)} |`,
    );
  }
  if (ranking.length === 0) lines.push("| — | （未提供价值排名） | — |");
  lines.push("");

  // 6. 数据质量与已知缺口
  lines.push("## 6. 数据质量与已知缺口");
  lines.push("");
  lines.push(`- 未解析发送者：${quality.unresolved_senders ?? 0}`);
  lines.push(`- 已回滚批次：${quality.reverted_batches ?? 0}`);
  lines.push(`- 降级会话数：${quality.degraded_sessions ?? graph?.stats.degraded_sessions ?? 0}`);
  const intentTotal = [...intentTotals.values()].reduce((a, b) => a + b, 0);
  lines.push(
    `- 意图 other 占比：${
      intentTotal === 0 ? "—" : ((intentTotals.get("other") ?? 0) / intentTotal).toFixed(2)
    }`,
  );
  for (const warning of context.warnings) lines.push(`- ${warning}`);
  lines.push("");
  return lines.join("\n");
}

interface SnapshotArgs {
  readonly input: ExportInput;
  readonly context: HeaderContext;
  readonly personIds: ReadonlySet<string>;
  readonly ranking: readonly ScoredPerson[];
  readonly groups: readonly ExportGroupRef[];
  readonly graph: GraphSnapshot | null;
}

function buildIndex(args: SnapshotArgs): string {
  const { input, context, personIds, groups, graph } = args;
  const lines = [header("mining 导出快照（只读，不接受回灌）", context)];
  lines.push(`- 导出类型：${input.exportKind}（${KIND_LABEL[input.exportKind]}）`);
  lines.push(`- 人物文档：${personIds.size} 份（\`persons/\`）`);
  lines.push(`- 群文档：${groups.length} 份（\`groups/\`）`);
  lines.push(
    `- 图谱：节点 ${graph?.nodes.length ?? 0} / 边 ${graph?.edges.length ?? 0} / 社区 ${graph?.communities.length ?? 0}（\`graph/communities.md\`）`,
  );
  lines.push("");
  lines.push("## 人物索引");
  lines.push("");
  lines.push("| 人物 | 文档 |");
  lines.push("| ---- | ---- |");
  for (const personId of [...personIds].sort()) {
    const name = input.persons.find((p) => p.person_id === personId)?.display_name ?? personId;
    lines.push(`| ${cell(name)} | persons/${sanitizeFileName(personId)}.md |`);
  }
  if (personIds.size === 0) lines.push("| （无） | — |");
  lines.push("");
  lines.push("## 群索引");
  lines.push("");
  lines.push("| 群 | 文档 |");
  lines.push("| ---- | ---- |");
  for (const group of groups) {
    lines.push(
      `| ${cell(group.display_name)} | groups/${sanitizeFileName(group.conversation_id)}.md |`,
    );
  }
  if (groups.length === 0) lines.push("| （无） | — |");
  lines.push("");
  return lines.join("\n");
}

interface PersonDocArgs {
  readonly personId: string;
  readonly displayName: string;
  readonly metrics: readonly ExportMetricRow[];
  readonly ranking: readonly ScoredPerson[];
  readonly graph: GraphSnapshot | null;
  readonly context: HeaderContext;
}

function buildPersonDoc(args: PersonDocArgs): string {
  const { personId, displayName, metrics, ranking, graph, context } = args;
  const lines = [header(`人物：${displayName}`, context)];
  const scored = ranking.find((entry) => entry.person_id === personId);
  if (scored !== undefined) {
    lines.push(`- 价值分：${scored.value_score.toFixed(4)}（排名 ${scored.value_rank}）`);
    lines.push("");
  }
  const own = metrics.filter((m) => m.person_id === personId);
  lines.push("## 指标");
  lines.push("");
  lines.push("| 指标 | 值 | 范围 |");
  lines.push("| ---- | ---- | ---- |");
  for (const row of own) {
    lines.push(
      `| ${cell(row.metric_key)} | ${cell(formatNumber(row.metric_value))}${
        row.metric_value_json === null ? "" : ` \`${cell(row.metric_value_json)}\``
      } | ${cell(row.scope_kind)} |`,
    );
  }
  if (own.length === 0) lines.push("| （无） | — | — |");
  lines.push("");
  const edges = (graph?.edges ?? []).filter(
    (edge) => edge.source === personId || edge.target === personId,
  );
  lines.push("## 关系边");
  lines.push("");
  lines.push("| 类型 | 对端 | 强度 |");
  lines.push("| ---- | ---- | ---- |");
  for (const edge of edges.slice(0, 20)) {
    const other = edge.source === personId ? edge.target : edge.source;
    const otherName = graph?.nodes.find((node) => node.id === other)?.label ?? other;
    lines.push(`| ${cell(edge.kind)} | ${cell(otherName)} | ${edge.strength.toFixed(3)} |`);
  }
  if (edges.length === 0) lines.push("| （无） | — | — |");
  lines.push("");
  return lines.join("\n");
}

interface GroupDocArgs {
  readonly group: ExportGroupRef;
  readonly graph: GraphSnapshot | null;
  readonly context: HeaderContext;
}

function buildGroupDoc(args: GroupDocArgs): string {
  const { group, graph, context } = args;
  const lines = [header(`群：${group.display_name}`, context)];
  const node = graph?.nodes.find((entry) => entry.id === group.conversation_id);
  lines.push(`- 窗口内消息数：${node?.size_raw ?? 0}`);
  lines.push("");
  lines.push("## 成员（按消息数）");
  lines.push("");
  lines.push("| 成员 | 消息数 |");
  lines.push("| ---- | ---- |");
  const memberEdges = (graph?.edges ?? [])
    .filter(
      (edge) =>
        (edge.kind === "membership" || edge.kind === "my_group") &&
        (edge.source === group.conversation_id || edge.target === group.conversation_id),
    )
    .sort((a, b) => b.weight_raw - a.weight_raw);
  for (const edge of memberEdges.slice(0, 50)) {
    const memberId = edge.source === group.conversation_id ? edge.target : edge.source;
    const memberName = graph?.nodes.find((entry) => entry.id === memberId)?.label ?? memberId;
    lines.push(`| ${cell(memberName)} | ${edge.weight_raw} |`);
  }
  if (memberEdges.length === 0) lines.push("| （无） | — |");
  lines.push("");
  return lines.join("\n");
}

interface CommunitiesDocArgs {
  readonly graph: GraphSnapshot | null;
  readonly context: HeaderContext;
}

function buildCommunitiesDoc(args: CommunitiesDocArgs): string {
  const { graph, context } = args;
  const lines = [header("图谱社区（小圈子）", context)];
  lines.push(
    `- 节点 ${graph?.nodes.length ?? 0} / 边 ${graph?.edges.length ?? 0} / 社区 ${graph?.communities.length ?? 0}`,
  );
  lines.push(`- 模块度：${(graph?.stats.modularity ?? 0).toFixed(3)}`);
  lines.push("");
  lines.push("| 社区 | 人数 | 凝聚度 | 成员 |");
  lines.push("| ---- | ---- | ---- | ---- |");
  for (const community of graph?.communities ?? []) {
    const names = community.member_ids
      .map((id) => graph?.nodes.find((node) => node.id === id)?.label ?? id)
      .join("、");
    lines.push(
      `| ${cell(community.label)} | ${community.size} | ${community.cohesion.toFixed(3)} | ${cell(names)} |`,
    );
  }
  if ((graph?.communities.length ?? 0) === 0) lines.push("| （无） | — | — | — |");
  lines.push("");
  return lines.join("\n");
}

/** 落盘（§7.4 约定目录：`data/mining/exports/<ISO 时间戳>/`）。返回相对路径清单。 */
export function writeExport(outDir: string, artifacts: ExportArtifacts): string[] {
  const written: string[] = [];
  for (const [relative, content] of artifacts.files) {
    const target = join(outDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    written.push(relative);
  }
  return written.sort();
}

/** `Exporter` 别名（DESIGN-12 §12 P1-7 命名）。 */
export const Exporter = { build: buildExport, write: writeExport };
