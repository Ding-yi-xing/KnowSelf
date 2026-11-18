/**
 * 身份状态时间线仓库。
 *
 * 语义：记录「我亲口说过的、关于我自己身份/状态的变化」——在读、毕业、入职、辞职、待业、求职中。
 *
 * 为什么不塞进画像卡片：卡片是一句话的静态口径，盖不住「上周还在投简历、这周入职了」这种时效变化。
 *
 * 覆盖规则（按 category）：
 *   - enrollment：在读 / 毕业 / 休学 —— 新状态失效旧的
 *   - work：入职 / 实习 / 待业 / 求职中 —— 新状态失效旧的
 *   - other：其它状态，不互相失效
 *
 * 「在读」和「求职中」属于不同 category，可以并存。
 *
 * @module @knowself/profile-store/identity-states
 */
import type { ProfileDb } from "../db";

export type IdentityStateCategory = "enrollment" | "work" | "other";

export interface IdentityStateRecord {
  id: number;
  category: IdentityStateCategory;
  text: string;
  source_quote: string;
  source_conversation_id: string;
  valid_from: string | null;
  invalid_at: string | null;
  created_at: string;
}

export interface IdentityStateInput {
  category: IdentityStateCategory;
  text: string;
  source_quote: string;
  source_conversation_id?: string;
  valid_from?: string | null;
}

interface IdentityStateRow {
  id: number;
  category: string;
  text: string;
  source_quote: string;
  source_conversation_id: string;
  valid_from: string | null;
  invalid_at: string | null;
  created_at: string;
}

function toRecord(row: IdentityStateRow): IdentityStateRecord {
  return {
    ...row,
    category: (row.category === "enrollment" || row.category === "work" ? row.category : "other") as IdentityStateCategory,
  };
}

export function createIdentityStatesRepo(db: ProfileDb) {
  return {
    /**
     * 追加一条状态。
     *
     * 同一 category 里更早的未失效状态会被打上 `invalid_at`（不删除，保留历史）。
     * 完全相同的 (category, text) 不重复插入。
     */
    append(input: IdentityStateInput, now: string): IdentityStateRecord {
      const text = input.text.trim().slice(0, 60);
      const quote = input.source_quote.trim().slice(0, 120);
      return db.transaction(() => {
        const existing = db
          .prepare(
            `SELECT * FROM identity_states
             WHERE category = ? AND text = ? AND invalid_at IS NULL
             LIMIT 1`,
          )
          .get(input.category, text) as IdentityStateRow | undefined;
        if (existing !== undefined) return toRecord(existing);

        db.prepare(
          `UPDATE identity_states SET invalid_at = ?
           WHERE category = ? AND invalid_at IS NULL`,
        ).run(now, input.category);

        const info = db
          .prepare(
            `INSERT INTO identity_states
             (category, text, source_quote, source_conversation_id, valid_from, invalid_at, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            input.category,
            text,
            quote,
            input.source_conversation_id ?? "",
            input.valid_from ?? now,
            now,
          );

        const row = db
          .prepare("SELECT * FROM identity_states WHERE id = ?")
          .get(info.lastInsertRowid) as IdentityStateRow;
        return toRecord(row);
      })();
    },

    /** 当前有效的状态，按 category 优先、时间倒序。 */
    listActive(categories?: IdentityStateCategory[]): IdentityStateRecord[] {
      const rows = categories === undefined || categories.length === 0
        ? (db
            .prepare("SELECT * FROM identity_states WHERE invalid_at IS NULL ORDER BY created_at DESC")
            .all() as IdentityStateRow[])
        : (db
            .prepare(
              `SELECT * FROM identity_states WHERE invalid_at IS NULL
               AND category IN (${categories.map(() => "?").join(",")})
               ORDER BY created_at DESC`,
            )
            .all(...categories) as IdentityStateRow[]);
      return rows.map(toRecord);
    },

    /** 全部历史（含已失效），调试与回溯用。 */
    listAll(limit = 50): IdentityStateRecord[] {
      const rows = db
        .prepare("SELECT * FROM identity_states ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, limit)) as IdentityStateRow[];
      return rows.map(toRecord);
    },
  };
}
