/**
 * `persons` 写入族（DESIGN-13 §3.1 的写方法）。为什么单拆：§2.2 行预算纪律——
 * `repository/persons.ts` 超 200 行时按「操作族」再拆；`PersonsRepo` 仍原样暴露（由 `persons.ts` 组合）。
 * 锁定避让（§6.2 规则 2）：自动写遇 `manual_locked=1` **跳过并回报 `skipped_locked`，不抛错**。
 */
import { randomUUID } from "node:crypto";
import { setPersonMeta, type PersonDb } from "../db";
import type {
  AutoWriteResult,
  PersonInsert,
  PersonPatch,
  PersonRow,
  PersonStatsPatch,
} from "../types";
import type { PersonsRepo } from "./persons";

const PROFILE_PRODUCED_BY_KEY = "produced_by.profile";

type Writes = Pick<
  PersonsRepo,
  | "insert"
  | "createManualPerson"
  | "updateManual"
  | "updateAutoStats"
  | "updateProfileJson"
  | "setManualLocked"
  | "markMerged"
  | "unmarkMerged"
  | "recomputeStats"
  | "recomputeAllStats"
>;

function makeSetter(): {
  sets: string[];
  params: (string | number | null)[];
  set: (column: string, value: string | number | null) => void;
} {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  return {
    sets,
    params,
    set(column, value) {
      sets.push(`${column} = ?`);
      params.push(value);
    },
  };
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function createPersonWritesRepo(
  db: PersonDb,
  getOrThrow: (personId: string) => PersonRow,
): Writes {
  const insert = (row: PersonInsert, now: string): PersonRow => {
    db.prepare(
      `INSERT INTO persons
         (person_id, subject_kind, display_name, remark, sort_key, avatar_ref, status, merged_into,
          first_msg_at, last_msg_at, msg_count, conv_count, profile_json, manual_locked,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.person_id,
      row.subject_kind,
      row.display_name,
      row.remark ?? "",
      row.sort_key ?? "",
      row.avatar_ref ?? null,
      row.status ?? "active",
      row.merged_into ?? null,
      row.first_msg_at ?? null,
      row.last_msg_at ?? null,
      row.msg_count ?? 0,
      row.conv_count ?? 0,
      row.profile_json ?? "{}",
      row.manual_locked === true ? 1 : 0,
      now,
      now,
    );
    return getOrThrow(row.person_id);
  };

  /**
   * 新建人工人物（见 `PersonsRepo.createManualPerson` 注释）。
   *
   * 为什么 `manual_locked=1`：人工建的人一旦被 mining 的自动写覆盖，等于用户的编辑白做。
   */
  const createManualPerson = (
    input: { display_name: string; note?: string; person_id?: string },
    now: string,
  ): PersonRow =>
    insert(
      {
        person_id: input.person_id ?? randomUUID(),
        subject_kind: "contact",
        display_name: input.display_name,
        remark: input.note ?? "",
        manual_locked: true,
        status: "active",
      },
      now,
    );

  const updateManual = (personId: string, patch: PersonPatch, now: string): PersonRow => {
    getOrThrow(personId);
    const w = makeSetter();
    if (patch.display_name !== undefined) w.set("display_name", patch.display_name);
    if (patch.remark !== undefined) w.set("remark", patch.remark);
    if (patch.sort_key !== undefined) w.set("sort_key", patch.sort_key);
    if (patch.avatar_ref !== undefined) w.set("avatar_ref", patch.avatar_ref);
    if (patch.status !== undefined) w.set("status", patch.status);
    if (patch.merged_into !== undefined) w.set("merged_into", patch.merged_into);
    if (patch.profile_json !== undefined) w.set("profile_json", patch.profile_json);
    w.set("manual_locked", 1);
    w.set("updated_at", now);
    db.prepare(`UPDATE persons SET ${w.sets.join(", ")} WHERE person_id = ?`).run(
      ...w.params,
      personId,
    );
    return getOrThrow(personId);
  };

  const updateAutoStats = (
    personId: string,
    stats: PersonStatsPatch,
    now: string,
  ): AutoWriteResult => {
    if (getOrThrow(personId).manual_locked) return { updated: false, skipped_locked: true };
    const w = makeSetter();
    if (stats.msg_count !== undefined) w.set("msg_count", stats.msg_count);
    if (stats.conv_count !== undefined) w.set("conv_count", stats.conv_count);
    if (stats.first_msg_at !== undefined) w.set("first_msg_at", stats.first_msg_at);
    if (stats.last_msg_at !== undefined) w.set("last_msg_at", stats.last_msg_at);
    if (w.sets.length === 0) return { updated: false, skipped_locked: false };
    w.set("updated_at", now);
    db.prepare(`UPDATE persons SET ${w.sets.join(", ")} WHERE person_id = ?`).run(
      ...w.params,
      personId,
    );
    return { updated: true, skipped_locked: false };
  };

  const updateProfileJson = (
    personId: string,
    profileJson: string,
    producedBy: string,
    now: string,
  ): AutoWriteResult => {
    if (getOrThrow(personId).manual_locked) return { updated: false, skipped_locked: true };
    db.prepare("UPDATE persons SET profile_json = ?, updated_at = ? WHERE person_id = ?").run(
      profileJson,
      now,
      personId,
    );
    setPersonMeta(db, PROFILE_PRODUCED_BY_KEY, producedBy);
    return { updated: true, skipped_locked: false };
  };

  const setManualLocked = (personId: string, locked: boolean, now: string): void => {
    getOrThrow(personId);
    db.prepare("UPDATE persons SET manual_locked = ?, updated_at = ? WHERE person_id = ?").run(
      locked ? 1 : 0,
      now,
      personId,
    );
  };

  const markMerged = (fromId: string, intoId: string, now: string): void => {
    db.prepare(
      "UPDATE persons SET status = 'merged', merged_into = ?, updated_at = ? WHERE person_id = ?",
    ).run(intoId, now, fromId);
  };

  const unmarkMerged = (personId: string, now: string): void => {
    db.prepare(
      "UPDATE persons SET status = 'active', merged_into = NULL, updated_at = ? WHERE person_id = ?",
    ).run(now, personId);
  };

  /** 统计列重算（§9.2 `persons_stats` 层）：数据源 `v_chat_messages`（已解析别名、排除回滚批次）。 */
  /**
   * 批量重算所有人物的派生统计（`msg_count` / `conv_count` / 首末时间）。
   *
   * ## 为什么需要批量版
   * 单人的 `recomputeStats` 每人跑两条 SQL + 一次 `v_chat_messages` 全视图聚合；
   * 1,072 个人就是 1,072 次视图扫描（15 万行数据上要几分钟）。这里改成
   * **一条 GROUP BY 聚合 + 事务内批量 UPDATE**，代价与人数无关、只与消息量有关。
   *
   * ## 为什么跳过 `manual_locked`
   * 与单人版保持一致：人工编辑过的人不该被自动统计覆盖（DESIGN-13 §6.2 规则 2）。
   *
   * ## 为什么不改 `updated_at` 以外的列
   * 只碰这 5 列，`display_name` / `remark` / `status` 一律不碰 —— 统计重算不能顺带改语义。
   *
   * @param now ISO8601 时间
   * @returns 实际更新的人数（跳过的锁行人、以及没有任何消息的人不计）
   */
  const recomputeAllStats = (now: string): { updated: number } => {
    const rows = db
      .prepare(
        `SELECT sender_person_id AS person_id,
                COUNT(*)                        AS msg_count,
                COUNT(DISTINCT conversation_id) AS conv_count,
                MIN(ts_ms)                       AS first_ms,
                MAX(ts_ms)                       AS last_ms
           FROM v_chat_messages
          WHERE sender_person_id IS NOT NULL
          GROUP BY sender_person_id`,
      )
      .all() as {
      person_id: string;
      msg_count: number;
      conv_count: number;
      first_ms: number | null;
      last_ms: number | null;
    }[];
    if (rows.length === 0) return { updated: 0 };
    const stmt = db.prepare(
      `UPDATE persons SET msg_count = ?, conv_count = ?, first_msg_at = ?, last_msg_at = ?, updated_at = ?
        WHERE person_id = ? AND manual_locked = 0`,
    );
    let updated = 0;
    db.transaction(() => {
      for (const row of rows) {
        const result = stmt.run(
          row.msg_count,
          row.conv_count,
          isoOrNull(row.first_ms),
          isoOrNull(row.last_ms),
          now,
          row.person_id,
        );
        updated += result.changes;
      }
    })();
    return { updated };
  };

  const recomputeStats = (personId: string, now: string): PersonRow => {
    const current = getOrThrow(personId);
    if (current.manual_locked) return current;
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS msg_count, COUNT(DISTINCT conversation_id) AS conv_count,
                MIN(ts_ms) AS first_ms, MAX(ts_ms) AS last_ms
         FROM v_chat_messages WHERE sender_person_id = ?`,
      )
      .get(personId) as {
      msg_count: number;
      conv_count: number;
      first_ms: number | null;
      last_ms: number | null;
    };
    db.prepare(
      `UPDATE persons SET msg_count = ?, conv_count = ?, first_msg_at = ?, last_msg_at = ?,
                          updated_at = ?
       WHERE person_id = ?`,
    ).run(
      agg.msg_count,
      agg.conv_count,
      isoOrNull(agg.first_ms),
      isoOrNull(agg.last_ms),
      now,
      personId,
    );
    return getOrThrow(personId);
  };

  return {
    insert,
    createManualPerson,
    recomputeAllStats,
    updateManual,
    updateAutoStats,
    updateProfileJson,
    setManualLocked,
    markMerged,
    unmarkMerged,
    recomputeStats,
  };
}
