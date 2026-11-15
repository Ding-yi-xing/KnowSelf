import type { ProfileDb } from "../db";

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
  | "reply_task_paused";

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

    listSuccessfulSendTimes(since: string): number[] {
      const rows = db
        .prepare(
          `SELECT sent_at FROM wechat_assist_drafts
           WHERE status = 'sent' AND sent_at >= ? ORDER BY sent_at ASC`,
        )
        .all(since) as Array<{ sent_at: string | null }>;
      return rows.flatMap((row) => {
        if (row.sent_at === null) return [];
        const at = Date.parse(row.sent_at);
        return Number.isNaN(at) ? [] : [at];
      });
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
        if (
          existing?.status === "processing" &&
          existing.lease_until !== null &&
          existing.lease_until > input.now
        ) {
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
        `INSERT INTO wechat_reply_turns
          (task_id, inbound_message_id, generated_body, status, reason, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(record.task_id, record.inbound_message_id, record.generated_body, record.status, record.reason, record.created_at, record.finished_at);
      return Number(result.lastInsertRowid);
    },

    updateReplyTurn(id: number, input: { status: WechatReplyTurnStatus; generated_body?: string | null; reason?: string | null; finished_at?: string | null }): void {
      db.prepare(
        "UPDATE wechat_reply_turns SET status = ?, generated_body = COALESCE(?, generated_body), reason = ?, finished_at = ? WHERE id = ?",
      ).run(input.status, input.generated_body ?? null, input.reason ?? null, input.finished_at ?? null, id);
    },

    listReplyTurns(taskId: string): WechatReplyTurnRecord[] {
      return db.prepare("SELECT * FROM wechat_reply_turns WHERE task_id = ? ORDER BY id ASC").all(taskId) as WechatReplyTurnRecord[];
    },
  };
}

export type WechatAssistRepo = ReturnType<typeof createWechatAssistRepo>;
