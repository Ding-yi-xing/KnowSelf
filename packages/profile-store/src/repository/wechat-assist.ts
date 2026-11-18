import type { ProfileDb } from "../db";

/** 用户对回复口吻的一条纠正（"不像我""我一般这么说"）。 */
export interface ReplyCorrectionRecord {
  layer: string;
  wrong: string;
  right: string;
  at: string;
}

/** 每个联系人最多保留多少条纠正：够用又不至于把 prompt 撑爆。 */
const REPLY_CORRECTION_LIMIT = 20;

function correctionsKey(contactId: string): string {
  return `reply_corrections:${contactId}`;
}

function readReplyCorrections(db: ProfileDb, contactId: string): ReplyCorrectionRecord[] {
  const row = db.prepare("SELECT value FROM profile_meta WHERE key = ?").get(correctionsKey(contactId)) as
    | { value: string }
    | undefined;
  if (row === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .filter((item) => typeof item.wrong === "string" && typeof item.right === "string")
      .map((item) => ({
        layer: typeof item.layer === "string" ? item.layer : "Layer 2",
        wrong: item.wrong as string,
        right: item.right as string,
        at: typeof item.at === "string" ? item.at : "",
      }));
  } catch {
    return [];
  }
}

export type WechatAssistDraftStatus = "draft" | "sent" | "discarded";
export type WechatAssistSendStatus = "processing" | "sent" | "failed" | "uncertain";
export type WechatReplyTaskStatus = "starting" | "running" | "stopping" | "stopped" | "paused" | "failed";
export type WechatReplyTurnStatus = "started" | "generated" | "sent" | "skipped" | "failed" | "uncertain";
export type WechatAssistAuditAction =
  | "draft_created"
  | "draft_discarded"
  | "send_rejected"
  | "send_attempted"
  | "send_succeeded"
  | "send_failed"
  | "reply_task_started"
  | "reply_task_stopped"
  | "reply_task_paused"
  | "reply_context_shared";

export interface WechatAssistDraftRecord {
  id: string;
  contact_id: string;
  body: string;
  status: WechatAssistDraftStatus;
  created_at: string;
  sent_at: string | null;
  external_id: string | null;
}

export interface WechatAssistAuditRecord {
  at: string;
  action: WechatAssistAuditAction;
  draft_id: string;
  contact_id: string;
  reason?: string;
  external_id?: string;
}

export interface WechatAssistSendAttemptRecord {
  id: number;
  draft_id: string;
  idempotency_key: string;
  contact_id: string;
  body_hash: string;
  target_fingerprint: string | null;
  status: WechatAssistSendStatus;
  external_id: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  attempt_count: number;
  last_error: string | null;
  started_at: string;
  finished_at: string | null;
  reconciled_at: string | null;
}

export interface ClaimWechatAssistSendInput {
  draft_id: string;
  idempotency_key: string;
  contact_id: string;
  body_hash: string;
  target_fingerprint?: string;
  lease_owner: string;
  now: string;
  lease_until: string;
}

export interface WechatReplyPersonaRecord {
  task_id: string;
  payload_json: string;
  generated_at: string;
  updated_at: string;
}

export interface WechatReplyTaskProgressRecord {
  task_id: string;
  facts_json: string;
  asked_slots_json: string;
  stage_goal: string;
  updated_at: string;
  turn_count: number;
}

export interface WechatReplyTaskRecord {
  id: string;
  account_scope: string;
  conversation_id: string;
  contact_id: string;
  objective: string;
  provider_id: string;
  model_id: string;
  history_authorized: boolean;
  authorization_version: number;
  status: WechatReplyTaskStatus;
  stop_reason: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  turn_count: number;
  send_count: number;
  created_at: string;
  updated_at: string;
  stopped_at: string | null;
}

export interface WechatReplyTurnRecord {
  id: number;
  task_id: string;
  inbound_message_id: string | null;
  generated_body: string | null;
  status: WechatReplyTurnStatus;
  reason: string | null;
  created_at: string;
  finished_at: string | null;
}

interface DraftRow extends WechatAssistDraftRecord {}
interface SendAttemptRow extends WechatAssistSendAttemptRecord {}
interface ReplyTaskRow extends Omit<WechatReplyTaskRecord, "history_authorized"> { history_authorized: number }

export function createWechatAssistRepo(db: ProfileDb) {
  return {
    createDraft(record: WechatAssistDraftRecord): void {
      db.prepare(
        `INSERT INTO wechat_assist_drafts
         (id, contact_id, body, status, created_at, sent_at, external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.contact_id,
        record.body,
        record.status,
        record.created_at,
        record.sent_at,
        record.external_id,
      );
    },

    listDrafts(): WechatAssistDraftRecord[] {
      return db
        .prepare("SELECT * FROM wechat_assist_drafts ORDER BY created_at DESC, id DESC")
        .all() as DraftRow[];
    },

    getDraft(id: string): WechatAssistDraftRecord | undefined {
      return db
        .prepare("SELECT * FROM wechat_assist_drafts WHERE id = ?")
        .get(id) as DraftRow | undefined;
    },

    updateDraft(record: WechatAssistDraftRecord): void {
      db.prepare(
        `UPDATE wechat_assist_drafts
         SET contact_id = ?, body = ?, status = ?, created_at = ?, sent_at = ?, external_id = ?
         WHERE id = ?`,
      ).run(
        record.contact_id,
        record.body,
        record.status,
        record.created_at,
        record.sent_at,
        record.external_id,
        record.id,
      );
    },

    /**
     * 用户对「我怎么说话」的纠正（按联系人存）。
     *
     * 参考 ex-skill 的 correction 回流：用户说「不像我 / 太正式了」之后，
     * 这条纠正要比模型总结出来的风格优先级更高，下一条回复就该体现。
     */
    listReplyCorrections(contactId: string): ReplyCorrectionRecord[] {
      return readReplyCorrections(db, contactId);
    },

    appendReplyCorrection(contactId: string, entry: { layer?: string; wrong: string; right: string }): void {
      const all = readReplyCorrections(db, contactId);
      all.push({
        layer: entry.layer ?? "Layer 2",
        wrong: entry.wrong,
        right: entry.right,
        at: new Date().toISOString(),
      });
      db.prepare(
        `INSERT INTO profile_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(correctionsKey(contactId), JSON.stringify(all.slice(-REPLY_CORRECTION_LIMIT)));
    },

    /**
     * 自动化自己发出去的正文（最近 `limit` 条，新→旧）。
     *
     * 用途：聊天库里分不清「用户手打的」和「机器人代发的」，两者都是 role=me。
     * 生成口吻样本/人物画像时必须把机器人自己说过的话剔掉，否则模型会不断学回自己的腔调。
     */
    listSentBodies(contactId: string, limit = 500): string[] {
      const rows = db
        .prepare(
          `SELECT body FROM wechat_assist_drafts
           WHERE contact_id = ? AND status = 'sent' AND body <> ''
           ORDER BY sent_at DESC, created_at DESC
           LIMIT ?`,
        )
        .all(contactId, Math.max(1, limit)) as Array<{ body: string }>;
      return rows.map((row) => row.body);
    },

    listSuccessfulSendTimes(since: string): number[] {
      // 不能拿 `sent_at` 字符串直接跟 UTC 的 `since` 比大小：`sent_at` 存的是**本地时间**
      // （bridge 返回 `time.localtime` 格式，无时区后缀），字符串比较会把整天中午之后的发送都算进
      // 「最近一小时」→ 每小时上限被误触发，导致「对方最后一条消息没回」（RATE_LIMITED）。
      // 改成数值（epoch ms）比较：Date.parse 对「无后缀=本地」和「Z=UTC」都能正确折算到同一时间轴。
      const sinceMs = Date.parse(since);
      const rows = db
        .prepare(`SELECT sent_at FROM wechat_assist_drafts WHERE status = 'sent' AND sent_at IS NOT NULL`)
        .all() as Array<{ sent_at: string }>;
      const times: number[] = [];
      for (const row of rows) {
        const at = Date.parse(row.sent_at);
        if (!Number.isNaN(at) && at >= sinceMs) times.push(at);
      }
      times.sort((left, right) => left - right);
      return times;
    },

    getSendAttempt(draftId: string): WechatAssistSendAttemptRecord | undefined {
      return db
        .prepare("SELECT * FROM wechat_assist_send_ledger WHERE draft_id = ?")
        .get(draftId) as SendAttemptRow | undefined;
    },

    getSendAttemptByIdempotencyKey(key: string): WechatAssistSendAttemptRecord | undefined {
      return db
        .prepare("SELECT * FROM wechat_assist_send_ledger WHERE idempotency_key = ?")
        .get(key) as SendAttemptRow | undefined;
    },

    claimSendAttempt(input: ClaimWechatAssistSendInput): WechatAssistSendAttemptRecord | undefined {
      return db.transaction(() => {
        const existing = this.getSendAttempt(input.draft_id);
        const existingByKey = this.getSendAttemptByIdempotencyKey(input.idempotency_key);
        if (existingByKey !== undefined && existingByKey.draft_id !== input.draft_id) {
          throw new Error("idempotency key is already bound to another draft");
        }
        if (existing !== undefined && existing.idempotency_key !== input.idempotency_key) {
          throw new Error("draft is already bound to another idempotency key");
        }
        if (
          existing !== undefined &&
          (existing.contact_id !== input.contact_id ||
            existing.body_hash !== input.body_hash ||
            (existing.target_fingerprint ?? null) !== (input.target_fingerprint ?? null))
        ) {
          throw new Error("send attempt identity does not match the existing draft");
        }
        if (existing?.status === "sent") return existing;
        if (existing?.status === "uncertain") return undefined;
        if (
          existing?.status === "processing" &&
          (existing.lease_until === null || existing.lease_until > input.now)
        ) {
          return undefined;
        }

        if (existing?.status === "processing") {
          db.prepare(
            `UPDATE wechat_assist_send_ledger
             SET status = 'uncertain', last_error = 'expired_send_lease_requires_reconciliation',
                 lease_owner = NULL, lease_until = NULL, finished_at = ?
             WHERE draft_id = ? AND status = 'processing'`,
          ).run(input.now, input.draft_id);
          return undefined;
        }

        if (existing === undefined) {
          db.prepare(
            `INSERT INTO wechat_assist_send_ledger
             (draft_id, idempotency_key, contact_id, body_hash, target_fingerprint, status,
              lease_owner, lease_until, attempt_count, started_at)
             VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, 1, ?)`,
          ).run(
            input.draft_id,
            input.idempotency_key,
            input.contact_id,
            input.body_hash,
            input.target_fingerprint ?? null,
            input.lease_owner,
            input.lease_until,
            input.now,
          );
        } else {
          db.prepare(
            `UPDATE wechat_assist_send_ledger
             SET contact_id = ?, body_hash = ?, target_fingerprint = ?, status = 'processing',
                 lease_owner = ?, lease_until = ?, attempt_count = attempt_count + 1,
                 last_error = NULL, finished_at = NULL, reconciled_at = NULL, started_at = ?
             WHERE draft_id = ? AND (status <> 'processing' OR lease_until IS NULL OR lease_until <= ?)`,
          ).run(
            input.contact_id,
            input.body_hash,
            input.target_fingerprint ?? null,
            input.lease_owner,
            input.lease_until,
            input.now,
            input.draft_id,
            input.now,
          );
        }
        return this.getSendAttempt(input.draft_id);
      })();
    },

    markSendSent(
      draftId: string,
      leaseOwner: string,
      externalId: string | null,
      at: string,
    ): void {
      db.prepare(
        `UPDATE wechat_assist_send_ledger
         SET status = 'sent', external_id = ?, lease_owner = NULL, lease_until = NULL,
             finished_at = ?, reconciled_at = ?
         WHERE draft_id = ? AND status = 'processing' AND lease_owner = ?`,
      ).run(externalId, at, at, draftId, leaseOwner);
    },

    markSendFailed(
      draftId: string,
      leaseOwner: string,
      reason: string,
      at: string,
    ): void {
      db.prepare(
        `UPDATE wechat_assist_send_ledger
         SET status = 'failed', last_error = ?, lease_owner = NULL, lease_until = NULL,
             finished_at = ?
         WHERE draft_id = ? AND status = 'processing' AND lease_owner = ?`,
      ).run(reason, at, draftId, leaseOwner);
    },

    markSendUncertain(
      draftId: string,
      leaseOwner: string,
      reason: string,
      at: string,
    ): void {
      db.prepare(
        `UPDATE wechat_assist_send_ledger
         SET status = 'uncertain', last_error = ?, lease_owner = NULL, lease_until = NULL,
             finished_at = ?
         WHERE draft_id = ? AND status = 'processing' AND lease_owner = ?`,
      ).run(reason, at, draftId, leaseOwner);
    },

    reconcileSend(
      draftId: string,
      externalId: string | null,
      at: string,
    ): void {
      db.prepare(
        `UPDATE wechat_assist_send_ledger
         SET status = 'sent', external_id = ?, lease_owner = NULL, lease_until = NULL,
             finished_at = COALESCE(finished_at, ?), reconciled_at = ?
         WHERE draft_id = ? AND status IN ('uncertain', 'failed')`,
      ).run(externalId, at, at, draftId);
    },

    reconcileSendNotSent(draftId: string, reason: string, at: string): void {
      db.prepare(
        `UPDATE wechat_assist_send_ledger
         SET status = 'failed', last_error = ?, lease_owner = NULL, lease_until = NULL,
             finished_at = COALESCE(finished_at, ?), reconciled_at = ?
         WHERE draft_id = ? AND status = 'uncertain'`,
      ).run(reason, at, at, draftId);
    },

    recoverInterruptedWork(now: string): { tasks: number; turns: number; sends: number } {
      return db.transaction(() => {
        const staleTaskIds = (db.prepare(
          `SELECT id FROM wechat_reply_tasks
           WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`,
        ).all(now) as Array<{ id: string }>).map(({ id }) => id);
        let turns = 0;
        for (const taskId of staleTaskIds) {
          turns += db.prepare(
            `UPDATE wechat_reply_turns
             SET status = 'uncertain', reason = 'process_restarted_before_turn_completed', finished_at = ?
             WHERE task_id = ? AND status IN ('started','generated')`,
          ).run(now, taskId).changes;
          db.prepare(
            `UPDATE wechat_reply_tasks
             SET status = 'paused', stop_reason = 'process_restarted_lease_expired',
                 lease_owner = NULL, lease_until = NULL, updated_at = ?
             WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`,
          ).run(now, taskId, now);
        }
        const sends = db.prepare(
          `UPDATE wechat_assist_send_ledger
           SET status = 'uncertain', last_error = 'process_restarted_send_requires_reconciliation',
               lease_owner = NULL, lease_until = NULL, finished_at = ?
           WHERE status = 'processing' AND (lease_until IS NULL OR lease_until <= ?)`,
        ).run(now, now).changes;
        return { tasks: staleTaskIds.length, turns, sends };
      })();
    },

    appendAudit(record: WechatAssistAuditRecord): void {
      db.prepare(
        `INSERT INTO wechat_assist_audit
         (at, action, draft_id, contact_id, reason, external_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        record.at,
        record.action,
        record.draft_id,
        record.contact_id,
        record.reason ?? null,
        record.external_id ?? null,
      );
    },

    listAudit(draftId?: string): WechatAssistAuditRecord[] {
      const rows = draftId === undefined
        ? db.prepare(
            `SELECT at, action, draft_id, contact_id, reason, external_id
             FROM wechat_assist_audit ORDER BY id ASC`,
          ).all()
        : db.prepare(
            `SELECT at, action, draft_id, contact_id, reason, external_id
             FROM wechat_assist_audit WHERE draft_id = ? ORDER BY id ASC`,
          ).all(draftId);
      return (rows as Array<WechatAssistAuditRecord & { reason: string | null; external_id: string | null }>).map(
        (row) => ({
          at: row.at,
          action: row.action,
          draft_id: row.draft_id,
          contact_id: row.contact_id,
          ...(row.reason === null ? {} : { reason: row.reason }),
          ...(row.external_id === null ? {} : { external_id: row.external_id }),
        }),
      );
    },

    createReplyTask(record: WechatReplyTaskRecord): void {
      db.prepare(
        `INSERT INTO wechat_reply_tasks
          (id, account_scope, conversation_id, contact_id, objective, provider_id, model_id,
           history_authorized, authorization_version, status, stop_reason, lease_owner,
           lease_until, turn_count, send_count, created_at, updated_at, stopped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id, record.account_scope, record.conversation_id, record.contact_id,
        record.objective, record.provider_id, record.model_id, record.history_authorized ? 1 : 0,
        record.authorization_version, record.status, record.stop_reason, record.lease_owner,
        record.lease_until, record.turn_count, record.send_count, record.created_at,
        record.updated_at, record.stopped_at,
      );
    },

    getReplyTask(id: string): WechatReplyTaskRecord | undefined {
      const row = db.prepare("SELECT * FROM wechat_reply_tasks WHERE id = ?").get(id) as ReplyTaskRow | undefined;
      return row === undefined ? undefined : { ...row, history_authorized: row.history_authorized === 1 };
    },

    getActiveReplyTask(accountScope: string): WechatReplyTaskRecord | undefined {
      const row = db.prepare(
        "SELECT * FROM wechat_reply_tasks WHERE account_scope = ? AND status IN ('starting','running','stopping') ORDER BY updated_at DESC LIMIT 1",
      ).get(accountScope) as ReplyTaskRow | undefined;
      return row === undefined ? undefined : { ...row, history_authorized: row.history_authorized === 1 };
    },

    listReplyTasks(): WechatReplyTaskRecord[] {
      return (db.prepare("SELECT * FROM wechat_reply_tasks ORDER BY updated_at DESC, id DESC").all() as ReplyTaskRow[])
        .map((row) => ({ ...row, history_authorized: row.history_authorized === 1 }));
    },

    updateReplyTask(record: WechatReplyTaskRecord): void {
      db.prepare(
        `UPDATE wechat_reply_tasks SET account_scope = ?, conversation_id = ?, contact_id = ?, objective = ?,
          provider_id = ?, model_id = ?, history_authorized = ?, authorization_version = ?, status = ?,
          stop_reason = ?, lease_owner = ?, lease_until = ?, turn_count = ?, send_count = ?,
          created_at = ?, updated_at = ?, stopped_at = ? WHERE id = ?`,
      ).run(
        record.account_scope, record.conversation_id, record.contact_id, record.objective,
        record.provider_id, record.model_id, record.history_authorized ? 1 : 0,
        record.authorization_version, record.status, record.stop_reason, record.lease_owner,
        record.lease_until, record.turn_count, record.send_count, record.created_at,
        record.updated_at, record.stopped_at, record.id,
      );
    },

    pauseStartingReplyTask(input: { id: string; at: string; reason: string }): boolean {
      const result = db.prepare(
        `UPDATE wechat_reply_tasks
         SET status = 'paused', stop_reason = ?, lease_owner = NULL, lease_until = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'starting'`,
      ).run(input.reason, input.at, input.id);
      return result.changes === 1;
    },

    claimReplyTaskLease(input: { id: string; owner: string; now: string; lease_until: string }): boolean {
      const result = db.prepare(
        `UPDATE wechat_reply_tasks
         SET status = 'running', lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE id = ? AND status IN ('starting','running')
           AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until <= ?)`,
      ).run(input.owner, input.lease_until, input.now, input.id, input.owner, input.now);
      return result.changes === 1;
    },

    progressReplyTask(input: {
      id: string;
      owner: string;
      now: string;
      lease_until: string;
      turn_count: number;
      send_count: number;
      status: "running" | "paused";
      reason: string | null;
    }): boolean {
      const result = db.prepare(
        `UPDATE wechat_reply_tasks
         SET status = ?, stop_reason = ?, turn_count = ?, send_count = ?,
             lease_until = CASE WHEN ? = 'running' THEN ? ELSE NULL END,
             lease_owner = CASE WHEN ? = 'running' THEN lease_owner ELSE NULL END,
             updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      ).run(
        input.status, input.reason, input.turn_count, input.send_count,
        input.status, input.lease_until, input.status, input.now, input.id, input.owner,
      );
      return result.changes === 1;
    },

    canContinueReplyTask(input: { id: string; owner: string; authorization_version: number }): boolean {
      return db.prepare(
        `SELECT 1 AS ok FROM wechat_reply_tasks
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND authorization_version = ?`,
      ).get(input.id, input.owner, input.authorization_version) !== undefined;
    },

    revokeReplyTaskHistory(input: { id: string; at: string }): WechatReplyTaskRecord | undefined {
      return db.transaction(() => {
        db.prepare(
          `UPDATE wechat_reply_tasks
           SET history_authorized = 0, authorization_version = authorization_version + 1,
               status = CASE WHEN status IN ('starting','running','stopping') THEN 'paused' ELSE status END,
               stop_reason = 'history_authorization_revoked', lease_owner = NULL, lease_until = NULL,
               updated_at = ?
           WHERE id = ? AND history_authorized = 1`,
        ).run(input.at, input.id);
        db.prepare(
          `UPDATE wechat_reply_turns
           SET status = 'skipped', generated_body = NULL,
               reason = 'history_authorization_revoked', finished_at = ?
           WHERE task_id = ? AND status IN ('started','generated')`,
        ).run(input.at, input.id);
        return this.getReplyTask(input.id);
      })();
    },

    createOwnedReplyTurn(owner: string, record: Omit<WechatReplyTurnRecord, "id">): number {
      const result = db.prepare(
        `INSERT OR IGNORE INTO wechat_reply_turns
          (task_id, inbound_message_id, generated_body, status, reason, created_at, finished_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM wechat_reply_tasks
           WHERE id = ? AND status = 'running' AND lease_owner = ?
         )`,
      ).run(
        record.task_id, record.inbound_message_id, record.generated_body, record.status,
        record.reason, record.created_at, record.finished_at, record.task_id, owner,
      );
      return result.changes === 0 ? 0 : Number(result.lastInsertRowid);
    },

    finishOwnedReplyTurn(owner: string, id: number, input: {
      status: WechatReplyTurnStatus;
      generated_body?: string | null;
      reason?: string | null;
      finished_at?: string | null;
    }): boolean {
      const result = db.prepare(
        `UPDATE wechat_reply_turns
         SET status = ?, generated_body = COALESCE(?, generated_body), reason = ?, finished_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM wechat_reply_tasks
           WHERE wechat_reply_tasks.id = wechat_reply_turns.task_id
             AND status = 'running' AND lease_owner = ?
         )`,
      ).run(input.status, input.generated_body ?? null, input.reason ?? null, input.finished_at ?? null, id, owner);
      return result.changes === 1;
    },

    stopReplyTask(id: string, at: string, reason = "user_stopped"): WechatReplyTaskRecord | undefined {
      const existing = this.getReplyTask(id);
      if (existing === undefined) return undefined;
      if (existing.status !== "stopped") {
        db.prepare(
          "UPDATE wechat_reply_tasks SET status = 'stopped', stop_reason = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?, stopped_at = COALESCE(stopped_at, ?) WHERE id = ?",
        ).run(reason, at, at, id);
      }
      return this.getReplyTask(id);
    },

    createReplyTurn(record: Omit<WechatReplyTurnRecord, "id">): number {
      const result = db.prepare(
        `INSERT OR IGNORE INTO wechat_reply_turns
          (task_id, inbound_message_id, generated_body, status, reason, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(record.task_id, record.inbound_message_id, record.generated_body, record.status, record.reason, record.created_at, record.finished_at);
      return result.changes === 0 ? 0 : Number(result.lastInsertRowid);
    },

    updateReplyTurn(id: number, input: { status: WechatReplyTurnStatus; generated_body?: string | null; reason?: string | null; finished_at?: string | null }): void {
      db.prepare(
        "UPDATE wechat_reply_turns SET status = ?, generated_body = COALESCE(?, generated_body), reason = ?, finished_at = ? WHERE id = ?",
      ).run(input.status, input.generated_body ?? null, input.reason ?? null, input.finished_at ?? null, id);
    },

    listReplyTurns(taskId: string): WechatReplyTurnRecord[] {
      return db.prepare("SELECT * FROM wechat_reply_turns WHERE task_id = ? ORDER BY id ASC").all(taskId) as WechatReplyTurnRecord[];
    },

    saveReplyPersona(record: WechatReplyPersonaRecord): void {
      db.prepare(
        `INSERT INTO wechat_reply_personas (task_id, payload_json, generated_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           generated_at = excluded.generated_at,
           updated_at = excluded.updated_at`,
      ).run(record.task_id, record.payload_json, record.generated_at, record.updated_at);
    },

    getReplyPersona(taskId: string): WechatReplyPersonaRecord | undefined {
      return db.prepare("SELECT * FROM wechat_reply_personas WHERE task_id = ?").get(taskId) as
        | WechatReplyPersonaRecord
        | undefined;
    },

    saveReplyTaskProgress(record: WechatReplyTaskProgressRecord): void {
      db.prepare(
        `INSERT INTO wechat_reply_task_progress
           (task_id, facts_json, asked_slots_json, stage_goal, updated_at, turn_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           facts_json = excluded.facts_json,
           asked_slots_json = excluded.asked_slots_json,
           stage_goal = excluded.stage_goal,
           updated_at = excluded.updated_at,
           turn_count = excluded.turn_count`,
      ).run(
        record.task_id,
        record.facts_json,
        record.asked_slots_json,
        record.stage_goal,
        record.updated_at,
        record.turn_count,
      );
    },

    getReplyTaskProgress(taskId: string): WechatReplyTaskProgressRecord | undefined {
      return db.prepare("SELECT * FROM wechat_reply_task_progress WHERE task_id = ?").get(taskId) as
        | WechatReplyTaskProgressRecord
        | undefined;
    },
  };
}

export type WechatAssistRepo = ReturnType<typeof createWechatAssistRepo>;
