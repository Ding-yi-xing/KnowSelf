import { createHash } from "node:crypto";
import type { WechatAssistSection } from "@knowself/contracts";

export type WechatAssistDraftStatus = "draft" | "sent" | "discarded";

export type WechatReplyTaskStatus = "starting" | "running" | "stopping" | "stopped" | "paused" | "failed";

export interface WechatReplyTask {
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

export interface WechatAssistDraft {
  id: string;
  contact_id: string;
  body: string;
  status: WechatAssistDraftStatus;
  created_at: string;
  sent_at: string | null;
  external_id: string | null;
}

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

export interface WechatAssistAuditEntry {
  at: string;
  action: WechatAssistAuditAction;
  draft_id: string;
  contact_id: string;
  reason?: string;
  external_id?: string;
}

export interface WechatConversationIdentity {
  account_scope: string;
  conversation_id: string;
  kind: "contact" | "group";
  visible_name: string;
}

export interface WechatUnreadMessage {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  received_at: string;
}

export interface WechatDesktopCapabilities {
  available: boolean;
  can_inspect_conversation: boolean;
  can_list_unread: boolean;
  can_send: boolean;
  can_lookup_send_result: boolean;
  transport_version: string;
  reason?: string;
}

export interface WechatSendResult {
  external_id?: string;
  sent_at?: string;
}

export interface WechatSendLookupResult {
  external_id: string;
  sent_at?: string;
}

export type WechatTransportFailureOutcome = "not_sent" | "unknown";

export class WechatTransportError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unsupported"
      | "target_mismatch"
      | "permission_denied"
      | "timeout"
      | "window_changed"
      | "send_failed",
    public readonly outcome: WechatTransportFailureOutcome = "unknown",
  ) {
    super(message);
    this.name = "WechatTransportError";
  }
}

/** Host-only contract. Concrete Windows UI Automation stays in dsh/knowself. */
export interface WechatDesktopTransport {
  probeCapabilities(): Promise<WechatDesktopCapabilities>;
  inspectCurrentConversation(): Promise<WechatConversationIdentity | null>;
  listUnreadMessages(): Promise<WechatUnreadMessage[]>;
  sendMessage(input: {
    contact_id: string;
    body: string;
    idempotency_key: string;
  }): Promise<WechatSendResult>;
  lookupSendResult(idempotencyKey: string): Promise<WechatSendLookupResult | null>;
  stop(): Promise<void>;
}

/** Legacy shape is kept as a compatibility adapter for existing test stubs. */
export interface WechatAssistTransport {
  send?(contactId: string, body: string): Promise<{ external_id?: string }>;
  /** Optional transport-level dedupe hook keyed by the stable draft id. */
  sendIdempotent?(
    contactId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<{ external_id?: string }>;
  desktop?: WechatDesktopTransport;
}

export interface WechatAssistAuditSink {
  append(entry: WechatAssistAuditEntry): void | Promise<void>;
}

interface WechatAssistSendAttemptRecord {
  draft_id: string;
  idempotency_key: string;
  contact_id: string;
  body_hash: string;
  target_fingerprint: string | null;
  status: "processing" | "sent" | "failed" | "uncertain";
  external_id: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  attempt_count: number;
  last_error: string | null;
  started_at: string;
  finished_at: string | null;
  reconciled_at: string | null;
}

interface ClaimWechatAssistSendInput {
  draft_id: string;
  idempotency_key: string;
  contact_id: string;
  body_hash: string;
  target_fingerprint?: string;
  lease_owner: string;
  now: string;
  lease_until: string;
}

/** Persistence injected by the host; policy and transport stay in this adapter. */
export interface WechatAssistPersistence {
  createDraft(record: WechatAssistDraft): void;
  listDrafts(): WechatAssistDraft[];
  getDraft(id: string): WechatAssistDraft | undefined;
  updateDraft(record: WechatAssistDraft): void;
  listSuccessfulSendTimes(since: string): number[];
  appendAudit(record: WechatAssistAuditEntry): void;
  getSendAttempt?(draftId: string): WechatAssistSendAttemptRecord | undefined;
  getSendAttemptByIdempotencyKey?(key: string): WechatAssistSendAttemptRecord | undefined;
  claimSendAttempt?(input: ClaimWechatAssistSendInput): WechatAssistSendAttemptRecord | undefined;
  markSendSent?(draftId: string, leaseOwner: string, externalId: string | null, at: string): void;
  markSendFailed?(draftId: string, leaseOwner: string, reason: string, at: string): void;
  markSendUncertain?(draftId: string, leaseOwner: string, reason: string, at: string): void;
  reconcileSend?(draftId: string, externalId: string | null, at: string): void;
  createReplyTask?(record: WechatReplyTask): void;
  getReplyTask?(id: string): WechatReplyTask | undefined;
  getActiveReplyTask?(accountScope: string): WechatReplyTask | undefined;
  listReplyTasks?(): WechatReplyTask[];
  updateReplyTask?(record: WechatReplyTask): void;
  stopReplyTask?(id: string, at: string, reason?: string): WechatReplyTask | undefined;
}

export interface WechatAssistAdapterDeps {
  transport: WechatAssistTransport;
  audit: WechatAssistAuditSink;
  persistence?: WechatAssistPersistence;
  now?: () => Date;
  createId?: () => string;
}

export interface WechatAssistAdapter {
  createDraft(input: { contact_id: string; body: string }): Promise<WechatAssistDraft>;
  listDrafts(): WechatAssistDraft[];
  discardDraft(id: string): Promise<WechatAssistDraft>;
  sendDraft(id: string, authorization: { explicit: true }): Promise<WechatAssistDraft>;
  listReplyTasks(): WechatReplyTask[];
  startReplyTask(input: {
    account_scope?: string;
    conversation_id: string;
    contact_id: string;
    objective: string;
    provider_id: string;
    model_id: string;
    history_authorized: boolean;
  }): Promise<WechatReplyTask>;
  stopReplyTask(id: string, reason?: string): Promise<WechatReplyTask>;
}

export class WechatAssistError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "DISABLED"
      | "DRAFT_NOT_FOUND"
      | "INVALID_DRAFT"
      | "NOT_ALLOWLISTED"
      | "SEND_NOT_ENABLED"
      | "EXPLICIT_AUTH_REQUIRED"
      | "RATE_LIMITED"
      | "SEND_IN_PROGRESS"
      | "TRANSPORT_UNAVAILABLE"
      | "TARGET_MISMATCH"
      | "SEND_UNCERTAIN"
      | "AUDIT_FAILED"
      | "REPLY_TASK_ACTIVE"
      | "REPLY_TASK_NOT_FOUND"
      | "REPLY_TASK_INVALID"
      | "REPLY_TASK_UNAVAILABLE",
  ) {
    super(message);
    this.name = "WechatAssistError";
  }
}

const HOUR_MS = 3_600_000;
const SEND_LEASE_MS = 120_000;

function defaultId(): string {
  return `wechat-draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function copyDraft(draft: WechatAssistDraft): WechatAssistDraft {
  return { ...draft };
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function targetFingerprint(identity: WechatConversationIdentity): string {
  return [identity.account_scope, identity.kind, identity.conversation_id, identity.visible_name].join("|");
}

function conversationMatchesDraft(
  identity: WechatConversationIdentity | null,
  draft: WechatAssistDraft,
): identity is WechatConversationIdentity {
  return identity !== null &&
    (identity.conversation_id === draft.contact_id || identity.visible_name === draft.contact_id);
}

/**
 * Host-only boundary for WeChat assistance.
 *
 * The adapter owns safety policy and draft state. A concrete desktop bridge is
 * injected as `transport`; no WeChat or Electron dependency crosses into the
 * domain packages.
 */
export function createWechatAssistAdapter(
  policy: WechatAssistSection,
  deps: WechatAssistAdapterDeps,
): WechatAssistAdapter {
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? defaultId;
  const drafts = new Map<string, WechatAssistDraft>();
  const successfulSends: number[] = [];
  // The SQLite record intentionally remains `draft` until the external send
  // succeeds. This in-process claim closes the concurrent-request race while
  // the stable draft id protects retries at the transport boundary.
  const inFlight = new Set<string>();
  const replyTasks = new Map<string, WechatReplyTask>();

  function desktopTransport(): WechatDesktopTransport | undefined {
    return deps.transport.desktop;
  }

  function updateDraftAsSent(
    draft: WechatAssistDraft,
    externalId: string | null,
    sentAt: string,
  ): void {
    draft.status = "sent";
    draft.sent_at = sentAt;
    draft.external_id = externalId;
    if (deps.persistence !== undefined) deps.persistence.updateDraft(draft);
    else {
      drafts.set(draft.id, draft);
      successfulSends.push(Date.parse(sentAt));
    }
  }

  async function reconcileExistingSend(
    draft: WechatAssistDraft,
    existing: WechatAssistSendAttemptRecord,
  ): Promise<WechatAssistDraft | undefined> {
    if (existing.status === "sent") {
      updateDraftAsSent(draft, existing.external_id, existing.finished_at ?? now().toISOString());
      return copyDraft(draft);
    }
    const transport = desktopTransport();
    if (transport === undefined || (existing.status !== "uncertain" && existing.status !== "failed")) {
      return undefined;
    }
    const result = await transport.lookupSendResult(existing.idempotency_key);
    if (result === null) return undefined;
    deps.persistence?.reconcileSend?.(draft.id, result.external_id, now().toISOString());
    const sentAt = result.sent_at ?? now().toISOString();
    updateDraftAsSent(draft, result.external_id, sentAt);
    await audit({
      at: sentAt,
      action: "send_succeeded",
      draft_id: draft.id,
      contact_id: draft.contact_id,
      external_id: result.external_id,
    });
    return copyDraft(draft);
  }

  async function audit(entry: WechatAssistAuditEntry): Promise<void> {
    try {
      await deps.audit.append(entry);
      deps.persistence?.appendAudit(entry);
    } catch (error) {
      throw new WechatAssistError(
        `wechat assist audit failed: ${error instanceof Error ? error.message : String(error)}`,
        "AUDIT_FAILED",
      );
    }
  }

  async function reject(
    draft: WechatAssistDraft,
    code: WechatAssistError["code"],
    reason: string,
  ): Promise<never> {
    await audit({
      at: now().toISOString(),
      action: "send_rejected",
      draft_id: draft.id,
      contact_id: draft.contact_id,
      reason,
    });
    throw new WechatAssistError(reason, code);
  }

  function getDraft(id: string): WechatAssistDraft {
    const draft = deps.persistence?.getDraft(id) ?? drafts.get(id);
    if (draft === undefined) throw new WechatAssistError("draft not found", "DRAFT_NOT_FOUND");
    return { ...draft };
  }

  function pruneSends(at: number): void {
    while (successfulSends[0] !== undefined && at - successfulSends[0] >= HOUR_MS) {
      successfulSends.shift();
    }
  }

  function recentSuccessfulSends(at: number): number[] {
    if (deps.persistence !== undefined) {
      return deps.persistence.listSuccessfulSendTimes(new Date(at - HOUR_MS).toISOString());
    }
    pruneSends(at);
    return successfulSends;
  }

  function copyReplyTask(task: WechatReplyTask): WechatReplyTask {
    return { ...task };
  }

  function getReplyTask(id: string): WechatReplyTask {
    const task = deps.persistence?.getReplyTask?.(id) ?? replyTasks.get(id);
    if (task === undefined) throw new WechatAssistError("reply task not found", "REPLY_TASK_NOT_FOUND");
    return copyReplyTask(task);
  }

  return {
    async createDraft(input) {
      if (!policy.enabled) throw new WechatAssistError("wechat assist is disabled", "DISABLED");
      const contactId = input.contact_id.trim();
      const body = input.body.trim();
      if (contactId === "" || body === "") {
        throw new WechatAssistError("contact_id and body are required", "INVALID_DRAFT");
      }
      const draft: WechatAssistDraft = {
        id: createId(),
        contact_id: contactId,
        body,
        status: "draft",
        created_at: now().toISOString(),
        sent_at: null,
        external_id: null,
      };
      if (deps.persistence !== undefined) deps.persistence.createDraft(draft);
      else drafts.set(draft.id, draft);
      await audit({
        at: draft.created_at,
        action: "draft_created",
        draft_id: draft.id,
        contact_id: draft.contact_id,
      });
      return copyDraft(draft);
    },

    listDrafts() {
      return (deps.persistence?.listDrafts() ?? [...drafts.values()]).map(copyDraft);
    },

    async discardDraft(id) {
      const draft = getDraft(id);
      if (draft.status !== "draft") {
        throw new WechatAssistError("only drafts can be discarded", "INVALID_DRAFT");
      }
      draft.status = "discarded";
      if (deps.persistence !== undefined) deps.persistence.updateDraft(draft);
      else drafts.set(draft.id, draft);
      await audit({
        at: now().toISOString(),
        action: "draft_discarded",
        draft_id: draft.id,
        contact_id: draft.contact_id,
      });
      return copyDraft(draft);
    },

    async sendDraft(id, authorization) {
      const draft = getDraft(id);
      if (draft.status !== "draft") {
        throw new WechatAssistError("only drafts can be sent", "INVALID_DRAFT");
      }
      if (!policy.enabled) return reject(draft, "DISABLED", "wechat assist is disabled");
      if (authorization.explicit !== true) {
        return reject(draft, "EXPLICIT_AUTH_REQUIRED", "explicit send authorization is required");
      }
      if (policy.drafts_only || !policy.send_enabled) {
        return reject(draft, "SEND_NOT_ENABLED", "sending is disabled; draft remains available");
      }
      if (!policy.allowlist.includes(draft.contact_id)) {
        return reject(draft, "NOT_ALLOWLISTED", "contact is not in the WeChat allowlist");
      }

      const ledger = deps.persistence;
      const existing = ledger?.getSendAttempt?.(draft.id);
      if (existing !== undefined) {
        const reconciled = await reconcileExistingSend(draft, existing);
        if (reconciled !== undefined) return reconciled;
      }

      const at = now().getTime();
      const sentTimes = recentSuccessfulSends(at);
      const last = sentTimes.at(-1);
      if (
        sentTimes.length >= policy.max_messages_per_hour ||
        (last !== undefined && at - last < policy.cooldown_ms)
      ) {
        return reject(draft, "RATE_LIMITED", "WeChat send rate limit reached");
      }

      const transport = desktopTransport();
      if (transport === undefined && deps.transport.send === undefined && deps.transport.sendIdempotent === undefined) {
        return reject(draft, "TRANSPORT_UNAVAILABLE", "desktop WeChat transport is not configured");
      }

      let preflightTargetFingerprint: string | undefined;
      let preflightCapabilities: WechatDesktopCapabilities | undefined;
      if (transport !== undefined) {
        preflightCapabilities = await transport.probeCapabilities();
        if (
          !preflightCapabilities.available ||
          !preflightCapabilities.can_inspect_conversation ||
          !preflightCapabilities.can_send ||
          !preflightCapabilities.can_lookup_send_result
        ) {
          return reject(
            draft,
            "TRANSPORT_UNAVAILABLE",
            preflightCapabilities.reason ?? "desktop WeChat transport cannot safely send",
          );
        }
        const current = await transport.inspectCurrentConversation();
        if (!conversationMatchesDraft(current, draft)) {
          return reject(draft, "TARGET_MISMATCH", "current WeChat conversation does not match the draft target");
        }
        preflightTargetFingerprint = targetFingerprint(current);
      }

      let leaseOwner = `${createId()}-lease`;
      const nowIso = now().toISOString();
      const leaseUntil = new Date(at + SEND_LEASE_MS).toISOString();
      const ledgerInput: ClaimWechatAssistSendInput = {
        draft_id: draft.id,
        idempotency_key: draft.id,
        contact_id: draft.contact_id,
        body_hash: bodyHash(draft.body),
        ...(preflightTargetFingerprint === undefined ? {} : { target_fingerprint: preflightTargetFingerprint }),
        lease_owner: leaseOwner,
        now: nowIso,
        lease_until: leaseUntil,
      };

      if (ledger?.claimSendAttempt !== undefined) {
        const claimed = ledger.claimSendAttempt(ledgerInput);
        if (claimed?.status === "sent") {
          updateDraftAsSent(draft, claimed.external_id, claimed.finished_at ?? nowIso);
          return copyDraft(draft);
        }
        if (claimed === undefined || claimed.lease_owner !== leaseOwner) {
          return reject(draft, "SEND_IN_PROGRESS", "this draft is already being sent or awaiting reconciliation");
        }
        leaseOwner = claimed.lease_owner ?? leaseOwner;
      } else if (inFlight.has(draft.id)) {
        return reject(draft, "SEND_IN_PROGRESS", "this draft is already being sent");
      }

      await audit({
        at: nowIso,
        action: "send_attempted",
        draft_id: draft.id,
        contact_id: draft.contact_id,
      });
      inFlight.add(draft.id);
      try {
        let result: WechatSendResult;
        if (transport !== undefined) {
          if (preflightCapabilities === undefined || preflightTargetFingerprint === undefined) {
            throw new WechatTransportError("desktop WeChat preflight did not complete", "unsupported", "not_sent");
          }
          result = await transport.sendMessage({
            contact_id: draft.contact_id,
            body: draft.body,
            idempotency_key: draft.id,
          });
          if (!conversationMatchesDraft(await transport.inspectCurrentConversation(), draft)) {
            throw new WechatTransportError(
              "desktop WeChat conversation changed during send",
              "window_changed",
            );
          }
        } else if (deps.transport.sendIdempotent !== undefined) {
          result = await deps.transport.sendIdempotent(draft.contact_id, draft.body, draft.id);
        } else {
          result = await deps.transport.send!(draft.contact_id, draft.body);
        }
        const sentAt = result.sent_at ?? now().toISOString();
        try {
          updateDraftAsSent(draft, result.external_id ?? null, sentAt);
          ledger?.markSendSent?.(draft.id, leaseOwner, result.external_id ?? null, sentAt);
        } catch (error) {
          ledger?.markSendUncertain?.(
            draft.id,
            leaseOwner,
            error instanceof Error ? error.message : String(error),
            now().toISOString(),
          );
          throw new WechatAssistError(
            "external send succeeded but local state is uncertain; reconcile before retrying",
            "SEND_UNCERTAIN",
          );
        }
        await audit({
          at: sentAt,
          action: "send_succeeded",
          draft_id: draft.id,
          contact_id: draft.contact_id,
          ...(draft.external_id === null ? {} : { external_id: draft.external_id }),
        });
        return copyDraft(draft);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const knownFailure = error instanceof WechatTransportError;
        const failureOutcome = knownFailure ? error.outcome : "unknown";
        if (failureOutcome === "unknown") {
          ledger?.markSendUncertain?.(draft.id, leaseOwner, reason, now().toISOString());
        } else {
          ledger?.markSendFailed?.(draft.id, leaseOwner, reason, now().toISOString());
        }
        await audit({
          at: now().toISOString(),
          action: "send_failed",
          draft_id: draft.id,
          contact_id: draft.contact_id,
          reason,
        });
        if (error instanceof WechatAssistError) throw error;
        if (error instanceof WechatTransportError && error.code === "target_mismatch") {
          throw new WechatAssistError(reason, "TARGET_MISMATCH");
        }
        if (failureOutcome === "unknown") {
          throw new WechatAssistError(reason, "SEND_UNCERTAIN");
        }
        if (error instanceof WechatTransportError && error.code === "unsupported") {
          throw new WechatAssistError(reason, "TRANSPORT_UNAVAILABLE");
        }
        throw error;
      } finally {
        inFlight.delete(draft.id);
      }
    },

    listReplyTasks() {
      return (deps.persistence?.listReplyTasks?.() ?? [...replyTasks.values()]).map(copyReplyTask);
    },

    async startReplyTask(input) {
      if (!policy.enabled) throw new WechatAssistError("wechat assist is disabled", "DISABLED");
      const conversationId = input.conversation_id.trim();
      const contactId = input.contact_id.trim();
      const objective = input.objective.trim();
      const providerId = input.provider_id.trim();
      const modelId = input.model_id.trim();
      if (conversationId === "" || contactId === "" || objective === "" || providerId === "" || modelId === "") {
        throw new WechatAssistError("conversation, contact, objective, provider and model are required", "REPLY_TASK_INVALID");
      }
      const accountScope = input.account_scope?.trim() || "default";
      if (deps.persistence?.getActiveReplyTask?.(accountScope) !== undefined) {
        throw new WechatAssistError("only one active reply task is allowed per WeChat account", "REPLY_TASK_ACTIVE");
      }
      const createdAt = now().toISOString();
      const task: WechatReplyTask = {
        id: createId(),
        account_scope: accountScope,
        conversation_id: conversationId,
        contact_id: contactId,
        objective,
        provider_id: providerId,
        model_id: modelId,
        history_authorized: input.history_authorized,
        authorization_version: 1,
        status: "starting",
        stop_reason: null,
        lease_owner: null,
        lease_until: null,
        turn_count: 0,
        send_count: 0,
        created_at: createdAt,
        updated_at: createdAt,
        stopped_at: null,
      };
      if (deps.persistence?.createReplyTask !== undefined) deps.persistence.createReplyTask(task);
      else replyTasks.set(task.id, task);
      // A transport alone is not an auto-reply worker. Until inbound polling,
      // context assembly, provider generation, and cancellation are composed,
      // never advertise a task as running or probe/send through the transport.
      const status: WechatReplyTaskStatus = "paused";
      const reason = "自动回复 worker 尚未装配（新入站监听与模型回复循环未接入）";
      task.status = status;
      task.stop_reason = reason;
      task.updated_at = now().toISOString();
      if (deps.persistence?.updateReplyTask !== undefined) deps.persistence.updateReplyTask(task);
      else replyTasks.set(task.id, task);
      await audit({
        at: task.updated_at,
        action: status === "paused" ? "reply_task_paused" : "reply_task_started",
        draft_id: task.id,
        contact_id: task.contact_id,
        ...(reason === null ? {} : { reason }),
      });
      return copyReplyTask(task);
    },

    async stopReplyTask(id, reason = "user_stopped") {
      const existing = getReplyTask(id);
      if (existing.status === "stopped") return existing;
      const at = now().toISOString();
      const stopped = deps.persistence?.stopReplyTask?.(id, at, reason) ?? (() => {
        existing.status = "stopped";
        existing.stop_reason = reason;
        existing.lease_owner = null;
        existing.lease_until = null;
        existing.updated_at = at;
        existing.stopped_at ??= at;
        replyTasks.set(id, existing);
        return existing;
      })();
      if (desktopTransport() !== undefined) {
        try { await desktopTransport()!.stop(); } catch { /* stopping is persisted even if UIA cleanup fails */ }
      }
      await audit({
        at,
        action: "reply_task_stopped",
        draft_id: stopped.id,
        contact_id: stopped.contact_id,
        reason,
      });
      return copyReplyTask(stopped);
    },
  };
}
