/**
 * `aliases` 仓库（DESIGN-13 §3.2 接口定稿，签名逐字；本文件承载读族与单行写）。
 * 铁律（§5.1）：归并**只改 `aliases.person_id`**，不回改 `chat_messages`；本表**无 `manual_locked` 列**，
 * 人工别名走 `source='manual'`（§6.1）。归并族见 `alias-merge.ts`（§2.2 行预算拆分，接口不变）。
 */
import { randomUUID } from "node:crypto";
import type { PersonDb } from "../db";
import { AliasConflictError, PersonNotFoundError } from "../errors";
import type {
  AliasCandidateQuery,
  AliasExtractorInput,
  AliasInsert,
  AliasKind,
  AliasListQuery,
  AliasRow,
} from "../types";
import { createAliasMergeRepo } from "./alias-merge";

type AliasSqlRow = Omit<AliasRow, "is_primary"> & { is_primary: number };

export interface AliasesRepo {
  listByPerson(personId: string): AliasRow[];
  findByUid(platform: string, alias: string): AliasRow | null;
  resolvePersonId(platform: string, senderId: string): string | null;
  findCandidates(q: AliasCandidateQuery): AliasRow[];
  insert(row: AliasInsert, now: string): AliasRow;
  upsertExtractor(input: AliasExtractorInput): { alias_id: string; created: boolean };
  moveToPerson(aliasIds: readonly string[], personId: string, now: string): { moved: number };
  setPrimary(aliasId: string, now: string): void;
  remove(aliasId: string, now: string): void;
  listAll(q?: AliasListQuery): AliasRow[];
}

function mapAlias(row: AliasSqlRow): AliasRow {
  return { ...row, is_primary: row.is_primary === 1 };
}

function whereOf(conditions: readonly string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

export function createAliasesRepo(db: PersonDb): AliasesRepo {
  const getById = (aliasId: string): AliasRow | null => {
    const row = db.prepare("SELECT * FROM aliases WHERE alias_id = ?").get(aliasId) as
      | AliasSqlRow
      | undefined;
    return row ? mapAlias(row) : null;
  };

  const findBy = (platform: string, aliasKind: AliasKind, alias: string): AliasRow[] =>
    (
      db
        .prepare(
          `SELECT * FROM aliases
           WHERE platform = ? AND alias_kind = ? AND alias = ? ORDER BY created_at ASC`,
        )
        .all(platform, aliasKind, alias) as AliasSqlRow[]
    ).map(mapAlias);

  const listByPerson = (personId: string): AliasRow[] =>
    (
      db
        .prepare(
          "SELECT * FROM aliases WHERE person_id = ? ORDER BY is_primary DESC, created_at ASC",
        )
        .all(personId) as AliasSqlRow[]
    ).map(mapAlias);

  const findByUid = (platform: string, alias: string): AliasRow | null =>
    findBy(platform, "platform_uid", alias)[0] ?? null;

  const resolvePersonId = (platform: string, senderId: string): string | null =>
    findByUid(platform, senderId)?.person_id ?? null;

  const insert = (row: AliasInsert, now: string): AliasRow => {
    db.prepare(
      `INSERT INTO aliases
         (alias_id, person_id, platform, alias_kind, alias, normalized, is_primary, confidence,
          source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.alias_id,
      row.person_id,
      row.platform,
      row.alias_kind,
      row.alias,
      row.normalized,
      row.is_primary === true ? 1 : 0,
      row.confidence ?? 1.0,
      row.source,
      now,
      now,
    );
    const created = getById(row.alias_id);
    if (!created) {
      throw new PersonNotFoundError(`aliases 写入后不可见: ${row.alias_id}`, row.alias_id);
    }
    return created;
  };

  /** 同 `(platform, alias_kind, alias)` 已属于同一人 → 复用（不新建）；撞 `platform_uid` 唯一键 → 抛错（§5.3）。 */
  const upsertExtractor = (input: AliasExtractorInput): { alias_id: string; created: boolean } => {
    const existing = findBy(input.platform, input.alias_kind, input.alias);
    const samePerson = existing.find((row) => row.person_id === input.person_id);
    if (samePerson) return { alias_id: samePerson.alias_id, created: false };
    if (existing.length > 0 && input.alias_kind === "platform_uid") {
      throw new AliasConflictError(
        `平台 ID 已属于其他人物: ${input.platform}/${input.alias}`,
        existing[0]?.alias_id,
      );
    }
    const created = insert(
      {
        alias_id: randomUUID(),
        person_id: input.person_id,
        platform: input.platform,
        alias_kind: input.alias_kind,
        alias: input.alias,
        normalized: input.normalized,
        confidence: input.confidence,
        source: "extractor",
      },
      input.now,
    );
    return { alias_id: created.alias_id, created: true };
  };

  const remove = (aliasId: string, _now: string): void => {
    db.prepare("DELETE FROM aliases WHERE alias_id = ?").run(aliasId);
  };

  const listAll = (q: AliasListQuery = {}): AliasRow[] => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (q.platform !== undefined) {
      conditions.push("platform = ?");
      params.push(q.platform);
    }
    const limit = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const page = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    const rows = db
      .prepare(
        `SELECT * FROM aliases ${whereOf(conditions)} ORDER BY person_id ASC, created_at ASC${limit}`,
      )
      .all(...params, ...page) as AliasSqlRow[];
    return rows.map(mapAlias);
  };

  return {
    listByPerson,
    findByUid,
    resolvePersonId,
    ...createAliasMergeRepo(db),
    insert,
    upsertExtractor,
    remove,
    listAll,
  };
}
