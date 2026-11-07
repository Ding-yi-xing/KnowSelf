/**
 * `aliases` 归并族（DESIGN-13 §3.2 的 `findCandidates` / `moveToPerson` / `setPrimary`；§5 归并算法用）。
 * 为什么单拆：§2.2 行预算纪律——`repository/aliases.ts` 超 200 行时按「操作族」再拆；
 * `AliasesRepo` 仍原样暴露这些方法（由 `aliases.ts` 组合）。
 */
import type { PersonDb } from "../db";
import { AliasConflictError, PersonNotFoundError } from "../errors";
import type { AliasCandidateQuery, AliasRow } from "../types";
import type { AliasesRepo } from "./aliases";

type AliasSqlRow = Omit<AliasRow, "is_primary"> & { is_primary: number };

export function createAliasMergeRepo(
  db: PersonDb,
): Pick<AliasesRepo, "findCandidates" | "moveToPerson" | "setPrimary"> {
  const findCandidates = (q: AliasCandidateQuery): AliasRow[] => {
    const conditions: string[] = ["normalized = ?", "platform = ?"];
    const params: (string | number)[] = [q.normalized, q.platform];
    if (q.kinds !== undefined && q.kinds.length > 0) {
      conditions.push(`alias_kind IN (${q.kinds.map(() => "?").join(", ")})`);
      params.push(...q.kinds);
    }
    if (q.excludePersonId !== undefined) {
      conditions.push("person_id <> ?");
      params.push(q.excludePersonId);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const rows = db
      .prepare(`SELECT * FROM aliases ${where} ORDER BY confidence DESC, alias_id ASC LIMIT ?`)
      .all(...params, q.limit ?? 50) as AliasSqlRow[];
    return rows.map((row) => ({ ...row, is_primary: row.is_primary === 1 }));
  };

  const moveToPerson = (
    aliasIds: readonly string[],
    personId: string,
    now: string,
  ): { moved: number } => {
    if (aliasIds.length === 0) return { moved: 0 };
    const placeholders = aliasIds.map(() => "?").join(", ");
    try {
      const result = db
        .prepare(
          `UPDATE aliases SET person_id = ?, updated_at = ? WHERE alias_id IN (${placeholders})`,
        )
        .run(personId, now, ...aliasIds);
      return { moved: result.changes };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AliasConflictError(`别名迁移撞唯一键: ${personId}`, personId);
      }
      throw error;
    }
  };

  /** 一个人的 `is_primary` 至多一行：先清旧、再置新（单事务）。 */
  const setPrimary = (aliasId: string, now: string): void => {
    const row = db.prepare("SELECT person_id FROM aliases WHERE alias_id = ?").get(aliasId) as
      | { person_id: string }
      | undefined;
    if (!row) throw new PersonNotFoundError(`别名不存在: ${aliasId}`, aliasId);
    db.transaction(() => {
      db.prepare(
        "UPDATE aliases SET is_primary = 0, updated_at = ? WHERE person_id = ? AND is_primary = 1",
      ).run(now, row.person_id);
      db.prepare("UPDATE aliases SET is_primary = 1, updated_at = ? WHERE alias_id = ?").run(
        now,
        aliasId,
      );
    })();
  };

  return { findCandidates, moveToPerson, setPrimary };
}
