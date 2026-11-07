/**
 * `person_merges` 仓库（DESIGN-13 §3.1 的「归并审计」族）。
 * 为什么单拆：§2.2 行预算纪律——`repository/persons.ts` 超 200 行时按「操作族」再拆；
 * `PersonsRepo` 仍原样暴露这些方法（由 `persons.ts` 组合）。
 */
import type { PersonDb } from "../db";
import { PersonNotFoundError } from "../errors";
import type { MergeListQuery, PersonMergeInsert, PersonMergeRow } from "../types";
import type { PersonsRepo } from "./persons";

export function createPersonMergesRepo(
  db: PersonDb,
): Pick<PersonsRepo, "insertMerge" | "getMerge" | "listMerges" | "markMergeUndone"> {
  const getMerge = (mergeId: string): PersonMergeRow | null =>
    (db.prepare("SELECT * FROM person_merges WHERE merge_id = ?").get(mergeId) as
      | PersonMergeRow
      | undefined) ?? null;

  const insertMerge = (row: PersonMergeInsert): PersonMergeRow => {
    db.prepare(
      `INSERT INTO person_merges
         (merge_id, from_person_id, into_person_id, reason, evidence, performed_by, confidence,
          merged_at, undone_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.merge_id,
      row.from_person_id,
      row.into_person_id,
      row.reason ?? "",
      row.evidence ?? "[]",
      row.performed_by,
      row.confidence ?? 1.0,
      row.merged_at,
      row.undone_at ?? null,
    );
    const created = getMerge(row.merge_id);
    if (!created) {
      throw new PersonNotFoundError(`person_merges 写入后不可见: ${row.merge_id}`, row.merge_id);
    }
    return created;
  };

  const listMerges = (q: MergeListQuery = {}): PersonMergeRow[] => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.from_person_id !== undefined) {
      conditions.push("from_person_id = ?");
      params.push(q.from_person_id);
    }
    if (q.into_person_id !== undefined) {
      conditions.push("into_person_id = ?");
      params.push(q.into_person_id);
    }
    if (q.undone !== undefined) {
      conditions.push(q.undone ? "undone_at IS NOT NULL" : "undone_at IS NULL");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = q.limit === undefined ? "" : " LIMIT ?";
    const page = q.limit === undefined ? [] : [q.limit];
    return db
      .prepare(`SELECT * FROM person_merges ${where} ORDER BY merged_at DESC${limit}`)
      .all(...params, ...page) as PersonMergeRow[];
  };

  const markMergeUndone = (mergeId: string, evidencePatch: string, now: string): void => {
    db.prepare("UPDATE person_merges SET undone_at = ?, evidence = ? WHERE merge_id = ?").run(
      now,
      evidencePatch,
      mergeId,
    );
  };

  return { insertMerge, getMerge, listMerges, markMergeUndone };
}
