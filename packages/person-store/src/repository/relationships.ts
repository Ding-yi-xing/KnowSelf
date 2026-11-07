/**
 * `relationships` 仓库（DESIGN-13 §3.3 接口定稿，签名逐字）。
 * 三层 scope 建模「我 ×（群）×（他人）」（DESIGN-10 §3）；auto 写遇 `manual_locked=1`
 * **跳过并回报**，不抛错（§6.2 规则 2）——`skipped_locked` 是 mining 可观测性的硬要求（DESIGN-12 §9.2）。
 * 成员族（`chat_members`）实现在 `members.ts`，由本文件组合暴露——`RelationshipsRepo` 接口不变。
 * 注：§3.3 的 `replaceScope` 签名无 `now` 参数，内部 upsert 的 `updated_at` 取系统时间。
 */
import { randomUUID } from "node:crypto";
import type { PersonDb } from "../db";
import type {
  RelationshipAutoRow,
  RelationshipPatch,
  RelationshipRow,
} from "../types-derive";
import { createMembersRepo, type MembersRepo } from "./members";
import { dbBool } from "../types-derive";

/** SQLite 投影（0/1 整数）→ 领域行（boolean）。 */
type DbRelationshipRow = Omit<RelationshipRow, "manual_locked"> & { manual_locked: number };
function mapRow(row: DbRelationshipRow): RelationshipRow {
  return { ...row, manual_locked: dbBool(row.manual_locked) };
}
function mapRows(rows: DbRelationshipRow[]): RelationshipRow[] {
  return rows.map(mapRow);
}

export interface RelationshipsRepo extends MembersRepo {
  get(key: {
    subject_id: string;
    counterpart_id: string;
    scope_kind: RelationshipRow["scope_kind"];
    scope_id: string;
  }): RelationshipRow | null;
  listByCounterpart(
    counterpartId: string,
    q?: { subject_id?: string; scope_kind?: RelationshipRow["scope_kind"] },
  ): RelationshipRow[];
  listByScope(q: {
    scope_kind: RelationshipRow["scope_kind"];
    scope_id: string;
    subject_id?: string;
    limit?: number;
    offset?: number;
  }): RelationshipRow[];
  listBySubject(
    subjectId: string,
    q?: {
      scope_kind?: RelationshipRow["scope_kind"];
      relation_type?: RelationshipRow["relation_type"];
      min_closeness?: number;
      limit?: number;
      offset?: number;
    },
  ): RelationshipRow[];
  upsertAuto(
    row: RelationshipAutoRow,
    q: { produced_by: string; now: string },
  ): { relation_id: string; skipped_locked: boolean };
  replaceScope(q: {
    scope_kind: RelationshipRow["scope_kind"];
    scope_id: string;
    subject_id?: string;
    rows: readonly RelationshipAutoRow[];
    produced_by: string;
  }): { replaced: number; skipped_locked: number };
  updateManual(relationId: string, patch: RelationshipPatch, now: string): RelationshipRow;
  setManualLocked(relationId: string, locked: boolean, now: string): void;
  remove(relationId: string, now: string): void;
  countByType(subjectId?: string): Record<RelationshipRow["relation_type"], number>;
}

const RELATION_COLS = [
  "relation_id", "subject_id", "counterpart_id", "scope_kind", "scope_id",
  "relation_type", "direction", "closeness", "sentiment", "tags", "note",
  "evidence_ref", "source", "manual_locked", "produced_by", "created_at", "updated_at",
] as const;

const KEY_FILTER = `subject_id = ? AND counterpart_id = ? AND scope_kind = ? AND scope_id = ?`;

const UPSERT_SQL = `INSERT INTO relationships
    (${RELATION_COLS.join(", ")})
  VALUES (${RELATION_COLS.map(() => "?").join(", ")})
  ON CONFLICT(subject_id, counterpart_id, scope_kind, scope_id) DO UPDATE SET
    relation_type = excluded.relation_type,
    direction     = excluded.direction,
    closeness     = excluded.closeness,
    sentiment     = excluded.sentiment,
    tags          = excluded.tags,
    note          = excluded.note,
    evidence_ref  = excluded.evidence_ref,
    source        = excluded.source,
    produced_by   = excluded.produced_by,
    updated_at    = excluded.updated_at`;

function autoValues(row: RelationshipAutoRow, relationId: string): RelationshipRow {
  return {
    relation_id: relationId,
    subject_id: row.subject_id ?? "me",
    counterpart_id: row.counterpart_id,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id ?? "",
    relation_type: row.relation_type ?? "unknown",
    direction: row.direction ?? "bidirectional",
    closeness: row.closeness ?? 0.5,
    sentiment: row.sentiment ?? 0,
    tags: row.tags ?? "[]",
    note: row.note ?? "",
    evidence_ref: row.evidence_ref ?? "[]",
    source: "auto",
    manual_locked: false,
    produced_by: "",
    created_at: "",
    updated_at: "",
  };
}

export function createRelationshipsRepo(db: PersonDb): RelationshipsRepo {
  const get: RelationshipsRepo["get"] = (key) => {
    const row = db
      .prepare(`SELECT * FROM relationships WHERE ${KEY_FILTER}`)
      .get(key.subject_id, key.counterpart_id, key.scope_kind, key.scope_id) as
      | DbRelationshipRow
      | undefined;
    return row === undefined ? null : mapRow(row);
  };

  const listByCounterpart: RelationshipsRepo["listByCounterpart"] = (counterpartId, q = {}) => {
    const conditions = ["counterpart_id = ?"];
    const params: string[] = [counterpartId];
    if (q.subject_id !== undefined) {
      conditions.push("subject_id = ?");
      params.push(q.subject_id);
    }
    if (q.scope_kind !== undefined) {
      conditions.push("scope_kind = ?");
      params.push(q.scope_kind);
    }
    return mapRows(
      db
        .prepare(
          `SELECT * FROM relationships WHERE ${conditions.join(" AND ")}
           ORDER BY scope_kind ASC, scope_id ASC`,
        )
        .all(...params) as DbRelationshipRow[],
    );
  };

  const listByScope: RelationshipsRepo["listByScope"] = (q) => {
    const conditions = ["scope_kind = ?", "scope_id = ?"];
    const params: string[] = [q.scope_kind, q.scope_id];
    if (q.subject_id !== undefined) {
      conditions.push("subject_id = ?");
      params.push(q.subject_id);
    }
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return mapRows(
      db
        .prepare(
          `SELECT * FROM relationships WHERE ${conditions.join(" AND ")}
           ORDER BY closeness DESC, counterpart_id ASC${page}`,
        )
        .all(...params, ...pageParams) as DbRelationshipRow[],
    );
  };

  const listBySubject: RelationshipsRepo["listBySubject"] = (subjectId, q = {}) => {
    const conditions = ["subject_id = ?"];
    const params: (string | number)[] = [subjectId];
    if (q.scope_kind !== undefined) {
      conditions.push("scope_kind = ?");
      params.push(q.scope_kind);
    }
    if (q.relation_type !== undefined) {
      conditions.push("relation_type = ?");
      params.push(q.relation_type);
    }
    if (q.min_closeness !== undefined) {
      conditions.push("closeness >= ?");
      params.push(q.min_closeness);
    }
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return mapRows(
      db
        .prepare(
          `SELECT * FROM relationships WHERE ${conditions.join(" AND ")}
           ORDER BY closeness DESC, counterpart_id ASC${page}`,
        )
        .all(...params, ...pageParams) as DbRelationshipRow[],
    );
  };

  const upsertAuto: RelationshipsRepo["upsertAuto"] = (row, q) => {
    const existing = get({
      subject_id: row.subject_id ?? "me",
      counterpart_id: row.counterpart_id,
      scope_kind: row.scope_kind,
      scope_id: row.scope_id ?? "",
    });
    if (existing !== null && existing.manual_locked) {
      return { relation_id: existing.relation_id, skipped_locked: true };
    }
    const full = autoValues(row, randomUUID());
    db.prepare(UPSERT_SQL).run(
      full.relation_id, full.subject_id, full.counterpart_id, full.scope_kind, full.scope_id,
      full.relation_type, full.direction, full.closeness, full.sentiment, full.tags, full.note,
      full.evidence_ref, full.source, full.manual_locked ? 1 : 0, q.produced_by, q.now, q.now,
    );
    return { relation_id: full.relation_id, skipped_locked: false };
  };

  const replaceScope: RelationshipsRepo["replaceScope"] = (q) => {
    const conditions = ["scope_kind = ?", "scope_id = ?"];
    const params: string[] = [q.scope_kind, q.scope_id];
    if (q.subject_id !== undefined) {
      conditions.push("subject_id = ?");
      params.push(q.subject_id);
    }
    const locked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM relationships
          WHERE ${conditions.join(" AND ")} AND source = 'auto' AND manual_locked = 1`,
      )
      .get(...params) as { n: number };
    const removed = db
      .prepare(
        `DELETE FROM relationships
          WHERE ${conditions.join(" AND ")} AND source = 'auto' AND manual_locked = 0`,
      )
      .run(...params);
    let skipped = locked.n;
    for (const row of q.rows) {
      const result = upsertAuto(row, { produced_by: q.produced_by, now: new Date().toISOString() });
      if (result.skipped_locked) skipped += 1;
    }
    return { replaced: removed.changes, skipped_locked: skipped };
  };

  const updateManual: RelationshipsRepo["updateManual"] = (relationId, patch, now) => {
    const raw = db
      .prepare("SELECT * FROM relationships WHERE relation_id = ?")
      .get(relationId) as DbRelationshipRow | undefined;
    if (raw === undefined) throw new Error(`关系不存在: ${relationId}`);
    const existing = mapRow(raw);
    const merged: RelationshipRow = {
      ...existing,
      relation_type: patch.relation_type ?? existing.relation_type,
      direction: patch.direction ?? existing.direction,
      closeness: patch.closeness ?? existing.closeness,
      sentiment: patch.sentiment ?? existing.sentiment,
      tags: patch.tags ?? existing.tags,
      note: patch.note ?? existing.note,
      manual_locked: true,
      updated_at: now,
    };
    db.prepare(
      `UPDATE relationships SET relation_type = ?, direction = ?, closeness = ?, sentiment = ?,
              tags = ?, note = ?, manual_locked = 1, updated_at = ?
        WHERE relation_id = ?`,
    ).run(
      merged.relation_type, merged.direction, merged.closeness, merged.sentiment,
      merged.tags, merged.note, now, relationId,
    );
    return merged;
  };

  const setManualLocked: RelationshipsRepo["setManualLocked"] = (relationId, locked, now) => {
    db.prepare("UPDATE relationships SET manual_locked = ?, updated_at = ? WHERE relation_id = ?")
      .run(locked ? 1 : 0, now, relationId);
  };

  const remove: RelationshipsRepo["remove"] = (relationId, _now) => {
    db.prepare("DELETE FROM relationships WHERE relation_id = ?").run(relationId);
  };

  const countByType: RelationshipsRepo["countByType"] = (subjectId) => {
    const rows = db
      .prepare(
        `SELECT relation_type, COUNT(*) AS n FROM relationships
          ${subjectId === undefined ? "" : "WHERE subject_id = ?"}
          GROUP BY relation_type`,
      )
      .all(...(subjectId === undefined ? [] : [subjectId])) as {
      relation_type: RelationshipRow["relation_type"];
      n: number;
    }[];
    const result: Record<string, number> = {};
    for (const row of rows) result[row.relation_type] = row.n;
    return result as Record<RelationshipRow["relation_type"], number>;
  };

  return {
    get,
    listByCounterpart,
    listByScope,
    listBySubject,
    upsertAuto,
    replaceScope,
    updateManual,
    setManualLocked,
    remove,
    countByType,
    ...createMembersRepo(db),
  };
}
