/**
 * `persons` 仓库（DESIGN-13 §3.1 接口定稿，签名逐字；本文件承载读族与组合）。
 * 纪律：只做 SQL 与行映射；业务判断（归并裁决 / 落档顺序）在 `src/*.ts`。
 * 写族见 `person-writes.ts`、归并审计见 `person-merges.ts`（§2.2 行预算拆分，接口不变）。
 */
import type { PersonDb } from "../db";
import { SELF_PERSON_ID } from "../ddl/migrations";
import { PersonNotFoundError } from "../errors";
import type {
  AutoWriteResult,
  MergeListQuery,
  PersonInsert,
  PersonListQuery,
  PersonMergeInsert,
  PersonMergeRow,
  PersonPatch,
  PersonRow,
  PersonStatsPatch,
  PersonStatus,
  SubjectKind,
} from "../types";
import { createPersonMergesRepo } from "./person-merges";
import { createPersonWritesRepo } from "./person-writes";

type PersonSqlRow = Omit<
  PersonRow,
  "manual_locked" | "direct_msg_count" | "direct_conv_count" | "direct_first_msg_at" | "direct_last_msg_at"
> & {
  manual_locked: number;
  direct_msg_count: number;
  direct_conv_count: number;
  direct_first_ms: number | null;
  direct_last_ms: number | null;
};

/** 直聊统计子查询：只统计 `chat_conversations.kind='direct'` 的消息。 */
const DIRECT_AGG_SQL = `SELECT v.sender_person_id AS pid,
        COUNT(*) AS direct_msg_count,
        COUNT(DISTINCT v.conversation_id) AS direct_conv_count,
        MIN(v.ts_ms) AS direct_first_ms,
        MAX(v.ts_ms) AS direct_last_ms
   FROM v_chat_messages v
   JOIN chat_conversations c ON c.conversation_id = v.conversation_id
  WHERE c.kind = 'direct' AND v.sender_person_id IS NOT NULL
  GROUP BY v.sender_person_id`;

function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export interface PersonsRepo {
  // ── 读 ──
  get(personId: string): PersonRow | null;
  getOrThrow(personId: string): PersonRow;
  getSelf(): PersonRow;
  list(q?: PersonListQuery): PersonRow[];
  count(q?: { subject_kind?: SubjectKind; status?: PersonStatus }): number;
  listMerged(intoPersonId: string): PersonRow[];

  // ── 写 ──
  insert(row: PersonInsert, now: string): PersonRow;
  /**
   * 新建一个**人工**人物（W-3 恢复 CRUD 的最小写入口）。
   *
   * 与 `insert` 的区别：`person_id` 由内部生成、`subject_kind` 固定 `'contact'`、
   * `manual_locked=1`（人工建的人不该被自动写覆盖），`note` 落 `remark` 列。
   *
   * @param input.display_name 显示名（去空白后非空；调用方负责校验）
   * @param input.note 备注（可选，落 `remark`）
   * @param input.person_id 仅测试注入用；生产不传（内部 `randomUUID`）
   * @param now ISO8601 时间
   * @returns 写后行
   */
  createManualPerson(
    input: { display_name: string; note?: string; person_id?: string },
    now: string,
  ): PersonRow;
  updateManual(personId: string, patch: PersonPatch, now: string): PersonRow;
  updateAutoStats(personId: string, stats: PersonStatsPatch, now: string): AutoWriteResult;
  updateProfileJson(
    personId: string,
    profileJson: string,
    producedBy: string,
    now: string,
  ): AutoWriteResult;
  setManualLocked(personId: string, locked: boolean, now: string): void;

  // ── 归并审计（person_merges）──
  insertMerge(row: PersonMergeInsert): PersonMergeRow;
  getMerge(mergeId: string): PersonMergeRow | null;
  listMerges(q?: MergeListQuery): PersonMergeRow[];
  markMergeUndone(mergeId: string, evidencePatch: string, now: string): void;
  markMerged(fromId: string, intoId: string, now: string): void;
  unmarkMerged(personId: string, now: string): void;

  // ── 重建 ──
  recomputeStats(personId: string, now: string): PersonRow;
  /**
   * 批量重算派生统计（一条 GROUP BY + 事务批量 UPDATE）。
   * 导入后调用一次，否则 UI 上的 `msg_count` 全是 0。
   */
  recomputeAllStats(now: string): { updated: number };
}

function mapPerson(row: PersonSqlRow): PersonRow {
  const { direct_first_ms, direct_last_ms, ...rest } = row;
  return {
    ...rest,
    manual_locked: row.manual_locked === 1,
    direct_first_msg_at: isoOrNull(direct_first_ms),
    direct_last_msg_at: isoOrNull(direct_last_ms),
  };
}

function personFilter(q: { subject_kind?: SubjectKind; status?: PersonStatus; keyword?: string }): {
  where: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (q.subject_kind !== undefined) {
    conditions.push("subject_kind = ?");
    params.push(q.subject_kind);
  }
  if (q.status !== undefined) {
    conditions.push("status = ?");
    params.push(q.status);
  }
  if (q.keyword !== undefined) {
    conditions.push("(display_name LIKE ? OR remark LIKE ?)");
    params.push(`%${q.keyword}%`, `%${q.keyword}%`);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function pageClause(
  limit: number | undefined,
  offset: number | undefined,
): { sql: string; params: number[] } {
  return limit === undefined
    ? { sql: "", params: [] }
    : { sql: " LIMIT ? OFFSET ?", params: [limit, offset ?? 0] };
}

export function createPersonsRepo(db: PersonDb): PersonsRepo {
  const get = (personId: string): PersonRow | null => {
    const row = db
      .prepare(
        `SELECT p.*,
                COALESCE(d.direct_msg_count, 0) AS direct_msg_count,
                COALESCE(d.direct_conv_count, 0) AS direct_conv_count,
                d.direct_first_ms, d.direct_last_ms
           FROM persons p
           LEFT JOIN (${DIRECT_AGG_SQL}) d ON d.pid = p.person_id
          WHERE p.person_id = ?`,
      )
      .get(personId) as PersonSqlRow | undefined;
    return row ? mapPerson(row) : null;
  };

  const getOrThrow = (personId: string): PersonRow => {
    const row = get(personId);
    if (!row) throw new PersonNotFoundError(`人物不存在: ${personId}`, personId);
    return row;
  };

  const list = (q: PersonListQuery = {}): PersonRow[] => {
    const filter = personFilter(q);
    const page = pageClause(q.limit, q.offset);
    const directOnly = q.direct_only === true;
    const baseWhere = filter.where.replace(/^WHERE /, "");
    const conditions = [baseWhere, ...(directOnly ? ["d.pid IS NOT NULL"] : [])]
      .filter((item) => item !== "");
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = directOnly
      ? "d.direct_last_ms DESC, p.person_id ASC"
      : "p.last_msg_at DESC, p.person_id ASC";
    const rows = db
      .prepare(
        `SELECT p.*,
                COALESCE(d.direct_msg_count, 0) AS direct_msg_count,
                COALESCE(d.direct_conv_count, 0) AS direct_conv_count,
                d.direct_first_ms, d.direct_last_ms
           FROM persons p
           LEFT JOIN (${DIRECT_AGG_SQL}) d ON d.pid = p.person_id
           ${where}
          ORDER BY ${order}${page.sql}`,
      )
      .all(...filter.params, ...page.params) as PersonSqlRow[];
    return rows.map(mapPerson);
  };

  const count = (q: { subject_kind?: SubjectKind; status?: PersonStatus } = {}): number => {
    const filter = personFilter(q);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM persons ${filter.where}`)
      .get(...filter.params) as { n: number };
    return row.n;
  };

  const listMerged = (intoPersonId: string): PersonRow[] =>
    (
      db
        .prepare(
          "SELECT * FROM persons WHERE status = 'merged' AND merged_into = ? ORDER BY person_id ASC",
        )
        .all(intoPersonId) as PersonSqlRow[]
    ).map(mapPerson);

  const writes = createPersonWritesRepo(db, getOrThrow);
  const merges = createPersonMergesRepo(db);

  /** 空库兜底（DESIGN-13 §3.1 / §7.5）：'me' 缺失则补建，已存在则原样返回。 */
  const getSelf = (): PersonRow =>
    get(SELF_PERSON_ID) ??
    writes.insert(
      { person_id: SELF_PERSON_ID, subject_kind: "self", display_name: "我" },
      new Date().toISOString(),
    );

  return { get, getOrThrow, getSelf, list, count, listMerged, ...writes, ...merges };
}
