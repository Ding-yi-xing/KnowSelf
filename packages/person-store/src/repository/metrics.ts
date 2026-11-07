/**
 * `metrics` 仓库（DESIGN-13 §3.8 接口定稿，签名逐字）：
 * `person_metrics` + `chat_message_intents` + `mining_graph_snapshots`。
 * 派生层语义（D3）：`upsert` 遇 `manual_locked=1` 跳过并回报；`deleteByProducedBy`
 * 只删 `produced_by <> :not` 且未锁定的行；意图表无 `manual_locked` 列，按版本位整层重建。
 */
import { randomUUID } from "node:crypto";
import type { PersonDb } from "../db";
import {
  dbBool,
  type GraphSnapshotInsert,
  type GraphSnapshotRow,
  type IntentRow,
  type IntentUpsert,
  type MetricRow,
  type MetricUpsert,
} from "../types-derive";

/** SQLite 投影（0/1 整数）→ 领域行（boolean）。 */
type DbMetricRow = Omit<MetricRow, "manual_locked"> & { manual_locked: number };
type DbIntentRow = Omit<IntentRow, "ambiguous"> & { ambiguous: number };
function mapMetric(row: DbMetricRow): MetricRow {
  return { ...row, manual_locked: dbBool(row.manual_locked) };
}
function mapIntent(row: DbIntentRow): IntentRow {
  return { ...row, ambiguous: dbBool(row.ambiguous) };
}

export interface MetricsRepo {
  // ── person_metrics ──
  upsert(rows: readonly MetricUpsert[]): { upserted: number; skipped_locked: number };
  get(key: {
    person_id: string;
    scope_kind: MetricRow["scope_kind"];
    scope_id: string;
    period: MetricRow["period"];
    period_key: string;
    metric_key: string;
  }): MetricRow | null;
  list(q: {
    person_id?: string;
    scope_kind?: MetricRow["scope_kind"];
    scope_id?: string;
    period?: MetricRow["period"];
    period_key?: string;
    metric_keys?: readonly string[];
    limit?: number;
    offset?: number;
  }): MetricRow[];
  deleteByProducedBy(q: {
    produced_by_not: string;
    person_id?: string;
    scope_kind?: MetricRow["scope_kind"];
    scope_id?: string;
  }): { deleted: number };
  setManualLocked(metricId: string, locked: boolean, now: string): void;

  // ── chat_message_intents ──
  upsertIntents(rows: readonly IntentUpsert[]): { upserted: number };
  listIntents(q: {
    message_ids?: readonly string[];
    intent?: IntentRow["intent"];
    min_confidence?: number;
    limit?: number;
  }): IntentRow[];
  deleteIntentsByProducedBy(q: { produced_by_not: string }): { deleted: number };

  // ── mining_graph_snapshots ──
  insertGraphSnapshot(row: GraphSnapshotInsert): { snapshot_id: string };
  latestGraphSnapshot(q: {
    graph_kind: GraphSnapshotRow["graph_kind"];
    scope_kind: GraphSnapshotRow["scope_kind"];
    scope_id: string;
  }): GraphSnapshotRow | null;
  listGraphSnapshots(q?: {
    graph_kind?: GraphSnapshotRow["graph_kind"];
    scope_kind?: GraphSnapshotRow["scope_kind"];
    scope_id?: string;
    limit?: number;
  }): GraphSnapshotRow[];
  pruneGraphSnapshots(q: {
    graph_kind: GraphSnapshotRow["graph_kind"];
    scope_kind: GraphSnapshotRow["scope_kind"];
    scope_id: string;
    keep: number;
  }): { deleted: number };
}

const METRIC_COLS = [
  "metric_id", "person_id", "scope_kind", "scope_id", "period", "period_key",
  "metric_key", "metric_value", "metric_value_json", "metric_unit", "computed_at",
  "produced_by", "source_ref", "evidence_count", "manual_locked",
] as const;

const INTENT_COLS = [
  "message_id", "intent", "confidence", "ambiguous", "matched_rules",
  "produced_by", "computed_at",
] as const;

const SNAPSHOT_COLS = [
  "snapshot_id", "graph_kind", "scope_kind", "scope_id", "time_from", "time_to",
  "params_json", "payload_json", "node_count", "edge_count", "community_count",
  "produced_by", "computed_at",
] as const;

const METRIC_KEY_FILTER = `person_id = ? AND scope_kind = ? AND scope_id = ? AND period = ? AND period_key = ? AND metric_key = ?`;

function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function createMetricsRepo(db: PersonDb): MetricsRepo {
  const upsert: MetricsRepo["upsert"] = (rows) => {
    let upserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const personId = row.person_id;
      const scopeKind = row.scope_kind;
      const scopeId = row.scope_id ?? "";
      const period = row.period ?? "all";
      const periodKey = row.period_key ?? "";
      const existing = db
        .prepare(`SELECT * FROM person_metrics WHERE ${METRIC_KEY_FILTER}`)
        .get(personId, scopeKind, scopeId, period, periodKey, row.metric_key) as
        | DbMetricRow
        | undefined;
      if (existing !== undefined && existing.manual_locked === 1) {
        skipped += 1;
        continue;
      }
      const full: MetricRow = {
        metric_id: row.metric_id ?? randomUUID(),
        person_id: personId,
        scope_kind: scopeKind,
        scope_id: scopeId,
        period,
        period_key: periodKey,
        metric_key: row.metric_key,
        metric_value: row.metric_value ?? null,
        metric_value_json: row.metric_value_json ?? null,
        metric_unit: row.metric_unit ?? "count",
        computed_at: row.computed_at ?? new Date().toISOString(),
        produced_by: row.produced_by ?? "",
        source_ref: row.source_ref ?? "[]",
        evidence_count: row.evidence_count ?? 0,
        manual_locked: false,
      };
      upserted += db
        .prepare(
          `INSERT INTO person_metrics (${METRIC_COLS.join(", ")})
           VALUES (${METRIC_COLS.map(() => "?").join(", ")})
           ON CONFLICT(person_id, scope_kind, scope_id, period, period_key, metric_key)
           DO UPDATE SET
             metric_id        = excluded.metric_id,
             metric_value     = excluded.metric_value,
             metric_value_json = excluded.metric_value_json,
             metric_unit      = excluded.metric_unit,
             computed_at      = excluded.computed_at,
             produced_by      = excluded.produced_by,
             source_ref       = excluded.source_ref,
             evidence_count   = excluded.evidence_count`,
        )
        .run(
          full.metric_id, full.person_id, full.scope_kind, full.scope_id, full.period,
          full.period_key, full.metric_key, full.metric_value, full.metric_value_json,
          full.metric_unit, full.computed_at, full.produced_by, full.source_ref,
          full.evidence_count, full.manual_locked ? 1 : 0,
        ).changes;
    }
    return { upserted, skipped_locked: skipped };
  };

  const get: MetricsRepo["get"] = (key) => {
    const row = db
      .prepare(`SELECT * FROM person_metrics WHERE ${METRIC_KEY_FILTER}`)
      .get(
        key.person_id, key.scope_kind, key.scope_id, key.period, key.period_key, key.metric_key,
      ) as DbMetricRow | undefined;
    return row === undefined ? null : mapMetric(row);
  };

  const list: MetricsRepo["list"] = (q) => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.person_id !== undefined) {
      conditions.push("person_id = ?");
      params.push(q.person_id);
    }
    if (q.scope_kind !== undefined) {
      conditions.push("scope_kind = ?");
      params.push(q.scope_kind);
    }
    if (q.scope_id !== undefined) {
      conditions.push("scope_id = ?");
      params.push(q.scope_id);
    }
    if (q.period !== undefined) {
      conditions.push("period = ?");
      params.push(q.period);
    }
    if (q.period_key !== undefined) {
      conditions.push("period_key = ?");
      params.push(q.period_key);
    }
    if (q.metric_keys !== undefined && q.metric_keys.length > 0) {
      conditions.push(`metric_key IN (${marks(q.metric_keys.length)})`);
      params.push(...q.metric_keys);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return (
      db
        .prepare(
          `SELECT * FROM person_metrics ${where}
           ORDER BY person_id ASC, metric_key ASC, period ASC, period_key ASC${page}`,
        )
        .all(...params, ...pageParams) as DbMetricRow[]
    ).map(mapMetric);
  };

  const deleteByProducedBy: MetricsRepo["deleteByProducedBy"] = (q) => {
    const conditions = ["produced_by <> ?", "manual_locked = 0"];
    const params: string[] = [q.produced_by_not];
    if (q.person_id !== undefined) {
      conditions.push("person_id = ?");
      params.push(q.person_id);
    }
    if (q.scope_kind !== undefined) {
      conditions.push("scope_kind = ?");
      params.push(q.scope_kind);
    }
    if (q.scope_id !== undefined) {
      conditions.push("scope_id = ?");
      params.push(q.scope_id);
    }
    const result = db
      .prepare(`DELETE FROM person_metrics WHERE ${conditions.join(" AND ")}`)
      .run(...params);
    return { deleted: result.changes };
  };

  const setManualLocked: MetricsRepo["setManualLocked"] = (metricId, locked, now) => {
    db.prepare(`UPDATE person_metrics SET manual_locked = ? WHERE metric_id = ?`)
      .run(locked ? 1 : 0, metricId);
    void now;
  };

  const upsertIntents: MetricsRepo["upsertIntents"] = (rows) => {
    let upserted = 0;
    for (const row of rows) {
      upserted += db
        .prepare(
          `INSERT INTO chat_message_intents (${INTENT_COLS.join(", ")})
           VALUES (${INTENT_COLS.map(() => "?").join(", ")})
           ON CONFLICT(message_id) DO UPDATE SET
             intent        = excluded.intent,
             confidence    = excluded.confidence,
             ambiguous     = excluded.ambiguous,
             matched_rules = excluded.matched_rules,
             produced_by   = excluded.produced_by,
             computed_at   = excluded.computed_at`,
        )
        .run(
          row.message_id, row.intent, row.confidence ?? 0, row.ambiguous === true ? 1 : 0,
          row.matched_rules ?? "[]", row.produced_by ?? "",
          row.computed_at ?? new Date().toISOString(),
        ).changes;
    }
    return { upserted };
  };

  const listIntents: MetricsRepo["listIntents"] = (q) => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.message_ids !== undefined && q.message_ids.length > 0) {
      conditions.push(`message_id IN (${marks(q.message_ids.length)})`);
      params.push(...q.message_ids);
    }
    if (q.intent !== undefined) {
      conditions.push("intent = ?");
      params.push(q.intent);
    }
    if (q.min_confidence !== undefined) {
      conditions.push("confidence >= ?");
      params.push(q.min_confidence);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = q.limit === undefined ? "" : " LIMIT ?";
    const pageParams = q.limit === undefined ? [] : [q.limit];
    return (
      db
        .prepare(`SELECT * FROM chat_message_intents ${where} ORDER BY message_id ASC${page}`)
        .all(...params, ...pageParams) as DbIntentRow[]
    ).map(mapIntent);
  };

  const deleteIntentsByProducedBy: MetricsRepo["deleteIntentsByProducedBy"] = (q) => {
    const result = db
      .prepare("DELETE FROM chat_message_intents WHERE produced_by <> ?")
      .run(q.produced_by_not);
    return { deleted: result.changes };
  };

  const insertGraphSnapshot: MetricsRepo["insertGraphSnapshot"] = (row) => {
    const full: GraphSnapshotRow = {
      snapshot_id: row.snapshot_id ?? randomUUID(),
      graph_kind: row.graph_kind,
      scope_kind: row.scope_kind ?? "global",
      scope_id: row.scope_id ?? "",
      time_from: row.time_from ?? null,
      time_to: row.time_to ?? null,
      params_json: row.params_json ?? "{}",
      payload_json: row.payload_json,
      node_count: row.node_count ?? 0,
      edge_count: row.edge_count ?? 0,
      community_count: row.community_count ?? 0,
      produced_by: row.produced_by ?? "",
      computed_at: row.computed_at ?? new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO mining_graph_snapshots (${SNAPSHOT_COLS.join(", ")})
       VALUES (${SNAPSHOT_COLS.map(() => "?").join(", ")})`,
    ).run(
      full.snapshot_id, full.graph_kind, full.scope_kind, full.scope_id, full.time_from,
      full.time_to, full.params_json, full.payload_json, full.node_count, full.edge_count,
      full.community_count, full.produced_by, full.computed_at,
    );
    return { snapshot_id: full.snapshot_id };
  };

  const latestGraphSnapshot: MetricsRepo["latestGraphSnapshot"] = (q) =>
    (db
      .prepare(
        `SELECT * FROM mining_graph_snapshots
          WHERE graph_kind = ? AND scope_kind = ? AND scope_id = ?
          ORDER BY computed_at DESC, snapshot_id DESC LIMIT 1`,
      )
      .get(q.graph_kind, q.scope_kind, q.scope_id) as GraphSnapshotRow | undefined) ?? null;

  const listGraphSnapshots: MetricsRepo["listGraphSnapshots"] = (q = {}) => {
    const conditions: string[] = [];
    const params: string[] = [];
    if (q.graph_kind !== undefined) {
      conditions.push("graph_kind = ?");
      params.push(q.graph_kind);
    }
    if (q.scope_kind !== undefined) {
      conditions.push("scope_kind = ?");
      params.push(q.scope_kind);
    }
    if (q.scope_id !== undefined) {
      conditions.push("scope_id = ?");
      params.push(q.scope_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = q.limit === undefined ? "" : " LIMIT ?";
    const pageParams = q.limit === undefined ? [] : [q.limit];
    return db
      .prepare(
        `SELECT * FROM mining_graph_snapshots ${where}
         ORDER BY computed_at DESC, snapshot_id DESC${page}`,
      )
      .all(...params, ...pageParams) as GraphSnapshotRow[];
  };

  const pruneGraphSnapshots: MetricsRepo["pruneGraphSnapshots"] = (q) => {
    const result = db
      .prepare(
        `DELETE FROM mining_graph_snapshots
          WHERE graph_kind = ? AND scope_kind = ? AND scope_id = ?
            AND snapshot_id NOT IN (
              SELECT snapshot_id FROM mining_graph_snapshots
               WHERE graph_kind = ? AND scope_kind = ? AND scope_id = ?
               ORDER BY computed_at DESC, snapshot_id DESC LIMIT ?
            )`,
      )
      .run(q.graph_kind, q.scope_kind, q.scope_id, q.graph_kind, q.scope_kind, q.scope_id, q.keep);
    return { deleted: result.changes };
  };

  return {
    upsert,
    get,
    list,
    deleteByProducedBy,
    setManualLocked,
    upsertIntents,
    listIntents,
    deleteIntentsByProducedBy,
    insertGraphSnapshot,
    latestGraphSnapshot,
    listGraphSnapshots,
    pruneGraphSnapshots,
  };
}
