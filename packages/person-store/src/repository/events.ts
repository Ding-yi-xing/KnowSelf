/**
 * `events` 仓库（DESIGN-13 §3.4 接口定稿，签名逐字）：`events` + `person_facts`。
 * auto 写遇 `manual_locked=1` 跳过并回报（§6.2 规则 2）；人工入口写后即锁定。
 * 重建语义（D3）：`deleteByProducedBy` / `deleteFactsByProducedBy` 只删
 * `produced_by <> :not` 且未锁定的行——版本位变化后重算不触碰人工数据。
 */
import { randomUUID } from "node:crypto";
import type { PersonDb } from "../db";
import {
  dbBool,
  type EventAutoRow,
  type EventInsert,
  type EventPatch,
  type EventRow,
  type FactRow,
  type FactUpsert,
} from "../types-derive";

/** SQLite 投影（0/1 整数）→ 领域行（boolean）。 */
type DbEventRow = Omit<EventRow, "manual_locked"> & { manual_locked: number };
type DbFactRow = Omit<FactRow, "manual_locked"> & { manual_locked: number };
function mapEvent(row: DbEventRow): EventRow {
  return { ...row, manual_locked: dbBool(row.manual_locked) };
}
function mapFact(row: DbFactRow): FactRow {
  return { ...row, manual_locked: dbBool(row.manual_locked) };
}

export interface EventsRepo {
  // ── events ──
  get(eventId: string): EventRow | null;
  timeline(
    personId: string,
    q?: {
      from_date?: string;
      to_date?: string;
      min_importance?: number;
      limit?: number;
      offset?: number;
    },
  ): EventRow[];
  list(q?: {
    subject_id?: string;
    person_id?: string;
    scope_kind?: EventRow["scope_kind"];
    conversation_id?: string;
    source_kind?: EventRow["source_kind"];
    from_date?: string;
    to_date?: string;
    keyword?: string;
    limit?: number;
    offset?: number;
  }): EventRow[];
  insertManual(row: EventInsert, now: string): EventRow;
  upsertAuto(
    row: EventAutoRow,
    q: { produced_by: string; now: string },
  ): { event_id: string; skipped_locked: boolean };
  updateManual(eventId: string, patch: EventPatch, now: string): EventRow;
  setManualLocked(eventId: string, locked: boolean, now: string): void;
  deleteByProducedBy(q: { produced_by_not: string; person_id?: string }): { deleted: number };

  // ── person_facts ──
  listFacts(q: {
    person_id?: string;
    fact_kind?: FactRow["fact_kind"];
    scope_kind?: FactRow["scope_kind"];
    limit?: number;
    offset?: number;
  }): FactRow[];
  upsertFacts(rows: readonly FactUpsert[]): { upserted: number; skipped_locked: number };
  deleteFactsByProducedBy(q: { produced_by_not: string; person_id?: string }): {
    deleted: number;
  };
  setFactManualLocked(factId: string, locked: boolean, now: string): void;
}

const EVENT_COLS = [
  "event_id", "subject_id", "person_id", "conversation_id", "scope_kind", "event_kind",
  "title", "summary", "event_date", "occurred_at", "importance", "tags", "source_kind",
  "source_ref", "confidence", "manual_locked", "produced_by", "created_at", "updated_at",
] as const;

const FACT_COLS = [
  "fact_id", "person_id", "scope_kind", "scope_id", "fact_kind", "fact_key", "fact_value",
  "confidence", "source_ref", "produced_by", "manual_locked", "created_at", "updated_at",
] as const;

const EVENT_UPSERT_SQL = `INSERT INTO events (${EVENT_COLS.join(", ")})
  VALUES (${EVENT_COLS.map(() => "?").join(", ")})
  ON CONFLICT(event_id) DO UPDATE SET
    subject_id      = excluded.subject_id,
    person_id       = excluded.person_id,
    conversation_id = excluded.conversation_id,
    scope_kind      = excluded.scope_kind,
    event_kind      = excluded.event_kind,
    title           = excluded.title,
    summary         = excluded.summary,
    event_date      = excluded.event_date,
    occurred_at     = excluded.occurred_at,
    importance      = excluded.importance,
    tags            = excluded.tags,
    source_kind     = excluded.source_kind,
    source_ref      = excluded.source_ref,
    confidence      = excluded.confidence,
    produced_by     = excluded.produced_by,
    updated_at      = excluded.updated_at`;

function eventAutoValues(row: EventAutoRow, eventId: string): EventRow {
  return {
    event_id: eventId,
    subject_id: row.subject_id ?? "me",
    person_id: row.person_id ?? null,
    conversation_id: row.conversation_id ?? null,
    scope_kind: row.scope_kind ?? "me",
    event_kind: row.event_kind ?? "other",
    title: row.title,
    summary: row.summary ?? "",
    event_date: row.event_date,
    occurred_at: row.occurred_at ?? null,
    importance: row.importance ?? 3,
    tags: row.tags ?? "[]",
    source_kind: "message",
    source_ref: row.source_ref ?? "[]",
    confidence: row.confidence ?? 1.0,
    manual_locked: false,
    produced_by: "",
    created_at: "",
    updated_at: "",
  };
}

export function createEventsRepo(db: PersonDb): EventsRepo {
  const get = (eventId: string): EventRow | null => {
    const row = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as
      | DbEventRow
      | undefined;
    return row === undefined ? null : mapEvent(row);
  };

  const timeline: EventsRepo["timeline"] = (personId, q = {}) => {
    const conditions = ["person_id = ?"];
    const params: (string | number)[] = [personId];
    if (q.from_date !== undefined) {
      conditions.push("event_date >= ?");
      params.push(q.from_date);
    }
    if (q.to_date !== undefined) {
      conditions.push("event_date <= ?");
      params.push(q.to_date);
    }
    if (q.min_importance !== undefined) {
      conditions.push("importance >= ?");
      params.push(q.min_importance);
    }
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return (
      db
        .prepare(
          `SELECT * FROM events WHERE ${conditions.join(" AND ")}
           ORDER BY event_date DESC, event_id ASC${page}`,
        )
        .all(...params, ...pageParams) as DbEventRow[]
    ).map(mapEvent);
  };

  const list: EventsRepo["list"] = (q = {}) => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.subject_id !== undefined) {
      conditions.push("subject_id = ?");
      params.push(q.subject_id);
    }
    if (q.person_id !== undefined) {
      conditions.push("person_id = ?");
      params.push(q.person_id);
    }
    if (q.scope_kind !== undefined) {
      conditions.push("scope_kind = ?");
      params.push(q.scope_kind);
    }
    if (q.conversation_id !== undefined) {
      conditions.push("conversation_id = ?");
      params.push(q.conversation_id);
    }
    if (q.source_kind !== undefined) {
      conditions.push("source_kind = ?");
      params.push(q.source_kind);
    }
    if (q.from_date !== undefined) {
      conditions.push("event_date >= ?");
      params.push(q.from_date);
    }
    if (q.to_date !== undefined) {
      conditions.push("event_date <= ?");
      params.push(q.to_date);
    }
    if (q.keyword !== undefined) {
      conditions.push("title LIKE ?");
      params.push(`%${q.keyword}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return (
      db
        .prepare(
          `SELECT * FROM events ${where} ORDER BY event_date DESC, event_id ASC${page}`,
        )
        .all(...params, ...pageParams) as DbEventRow[]
    ).map(mapEvent);
  };

  const insertManual: EventsRepo["insertManual"] = (row, now) => {
    const full: EventRow = {
      event_id: randomUUID(),
      subject_id: row.subject_id ?? "me",
      person_id: row.person_id ?? null,
      conversation_id: row.conversation_id ?? null,
      scope_kind: row.scope_kind ?? "me",
      event_kind: row.event_kind ?? "other",
      title: row.title,
      summary: row.summary ?? "",
      event_date: row.event_date,
      occurred_at: row.occurred_at ?? null,
      importance: row.importance ?? 3,
      tags: row.tags ?? "[]",
      source_kind: "manual",
      source_ref: row.source_ref ?? "[]",
      confidence: row.confidence ?? 1.0,
      manual_locked: true,
      produced_by: "",
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      `INSERT INTO events (${EVENT_COLS.join(", ")})
       VALUES (${EVENT_COLS.map(() => "?").join(", ")})`,
    ).run(
      full.event_id, full.subject_id, full.person_id, full.conversation_id, full.scope_kind,
      full.event_kind, full.title, full.summary, full.event_date, full.occurred_at,
      full.importance, full.tags, full.source_kind, full.source_ref, full.confidence,
      full.manual_locked ? 1 : 0, full.produced_by, full.created_at, full.updated_at,
    );
    return full;
  };

  const upsertAuto: EventsRepo["upsertAuto"] = (row, q) => {
    const eventId = row.event_id ?? randomUUID();
    const existing = row.event_id === undefined ? null : get(row.event_id);
    if (existing !== null && existing.manual_locked) {
      return { event_id: existing.event_id, skipped_locked: true };
    }
    const full = eventAutoValues(row, eventId);
    db.prepare(EVENT_UPSERT_SQL).run(
      full.event_id, full.subject_id, full.person_id, full.conversation_id, full.scope_kind,
      full.event_kind, full.title, full.summary, full.event_date, full.occurred_at,
      full.importance, full.tags, full.source_kind, full.source_ref, full.confidence,
      full.manual_locked ? 1 : 0, q.produced_by, q.now, q.now,
    );
    return { event_id: full.event_id, skipped_locked: false };
  };

  const updateManual: EventsRepo["updateManual"] = (eventId, patch, now) => {
    const existing = get(eventId);
    if (existing === null) throw new Error(`事件不存在: ${eventId}`);
    const merged: EventRow = {
      ...existing,
      event_kind: patch.event_kind ?? existing.event_kind,
      title: patch.title ?? existing.title,
      summary: patch.summary ?? existing.summary,
      event_date: patch.event_date ?? existing.event_date,
      occurred_at: patch.occurred_at ?? existing.occurred_at,
      importance: patch.importance ?? existing.importance,
      tags: patch.tags ?? existing.tags,
      manual_locked: true,
      updated_at: now,
    };
    db.prepare(
      `UPDATE events SET event_kind = ?, title = ?, summary = ?, event_date = ?,
              occurred_at = ?, importance = ?, tags = ?, manual_locked = 1, updated_at = ?
        WHERE event_id = ?`,
    ).run(
      merged.event_kind, merged.title, merged.summary, merged.event_date, merged.occurred_at,
      merged.importance, merged.tags, now, eventId,
    );
    return merged;
  };

  const setManualLocked: EventsRepo["setManualLocked"] = (eventId, locked, now) => {
    db.prepare("UPDATE events SET manual_locked = ?, updated_at = ? WHERE event_id = ?")
      .run(locked ? 1 : 0, now, eventId);
  };

  const deleteByProducedBy: EventsRepo["deleteByProducedBy"] = (q) => {
    const conditions = ["produced_by <> ?", "manual_locked = 0"];
    const params: string[] = [q.produced_by_not];
    if (q.person_id !== undefined) {
      conditions.push("person_id = ?");
      params.push(q.person_id);
    }
    const result = db
      .prepare(`DELETE FROM events WHERE ${conditions.join(" AND ")}`)
      .run(...params);
    return { deleted: result.changes };
  };

  const listFacts: EventsRepo["listFacts"] = (q) => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.person_id !== undefined) {
      conditions.push("person_id = ?");
      params.push(q.person_id);
    }
    if (q.fact_kind !== undefined) {
      conditions.push("fact_kind = ?");
      params.push(q.fact_kind);
    }
    if (q.scope_kind !== undefined) {
      conditions.push("scope_kind = ?");
      params.push(q.scope_kind);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return (
      db
        .prepare(
          `SELECT * FROM person_facts ${where} ORDER BY person_id ASC, fact_kind ASC, fact_id ASC${page}`,
        )
        .all(...params, ...pageParams) as DbFactRow[]
    ).map(mapFact);
  };

  const upsertFacts: EventsRepo["upsertFacts"] = (rows) => {
    let upserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const existing = db
        .prepare("SELECT * FROM person_facts WHERE fact_id = ?")
        .get(row.fact_id) as DbFactRow | undefined;
      if (existing !== undefined && existing.manual_locked === 1) {
        skipped += 1;
        continue;
      }
      const now = new Date().toISOString();
      const full: FactRow = {
        fact_id: row.fact_id,
        person_id: row.person_id,
        scope_kind: row.scope_kind ?? "global",
        scope_id: row.scope_id ?? "",
        fact_kind: row.fact_kind,
        fact_key: row.fact_key ?? "",
        fact_value: row.fact_value,
        confidence: row.confidence ?? 1.0,
        source_ref: row.source_ref ?? "[]",
        produced_by: row.produced_by ?? "",
        manual_locked: false,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      upserted += db
        .prepare(
          `INSERT INTO person_facts (${FACT_COLS.join(", ")})
           VALUES (${FACT_COLS.map(() => "?").join(", ")})
           ON CONFLICT(fact_id) DO UPDATE SET
             person_id    = excluded.person_id,
             scope_kind   = excluded.scope_kind,
             scope_id     = excluded.scope_id,
             fact_kind    = excluded.fact_kind,
             fact_key     = excluded.fact_key,
             fact_value   = excluded.fact_value,
             confidence   = excluded.confidence,
             source_ref   = excluded.source_ref,
             produced_by  = excluded.produced_by,
             updated_at   = excluded.updated_at`,
        )
        .run(
          full.fact_id, full.person_id, full.scope_kind, full.scope_id, full.fact_kind,
          full.fact_key, full.fact_value, full.confidence, full.source_ref, full.produced_by,
          full.manual_locked ? 1 : 0, full.created_at, full.updated_at,
        ).changes;
    }
    return { upserted, skipped_locked: skipped };
  };

  const deleteFactsByProducedBy: EventsRepo["deleteFactsByProducedBy"] = (q) => {
    const conditions = ["produced_by <> ?", "manual_locked = 0"];
    const params: string[] = [q.produced_by_not];
    if (q.person_id !== undefined) {
      conditions.push("person_id = ?");
      params.push(q.person_id);
    }
    const result = db
      .prepare(`DELETE FROM person_facts WHERE ${conditions.join(" AND ")}`)
      .run(...params);
    return { deleted: result.changes };
  };

  const setFactManualLocked: EventsRepo["setFactManualLocked"] = (factId, locked, now) => {
    db.prepare("UPDATE person_facts SET manual_locked = ?, updated_at = ? WHERE fact_id = ?")
      .run(locked ? 1 : 0, now, factId);
  };

  return {
    get,
    timeline,
    list,
    insertManual,
    upsertAuto,
    updateManual,
    setManualLocked,
    deleteByProducedBy,
    listFacts,
    upsertFacts,
    deleteFactsByProducedBy,
    setFactManualLocked,
  };
}
