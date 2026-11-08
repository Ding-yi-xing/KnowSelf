/**
 * 「撤销后强制复核」的派生读仓库（批 2b / 评审定稿 11b~11d）。
 *
 * 背景：1B′ 的 `trusted_ingest = 会话已存在 ∨ auto_ok`，而 `revertBatch` **不删**
 * `chat_conversations`（append-only）⇒ 撤销后 `exists` 仍为 true ⇒ 重导直接 Tier A
 * 自动落档 ⇒ 被撤内容零审阅复原 = 假撤销。修法是收回预授权：把「因撤销而待复核」的
 * 会话集合合并进 `tierConfig.review`（命中 `MANUAL_FLAG` ⇒ Tier B），判定链路一字不改。
 *
 * 判据（单库单查询，**无新表、无新列、无 DDL**）：
 *
 * ```sql
 * SELECT 1 FROM chat_messages m
 *  WHERE m.conversation_id = ?
 *    AND julianday(m.ingested_at) > julianday(COALESCE((
 *      SELECT MAX(b.reverted_at) FROM ingest_batches b
 *        JOIN chat_message_staging s ON s.batch_id = b.batch_id
 *       WHERE s.conversation_id = ? AND b.reverted_at IS NOT NULL
 *    ), ''))
 *  LIMIT 1
 * ```
 *
 * 三个必须（缺一即静默判错）：
 *   ① `COALESCE(..., '')`：从未撤销时 `julianday('')` 为 NULL，条件恒假 ——
 *      既不误解除也不误复核；
 *   ② 取 `MAX(reverted_at)`：否则首次撤销会永久压制解除（粘性要求）；
 *   ③ **必须用 `julianday()` 而非字符串比较**：`ingested_at` / `reverted_at` 是
 *      TEXT ISO8601，而 `now` 是可注入参数，格式漂移（空格分隔 / 无 Z）会静默判错。
 *
 * 语义：探针返回行 = 「最近一次撤销之后，确实有消息被重新落档」= 复核已解除。
 * 被撤批次自身的行 `ingested_at < reverted_at` 天然不满足，**不加多余过滤**。
 * `committed=0 && rejected=N`（跨批拒绝）时没有新行落档、`ingested_at` 不前移
 * ⇒ 不解除复核，这是正确行为：用户没让任何数据重新落地，就不该恢复自动信任。
 *
 * UI 徽标消费判据（本批不做前端，仅留可消费的判据 + 零新增查询的中间结果）：
 *   - 「首次导入 · 需确认一次」= 会话不存在 ∧ 未预授权（即 `NEW_CONVERSATION`）；
 *   - 「此前撤销 · 需重新确认」= `isReviewRequired(conversation_id)` 为 true，
 *     `last_reverted_at` 可直接作为「此前撤销」的时间依据。
 */
import type { PersonDb } from "../db";

/** 需强制复核的会话（含最近一次撤销时间，供文案 / 徽标消费）。 */
export interface ReviewRequiredConversation {
  conversation_id: string;
  last_reverted_at: string;
}

export interface ReviewRequiredRepo {
  /** 全部「因撤销而待复核」的会话（按 id 升序稳定输出，供 CLI 合并进 `review`）。 */
  listReviewRequiredConversations(): ReviewRequiredConversation[];
  /** 单会话判据（供 UI 徽标与未来 HTTP 出口消费）。 */
  isReviewRequired(conversationId: string): boolean;
}

/** 候选集：至少有一个已撤销批次、且该批次有 staging 行的会话。 */
const CANDIDATES_SQL = `
  SELECT s.conversation_id AS conversation_id,
         MAX(b.reverted_at) AS last_reverted_at
    FROM ingest_batches b
    JOIN chat_message_staging s ON s.batch_id = b.batch_id
   WHERE b.reverted_at IS NOT NULL
   GROUP BY s.conversation_id
   ORDER BY s.conversation_id ASC`;

/** 粘性解除探针（逐字采用评审定稿 SQL）。 */
const CLEARED_PROBE_SQL = `
  SELECT 1 FROM chat_messages m
   WHERE m.conversation_id = ?
     AND julianday(m.ingested_at) > julianday(COALESCE((
       SELECT MAX(b.reverted_at) FROM ingest_batches b
        JOIN chat_message_staging s ON s.batch_id = b.batch_id
        WHERE s.conversation_id = ? AND b.reverted_at IS NOT NULL
     ), ''))
   LIMIT 1`;

/** 候选判据的单会话版本（无 reverted 批次 ⇒ 无需复核）。 */
const HAS_REVERT_SQL = `
  SELECT 1 FROM ingest_batches b
    JOIN chat_message_staging s ON s.batch_id = b.batch_id
   WHERE s.conversation_id = ? AND b.reverted_at IS NOT NULL
   LIMIT 1`;

interface CandidateRow {
  conversation_id: string;
  last_reverted_at: string | null;
}

export function createReviewRequiredRepo(db: PersonDb): ReviewRequiredRepo {
  const candidates = db.prepare(CANDIDATES_SQL);
  const clearedProbe = db.prepare(CLEARED_PROBE_SQL);
  const hasRevert = db.prepare(HAS_REVERT_SQL);

  /** 探针命中 ⇒ 有「晚于最近撤销」的落档 ⇒ 复核已解除。 */
  const isCleared = (conversationId: string): boolean =>
    clearedProbe.get(conversationId, conversationId) !== undefined;

  const isReviewRequired = (conversationId: string): boolean =>
    hasRevert.get(conversationId) !== undefined && !isCleared(conversationId);

  const listReviewRequiredConversations = (): ReviewRequiredConversation[] => {
    const rows = candidates.all() as CandidateRow[];
    const result: ReviewRequiredConversation[] = [];
    for (const row of rows) {
      if (row.last_reverted_at === null) continue;
      if (isCleared(row.conversation_id)) continue;
      result.push({
        conversation_id: row.conversation_id,
        last_reverted_at: row.last_reverted_at,
      });
    }
    return result;
  };

  return { listReviewRequiredConversations, isReviewRequired };
}
