/**
 * `staging` 仓库（DESIGN-13 §3.7 接口定稿，签名逐字）：
 * `chat_message_staging` + `ingest_batches` + `ingest_cursors`。
 * 语义：staging 是**载荷仓 + 断点续跑锚点 + 对账凭据**（DESIGN-11 §4.3），不是真相源；
 * 三层幂等的 L1 层：`PRIMARY KEY (batch_id, conversation_id, message_id)` + `INSERT OR IGNORE`。
 * 按 §2.2 行预算拆分：批次族 `staging-batches.ts`、游标族 `staging-cursors.ts`、
 * 对账族 `staging-reconcile.ts`；本文件组合暴露，接口不变。
 */
import type { PersonDb } from "../db";
import type { StagingInsert, StagingRow, StagingStatus, StagingTier } from "../types-ingest";
import { createBatchesRepo, type BatchesRepo } from "./staging-batches";
import { createCursorsRepo, type CursorsRepo } from "./staging-cursors";
import { createStagingReconcileRepo, type StagingReconcileRepo } from "./staging-reconcile";

export interface StagingRepo extends BatchesRepo, CursorsRepo, StagingReconcileRepo {
  stageMessages(q: {
    batch_id: string;
    conversation_id: string;
    rows: readonly StagingInsert[];
    now: string;
  }): { inserted: number; ignored: number };
  markTier(q: {
    batch_id: string;
    conversation_id: string;
    items: readonly { message_id: string; tier: StagingTier; reason_codes: readonly string[] }[];
    now: string;
  }): { updated: number };
  listStaged(q: {
    batch_id: string;
    conversation_id?: string;
    status?: StagingStatus;
    limit?: number;
    offset?: number;
  }): StagingRow[];
  countByStatus(batchId: string): Record<StagingStatus, number>;
  commitStaged(q: {
    batch_id: string;
    conversation_id: string;
    proposal_id: string;
    now: string;
  }): { committed: number; skipped: number };
  rejectStaged(q: {
    batch_id: string;
    conversation_id: string;
    proposal_id: string;
    now: string;
  }): { rejected: number };
  /** 加法式（DESIGN-13 §4.4 步骤 3 需**批次级**拒绝；§3.7 的 `rejectStaged` 是会话级）。 */
  rejectBatch(q: { batch_id: string; now: string }): { rejected: number };
}

const STAGING_INSERT = `INSERT OR IGNORE INTO chat_message_staging
    (batch_id, conversation_id, message_id, platform, sender_id, sender_name, role, ts_ms,
     msg_date, content, content_type, reply_to, meta, tier, reason_codes, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)`;

function stagingRowOps(db: PersonDb): Pick<
  StagingRepo,
  "stageMessages" | "markTier" | "listStaged" | "countByStatus" | "commitStaged" | "rejectStaged" | "rejectBatch"
> {
  const stageMessages = (
    q: Parameters<StagingRepo["stageMessages"]>[0],
  ): { inserted: number; ignored: number } => {
    const stmt = db.prepare(STAGING_INSERT);
    let inserted = 0;
    for (const row of q.rows) {
      inserted += stmt.run(
        q.batch_id,
        q.conversation_id,
        row.message_id,
        row.platform,
        row.sender_id,
        row.sender_name,
        row.role,
        row.ts_ms,
        row.msg_date,
        row.content,
        row.content_type,
        row.reply_to,
        row.meta,
        row.tier ?? "review",
        row.reason_codes ?? "[]",
        q.now,
      ).changes;
    }
    return { inserted, ignored: q.rows.length - inserted };
  };

  const markTier = (q: Parameters<StagingRepo["markTier"]>[0]): { updated: number } => {
    const stmt = db.prepare(
      `UPDATE chat_message_staging SET tier = ?, reason_codes = ?
        WHERE batch_id = ? AND conversation_id = ? AND message_id = ?`,
    );
    let updated = 0;
    for (const item of q.items) {
      updated += stmt.run(
        item.tier,
        JSON.stringify(item.reason_codes),
        q.batch_id,
        q.conversation_id,
        item.message_id,
      ).changes;
    }
    return { updated };
  };

  const listStaged = (q: Parameters<StagingRepo["listStaged"]>[0]): StagingRow[] => {
    const conditions = ["batch_id = ?"];
    const params: (string | number)[] = [q.batch_id];
    if (q.conversation_id !== undefined) {
      conditions.push("conversation_id = ?");
      params.push(q.conversation_id);
    }
    if (q.status !== undefined) {
      conditions.push("status = ?");
      params.push(q.status);
    }
    const page = q.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageParams = q.limit === undefined ? [] : [q.limit, q.offset ?? 0];
    return db
      .prepare(
        `SELECT * FROM chat_message_staging WHERE ${conditions.join(" AND ")}
         ORDER BY ts_ms ASC, message_id ASC${page}`,
      )
      .all(...params, ...pageParams) as StagingRow[];
  };

  const countByStatus = (batchId: string): Record<StagingStatus, number> => {
    const rows = db
      .prepare(
        "SELECT status, COUNT(*) AS n FROM chat_message_staging WHERE batch_id = ? GROUP BY status",
      )
      .all(batchId) as { status: StagingStatus; n: number }[];
    const result: Record<StagingStatus, number> = { staged: 0, committed: 0, rejected: 0 };
    for (const row of rows) result[row.status] = row.n;
    return result;
  };

  const commitStaged = (
    q: Parameters<StagingRepo["commitStaged"]>[0],
  ): { committed: number; skipped: number } => {
    // 先数已 committed 的（幂等 skip），再 UPDATE staged→committed；顺序反了会把刚提交的算成 skipped
    const already = db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_message_staging
          WHERE batch_id = ? AND conversation_id = ? AND status = 'committed'`,
      )
      .get(q.batch_id, q.conversation_id) as { n: number };
    const committed = db
      .prepare(
        `UPDATE chat_message_staging
            SET status = 'committed', committed_at = ?, proposal_id = ?
          WHERE batch_id = ? AND conversation_id = ? AND status = 'staged'`,
      )
      .run(q.now, q.proposal_id, q.batch_id, q.conversation_id).changes;
    return { committed, skipped: already.n };
  };

  const rejectStaged = (q: Parameters<StagingRepo["rejectStaged"]>[0]): { rejected: number } => {
    const result = db
      .prepare(
        `UPDATE chat_message_staging SET status = 'rejected', proposal_id = ?
          WHERE batch_id = ? AND conversation_id = ? AND status = 'staged'`,
      )
      .run(q.proposal_id, q.batch_id, q.conversation_id);
    return { rejected: result.changes };
  };

  const rejectBatch = (q: { batch_id: string; now: string }): { rejected: number } => {
    const result = db
      .prepare(
        `UPDATE chat_message_staging SET status = 'rejected'
          WHERE batch_id = ? AND status IN ('staged', 'committed')`,
      )
      .run(q.batch_id);
    return { rejected: result.changes };
  };

  return { stageMessages, markTier, listStaged, countByStatus, commitStaged, rejectStaged, rejectBatch };
}

export function createStagingRepo(db: PersonDb): StagingRepo {
  return {
    ...createBatchesRepo(db),
    ...createCursorsRepo(db),
    ...createStagingReconcileRepo(db),
    ...stagingRowOps(db),
  };
}
