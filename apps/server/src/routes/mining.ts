/**
 * mining.ts — mining 只读路由（DESIGN-12 §8.5 R1~R4，7c-2）
 *
 * path 以 §8.5 为准，**不得自造**：
 * - `GET  /api/mining/graph`               → `getGraphSnapshot`（R1；**已启用 gzip**）
 * - `GET  /api/mining/persons/:id/metrics` → `getPersonMetrics`（R2）
 * - `GET  /api/mining/ranking`             → `getRanking`（R3；`top` ≤ 200）
 * - `POST /api/mining/export`              → `exportMining`（R4）
 *
 * 只读 + 幂等（§8.5）：R1~R3 不写库；R4 只写导出文件。
 *
 * ── 本文件的三个边界决定（均已登记 `docs/units/mining/status.md`）──
 * 1. **查询参数在本文件校验**，不在 `@knowself/contracts` 新增 schema —— exec plan 7c-2
 *    明确「本工单不新增 contracts schema」（R2/R3/R4 出参 schema 归 DESIGN-19 §3.4 #2）。
 * 2. **不复用 `zValidate(_, "query")`**：它把 `searchParams` 折叠成
 *    `Record<string, string>`，① 重复键（`?communities=a&communities=b`）只剩最后一个，
 *    无法表达 §8.5 的 `communities[]` / `relation_types[]` / `keys[]` 数组参数；
 *    ② 数字强转用 `/^\d+$/`，`min_strength=0.05`、负数都不会转成 number。
 *    故本文件自建 `readQuery` 读 `c.req.queries()`（`Record<string, string[]>`）。
 *    不改共享中间件——避免动到既有路由的既有行为。
 * 3. **R1 的 `from` / `to` 只告警不筛选**（ISS-008）：§8.5 列了这两个参数，但
 *    `GetGraphSnapshotQuery` 无对应字段、快照选取只按 scope + 最新（§4.6），
 *    设计未定义口径 → 按附录 B #7「不猜」：接受参数、回 `GRAPH_TIME_RANGE_UNSUPPORTED`
 *    告警，不发明语义（与 R3 的 ISS-006 同处理）。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { compress } from "hono/compress";
import { z } from "zod";
import { GraphEdgeKindSchema, ScopeKindSchema } from "@knowself/contracts";
import {
  DEFAULT_EXPORT_FORMAT,
  EXPORT_FORMATS,
  RANKING_TOP_MAX,
  exportMining,
  getGraphSnapshot,
  getPersonMetrics,
  getRanking,
} from "@knowself/mining";
import type { Runtime } from "../runtime";

/** `MetricRow["period"]`（person-store `types-derive.ts`）。 */
const PeriodSchema = z.enum(["all", "day", "week", "month", "year"]);
/** §7.2 定稿五值（`ExportKind`）。 */
const ExportKindSchema = z.enum(["weekly", "monthly", "person", "graph", "ranking"]);
const ExportFormatSchema = z.enum(EXPORT_FORMATS);

/** ISS-008：R1 的 `from` / `to` 无设计口径 → 告警而非筛选。 */
export const WARN_GRAPH_TIME_RANGE_UNSUPPORTED = "GRAPH_TIME_RANGE_UNSUPPORTED";

const DEFAULT_SCOPE_KIND = "global";
const DEFAULT_SCOPE_ID = "";

// ── 查询解析 ────────────────────────────────────────────────────────────────

type RawQuery = Record<string, string[]>;

/**
 * 取单值参数（同名重复时取最后一个，与 HTTP 常规一致）。
 * 同时接受 `name` 与 `name[]` 两种键名——§8.5 参数表写作 `communities[]`。
 */
function single(raw: RawQuery, name: string): string | undefined {
  const values = raw[name] ?? raw[`${name}[]`];
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

/** 取数组参数：支持重复键与逗号分隔两种客户端写法。 */
function many(raw: RawQuery, name: string): string[] | undefined {
  const values = raw[name] ?? raw[`${name}[]`];
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  const out = values.flatMap((value) => value.split(",")).filter((value) => value.length > 0);
  return out.length === 0 ? undefined : out;
}

/** 取数字参数；非法（非有限数）返回 `undefined`，由 Zod 兜底报错。 */
function num(raw: RawQuery, name: string): number | undefined {
  const value = single(raw, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readQuery(c: Context): RawQuery {
  return c.req.queries() as RawQuery;
}

/** Zod 校验失败 → 422（与 `zValidate` 同语义，由 `errorMiddleware` 统一处理）。 */
function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  return schema.parse(input);
}

// ── 查询 schema（§8.5 + §8.1 第 723 行口径定稿）─────────────────────────────

const GraphQuerySchema = z.object({
  scope_kind: ScopeKindSchema,
  scope_id: z.string(),
  snapshot_id: z.string().min(1).optional(),
  /** §4.5 归一化强度，0~1。 */
  min_strength: z.number().min(0).max(1).optional(),
  /** §8.1：按节点 `size_raw`（原始互动量），非归一化 `size`。 */
  min_interaction: z.number().int().min(0).optional(),
  /** §8.4 `community_key` 列表。 */
  communities: z.array(z.string().min(1)).optional(),
  /** §8.1：按 person 节点的 `relation_type`（诱导子图）。 */
  relation_types: z.array(z.string().min(1)).optional(),
  /** §8.1 第 723 行标为「加法式」；§8.5 参数表未列（ISS-005）→ 仍实现。 */
  edge_kinds: z.array(GraphEdgeKindSchema).optional(),
});

const PersonMetricsQuerySchema = z.object({
  period: PeriodSchema.optional(),
  period_key: z.string().optional(),
  keys: z.array(z.string().min(1)).optional(),
});

const RankingQuerySchema = z.object({
  top: z.number().int().min(0).max(RANKING_TOP_MAX).optional(),
  /** §8.5 登记但未定义口径（ISS-006）→ 仅告警。 */
  from: z.string().optional(),
  to: z.string().optional(),
});

const ExportBodySchema = z.object({
  export_kind: ExportKindSchema,
  format: ExportFormatSchema.default(DEFAULT_EXPORT_FORMAT),
  scope: z.object({ scope_kind: ScopeKindSchema, scope_id: z.string() }).optional(),
  range: z.object({ from: z.string().nullable(), to: z.string().nullable() }).optional(),
  write: z.boolean().default(true),
});

// ── 路由 ────────────────────────────────────────────────────────────────────

export function miningRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  // GET /api/mining/graph（R1）
  // §8.5 / DESIGN-17 §1.1：**必须**启用 gzip（3000 节点 / 10000 边 ≈ 3~5 MB JSON，
  // 否则 NFR-11 首屏 < 2s 有风险）。只挂本路由，不动其余路由组——「最窄范围」。
  // `hono/compress` 默认 `threshold: 1024`（字节）：小快照不压缩（省 CPU，无收益），
  // 大快照自动 gzip；仅在客户端 `Accept-Encoding` 含 gzip/deflate 时生效。
  router.get("/graph", compress(), (c: Context) => {
    const raw = readQuery(c);
    const q = parseOrThrow(GraphQuerySchema, {
      scope_kind: single(raw, "scope_kind") ?? DEFAULT_SCOPE_KIND,
      scope_id: single(raw, "scope_id") ?? DEFAULT_SCOPE_ID,
      snapshot_id: single(raw, "snapshot_id"),
      min_strength: num(raw, "min_strength"),
      min_interaction: num(raw, "min_interaction"),
      communities: many(raw, "communities"),
      relation_types: many(raw, "relation_types"),
      edge_kinds: many(raw, "edge_kinds"),
    });

    const result = getGraphSnapshot(runtime.personStore, {
      scope_kind: q.scope_kind,
      scope_id: q.scope_id,
      ...(q.snapshot_id === undefined ? {} : { snapshot_id: q.snapshot_id }),
      ...(q.min_strength === undefined ? {} : { min_strength: q.min_strength }),
      ...(q.min_interaction === undefined ? {} : { min_interaction: q.min_interaction }),
      ...(q.communities === undefined ? {} : { communities: q.communities }),
      ...(q.relation_types === undefined ? {} : { relation_types: q.relation_types }),
      ...(q.edge_kinds === undefined ? {} : { edge_kinds: q.edge_kinds }),
    });

    // §8.5：该 scope 下无快照 → 404（读层以 null 表达，不抛错）
    if (result === null) {
      return c.json({ code: "NOT_FOUND", message: "No graph snapshot for the given scope" }, 404);
    }

    // ISS-008：from / to 无设计口径 → 告警，不参与筛选
    const warnings = [...result.warnings];
    if (single(raw, "from") !== undefined || single(raw, "to") !== undefined) {
      warnings.push(WARN_GRAPH_TIME_RANGE_UNSUPPORTED);
    }

    return c.json({ snapshot: result.snapshot, warnings });
  });

  // GET /api/mining/persons/:id/metrics（R2）
  router.get("/persons/:id/metrics", (c: Context) => {
    const raw = readQuery(c);
    const q = parseOrThrow(PersonMetricsQuerySchema, {
      period: single(raw, "period"),
      period_key: single(raw, "period_key"),
      keys: many(raw, "keys"),
    });

    const result = getPersonMetrics(runtime.personStore, c.req.param("id")!, {
      ...(q.period === undefined ? {} : { period: q.period }),
      ...(q.period_key === undefined ? {} : { period_key: q.period_key }),
      ...(q.keys === undefined ? {} : { keys: q.keys }),
    });

    // §8.5-R2：无行返回空数组（不是 404）——人可能存在但尚未产出指标
    return c.json(result);
  });

  // GET /api/mining/ranking（R3）
  router.get("/ranking", (c: Context) => {
    const raw = readQuery(c);
    const q = parseOrThrow(RankingQuerySchema, {
      top: num(raw, "top"),
      from: single(raw, "from"),
      to: single(raw, "to"),
    });

    const result = getRanking(runtime.personStore, {
      ...(q.top === undefined ? {} : { top: q.top }),
      ...(q.from === undefined ? {} : { from: q.from }),
      ...(q.to === undefined ? {} : { to: q.to }),
    });

    return c.json(result);
  });

  // POST /api/mining/export（R4）
  router.post("/export", async (c: Context) => {
    const body = parseOrThrow(ExportBodySchema, await c.req.json().catch(() => ({})));

    const result = exportMining(runtime.personStore, {
      export_kind: body.export_kind,
      format: body.format,
      write: body.write,
      ...(body.scope === undefined ? {} : { scope: body.scope }),
      ...(body.range === undefined ? {} : { range: body.range }),
    });

    // `files` 只回路径与字节数；内容在磁盘上（§7.4）
    return c.json({
      envelope: result.envelope,
      warnings: result.warnings,
      files: result.files,
      written: result.written,
      outDir: result.outDir,
    });
  });

  return router;
}
