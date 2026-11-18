import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createProfileStore } from "../src/store";
import { AutowriteRejectedError } from "../src/errors";
import type { ProfileChangeEvent } from "@knowself/contracts";

describe("createProfileStore", () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  function makeStore() {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ps-"));
    return createProfileStore({
      dbPath: join(tmpDir, "profile.sqlite"),
      sourcesDir: join(tmpDir, "sources"),
      exportsDir: join(tmpDir, "exports"),
    });
  }

  it("在干净的临时目录下能成功初始化，返回 ProfileStore 实例", () => {
    const store = makeStore();
    expect(store).toHaveProperty("core");
    expect(store).toHaveProperty("cards");
    expect(store).toHaveProperty("journal");
    expect(store).toHaveProperty("sources");
    expect(store).toHaveProperty("proposals");
    expect(store).toHaveProperty("links");
    expect(store).toHaveProperty("events");
    expect(store).toHaveProperty("write");
    expect(store).toHaveProperty("exportProfile");
    expect(store).toHaveProperty("close");
    store.close();
  });

  it("createProfileStore 后再次调用打开同一 dbPath 不抛错", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ps-"));
    const dbPath = join(tmpDir, "profile.sqlite");
    const s1 = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    s1.close();
    const s2 = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    expect(s2).toBeDefined();
    s2.close();
  });

  it("微信协助草稿和审计在重新打开 store 后仍可读取", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ps-"));
    const dbPath = join(tmpDir, "profile.sqlite");
    const first = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    first.wechatAssist.createDraft({
      id: "draft-1",
      contact_id: "alice",
      body: "你好",
      status: "draft",
      created_at: "2026-11-14T10:00:00.000Z",
      sent_at: null,
      external_id: null,
    });
    first.wechatAssist.appendAudit({
      at: "2026-11-14T10:00:00.000Z",
      action: "draft_created",
      draft_id: "draft-1",
      contact_id: "alice",
    });
    first.close();

    const second = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    expect(second.wechatAssist.listDrafts()).toEqual([
      expect.objectContaining({ id: "draft-1", contact_id: "alice", status: "draft" }),
    ]);
    expect(second.wechatAssist.listAudit("draft-1")).toEqual([
      expect.objectContaining({ action: "draft_created", draft_id: "draft-1" }),
    ]);
    second.close();
  });

  it("升级旧微信审计表时保留记录并允许记录历史上下文共享", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ks-ps-"));
    const dbPath = join(tmpDir, "profile.sqlite");
    const first = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    first.wechatAssist.appendAudit({
      at: "2026-11-15T10:00:00.000Z",
      action: "reply_task_started",
      draft_id: "task-legacy",
      contact_id: "contact-hash",
    });
    first.close();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP INDEX idx_wechat_assist_audit_draft;
      DROP INDEX idx_wechat_assist_audit_at;
      ALTER TABLE wechat_assist_audit RENAME TO wechat_assist_audit_newer;
      CREATE TABLE wechat_assist_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN (
          'draft_created','draft_discarded','send_rejected',
          'send_attempted','send_succeeded','send_failed',
          'reply_task_started','reply_task_stopped','reply_task_paused'
        )),
        draft_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        reason TEXT,
        external_id TEXT
      );
      INSERT INTO wechat_assist_audit
        (id, at, action, draft_id, contact_id, reason, external_id)
      SELECT id, at, action, draft_id, contact_id, reason, external_id
      FROM wechat_assist_audit_newer;
      DROP TABLE wechat_assist_audit_newer;
    `);
    legacy.close();

    const upgraded = createProfileStore({ dbPath, sourcesDir: tmpDir, exportsDir: tmpDir });
    upgraded.wechatAssist.appendAudit({
      at: "2026-11-15T10:01:00.000Z",
      action: "reply_context_shared",
      draft_id: "task-legacy",
      contact_id: "contact-hash",
      reason: "count:1",
    });
    expect(upgraded.wechatAssist.listAudit("task-legacy").map((entry) => entry.action)).toEqual([
      "reply_task_started",
      "reply_context_shared",
    ]);
    upgraded.close();
  });

  it("微信发送 ledger 支持条件 claim、lease 过期和对账", () => {
    const store = makeStore();
    store.wechatAssist.createDraft({
      id: "draft-ledger",
      contact_id: "alice",
      body: "你好",
      status: "draft",
      created_at: "2026-11-14T10:00:00.000Z",
      sent_at: null,
      external_id: null,
    });

    const first = store.wechatAssist.claimSendAttempt({
      draft_id: "draft-ledger",
      idempotency_key: "draft-ledger",
      contact_id: "alice",
      body_hash: "hash-1",
      lease_owner: "owner-1",
      now: "2026-11-14T10:00:00.000Z",
      lease_until: "2026-11-14T10:02:00.000Z",
    });
    expect(first).toMatchObject({ status: "processing", attempt_count: 1, lease_owner: "owner-1" });

    const blocked = store.wechatAssist.claimSendAttempt({
      draft_id: "draft-ledger",
      idempotency_key: "draft-ledger",
      contact_id: "alice",
      body_hash: "hash-1",
      lease_owner: "owner-2",
      now: "2026-11-14T10:01:00.000Z",
      lease_until: "2026-11-14T10:03:00.000Z",
    });
    expect(blocked).toBeUndefined();

    const expired = store.wechatAssist.claimSendAttempt({
      draft_id: "draft-ledger",
      idempotency_key: "draft-ledger",
      contact_id: "alice",
      body_hash: "hash-1",
      lease_owner: "owner-2",
      now: "2026-11-14T10:02:01.000Z",
      lease_until: "2026-11-14T10:04:00.000Z",
    });
    expect(expired).toBeUndefined();
    expect(store.wechatAssist.getSendAttempt("draft-ledger")).toMatchObject({
      status: "uncertain",
      last_error: "expired_send_lease_requires_reconciliation",
    });
    store.wechatAssist.reconcileSendNotSent(
      "draft-ledger",
      "transport confirmed no message was sent",
      "2026-11-14T10:02:40.000Z",
    );
    const reclaimed = store.wechatAssist.claimSendAttempt({
      draft_id: "draft-ledger",
      idempotency_key: "draft-ledger",
      contact_id: "alice",
      body_hash: "hash-1",
      lease_owner: "owner-2",
      now: "2026-11-14T10:03:00.000Z",
      lease_until: "2026-11-14T10:05:00.000Z",
    });
    expect(reclaimed).toMatchObject({ status: "processing", attempt_count: 2, lease_owner: "owner-2" });

    store.wechatAssist.markSendUncertain(
      "draft-ledger",
      "owner-2",
      "local write failed",
      "2026-11-14T10:04:00.000Z",
    );
    store.wechatAssist.reconcileSend(
      "draft-ledger",
      "external-1",
      "2026-11-14T10:04:30.000Z",
    );
    expect(store.wechatAssist.getSendAttempt("draft-ledger")).toMatchObject({
      status: "sent",
      external_id: "external-1",
      attempt_count: 2,
    });
    store.close();
  });

  it("微信发送 ledger 拒绝幂等键、正文和目标身份漂移", () => {
    const store = makeStore();
    store.wechatAssist.createDraft({
      id: "draft-identity-1",
      contact_id: "alice",
      body: "你好",
      status: "draft",
      created_at: "2026-11-14T10:00:00.000Z",
      sent_at: null,
      external_id: null,
    });
    store.wechatAssist.createDraft({
      id: "draft-identity-2",
      contact_id: "alice",
      body: "你好",
      status: "draft",
      created_at: "2026-11-14T10:01:00.000Z",
      sent_at: null,
      external_id: null,
    });

    const base = {
      idempotency_key: "stable-key",
      contact_id: "alice",
      body_hash: "hash-1",
      lease_owner: "owner-1",
      now: "2026-11-14T10:00:00.000Z",
      lease_until: "2026-11-14T10:02:00.000Z",
    };
    store.wechatAssist.claimSendAttempt({ draft_id: "draft-identity-1", ...base });

    expect(() => store.wechatAssist.claimSendAttempt({
      draft_id: "draft-identity-2",
      ...base,
      lease_owner: "owner-2",
    })).toThrow("idempotency key is already bound to another draft");

    expect(() => store.wechatAssist.claimSendAttempt({
      draft_id: "draft-identity-1",
      ...base,
      body_hash: "hash-2",
      now: "2026-11-14T10:03:00.000Z",
      lease_until: "2026-11-14T10:05:00.000Z",
    })).toThrow("send attempt identity does not match the existing draft");
    store.close();
  });

  it("store.write 正常派发 core 写入并触发 events", () => {
    const store = makeStore();
    const received: ProfileChangeEvent[] = [];
    store.events.on((e) => {
      received.push(e);
    });
    store.write({ target: "core", body: "hello world", provenance: "user" }, { callerKind: "ui" });
    expect(received).toHaveLength(1);
    expect(received[0].ref_kind).toBe("core");
    expect(received[0].ref_id).toBe("core_main");
    const core = store.core.get();
    expect(core.body).toBe("hello world");
  });

  it("store.write 在 callerKind='ingestion' + provenance='user' 时抛 AutowriteRejectedError", () => {
    const store = makeStore();
    expect(() =>
      store.write({ target: "core", body: "x", provenance: "user" }, { callerKind: "ingestion" }),
    ).toThrow(AutowriteRejectedError);
    store.close();
  });

  it("store.exportProfile 调用 export 模块返回 ExportResponse 形状", async () => {
    const store = makeStore();
    store.write({ target: "core", body: "test", provenance: "user" }, { callerKind: "ui" });
    const result = await store.exportProfile({ format: "json" });
    expect(result).toHaveProperty("download_path");
    expect(result).toHaveProperty("format", "json");
    expect(result).toHaveProperty("size_bytes");
    expect(result.size_bytes).toBeGreaterThan(0);
    const fullPath = join(tmpDir, "exports", result.download_path);
    expect(existsSync(fullPath)).toBe(true);
    store.close();
  });

  it("store.close 后再调 write 抛错", () => {
    const store = makeStore();
    store.close();
    expect(() =>
      store.write({ target: "core", body: "x", provenance: "user" }, { callerKind: "ui" }),
    ).toThrow();
  });

  it("reply task lease is exclusive, reclaimable after expiry, and fences old owners", () => {
    const store = makeStore();
    const task = {
      id: "reply-task-1", account_scope: "account-1", conversation_id: "conv-a", contact_id: "alice",
      objective: "reply", provider_id: "provider-1", model_id: "model-1", history_authorized: false,
      authorization_version: 1, status: "starting" as const, stop_reason: null, lease_owner: null,
      lease_until: null, turn_count: 0, send_count: 0, created_at: "2026-11-16T10:00:00.000Z",
      updated_at: "2026-11-16T10:00:00.000Z", stopped_at: null,
    };
    store.wechatAssist.createReplyTask(task);
    expect(store.wechatAssist.claimReplyTaskLease({
      id: task.id, owner: "owner-1", now: "2026-11-16T10:00:00.000Z", lease_until: "2026-11-16T10:00:30.000Z",
    })).toBe(true);
    expect(store.wechatAssist.claimReplyTaskLease({
      id: task.id, owner: "owner-2", now: "2026-11-16T10:00:10.000Z", lease_until: "2026-11-16T10:00:40.000Z",
    })).toBe(false);

    const turn = {
      task_id: task.id, inbound_message_id: "inbound-1", generated_body: null, status: "started" as const,
      reason: null, created_at: "2026-11-16T10:00:10.000Z", finished_at: null,
    };
    const turnId = store.wechatAssist.createOwnedReplyTurn("owner-1", turn);
    expect(turnId).toBeGreaterThan(0);
    expect(store.wechatAssist.createOwnedReplyTurn("owner-1", turn)).toBe(0);

    expect(store.wechatAssist.claimReplyTaskLease({
      id: task.id, owner: "owner-2", now: "2026-11-16T10:00:31.000Z", lease_until: "2026-11-16T10:01:01.000Z",
    })).toBe(true);
    expect(store.wechatAssist.finishOwnedReplyTurn("owner-1", turnId, {
      status: "sent", finished_at: "2026-11-16T10:00:32.000Z",
    })).toBe(false);
    expect(store.wechatAssist.finishOwnedReplyTurn("owner-2", turnId, {
      status: "generated", generated_body: "reply", finished_at: "2026-11-16T10:00:33.000Z",
    })).toBe(true);
    store.wechatAssist.stopReplyTask(task.id, "2026-11-16T10:00:34.000Z");
    expect(store.wechatAssist.finishOwnedReplyTurn("owner-2", turnId, {
      status: "sent", finished_at: "2026-11-16T10:00:35.000Z",
    })).toBe(false);
    store.close();
  });

  it("only pauses a reply task that is still starting", () => {
    const store = makeStore();
    const task = {
      id: "reply-task-pause", account_scope: "account-1", conversation_id: "conv-a", contact_id: "alice",
      objective: "reply", provider_id: "provider-1", model_id: "model-1", history_authorized: false,
      authorization_version: 1, status: "starting" as const, stop_reason: null, lease_owner: null,
      lease_until: null, turn_count: 0, send_count: 0, created_at: "2026-11-16T10:00:00.000Z",
      updated_at: "2026-11-16T10:00:00.000Z", stopped_at: null,
    };
    store.wechatAssist.createReplyTask(task);
    expect(store.wechatAssist.pauseStartingReplyTask({
      id: task.id, at: "2026-11-16T10:00:01.000Z", reason: "unsupported",
    })).toBe(true);
    expect(store.wechatAssist.pauseStartingReplyTask({
      id: task.id, at: "2026-11-16T10:00:02.000Z", reason: "late pause",
    })).toBe(false);
    expect(store.wechatAssist.getReplyTask(task.id)).toMatchObject({ status: "paused", stop_reason: "unsupported" });
    store.wechatAssist.stopReplyTask(task.id, "2026-11-16T10:00:03.000Z");
    expect(store.wechatAssist.pauseStartingReplyTask({
      id: task.id, at: "2026-11-16T10:00:04.000Z", reason: "must not overwrite stopped",
    })).toBe(false);
    expect(store.wechatAssist.getReplyTask(task.id)?.status).toBe("stopped");
    store.close();
  });

  it("startup recovery pauses expired tasks and makes interrupted sends non-retryable", () => {
    const store = makeStore();
    const task = {
      id: "reply-recovery", account_scope: "account-1", conversation_id: "conv-a", contact_id: "alice",
      objective: "reply", provider_id: "provider-1", model_id: "model-1", history_authorized: true,
      authorization_version: 1, status: "running" as const, stop_reason: null, lease_owner: "dead-worker",
      lease_until: "2026-11-16T10:00:30.000Z", turn_count: 1, send_count: 0,
      created_at: "2026-11-16T10:00:00.000Z", updated_at: "2026-11-16T10:00:00.000Z", stopped_at: null,
    };
    store.wechatAssist.createReplyTask(task);
    store.wechatAssist.createReplyTurn({
      task_id: task.id, inbound_message_id: "inbound-recovery", generated_body: "reply",
      status: "generated", reason: null, created_at: task.created_at, finished_at: null,
    });
    store.wechatAssist.createDraft({
      id: "draft-recovery", contact_id: "alice", body: "reply", status: "draft",
      created_at: task.created_at, sent_at: null, external_id: null,
    });
    store.wechatAssist.claimSendAttempt({
      draft_id: "draft-recovery", idempotency_key: "key-recovery", contact_id: "alice",
      body_hash: "hash", lease_owner: "dead-worker", now: task.created_at, lease_until: task.lease_until,
    });

    expect(store.wechatAssist.recoverInterruptedWork("2026-11-16T10:01:00.000Z")).toEqual({ tasks: 1, turns: 1, sends: 1 });
    expect(store.wechatAssist.getReplyTask(task.id)).toMatchObject({ status: "paused", lease_owner: null });
    expect(store.wechatAssist.listReplyTurns(task.id)[0]).toMatchObject({ status: "uncertain" });
    expect(store.wechatAssist.getSendAttempt("draft-recovery")).toMatchObject({ status: "uncertain" });
    expect(store.wechatAssist.claimSendAttempt({
      draft_id: "draft-recovery", idempotency_key: "key-recovery", contact_id: "alice",
      body_hash: "hash", lease_owner: "new-worker", now: "2026-11-16T10:02:00.000Z", lease_until: "2026-11-16T10:02:30.000Z",
    })).toBeUndefined();
    store.close();
  });

  it("history authorization revocation versions, pauses and clears unfinished generated text", () => {
    const store = makeStore();
    const task = {
      id: "reply-revoke", account_scope: "account-1", conversation_id: "conv-a", contact_id: "alice",
      objective: "reply", provider_id: "provider-1", model_id: "model-1", history_authorized: true,
      authorization_version: 4, status: "running" as const, stop_reason: null, lease_owner: "owner-1",
      lease_until: "2026-11-16T10:00:30.000Z", turn_count: 1, send_count: 0,
      created_at: "2026-11-16T10:00:00.000Z", updated_at: "2026-11-16T10:00:00.000Z", stopped_at: null,
    };
    store.wechatAssist.createReplyTask(task);
    store.wechatAssist.createReplyTurn({
      task_id: task.id, inbound_message_id: "inbound-revoke", generated_body: "derived text",
      status: "generated", reason: null, created_at: task.created_at, finished_at: null,
    });
    expect(store.wechatAssist.revokeReplyTaskHistory({ id: task.id, at: "2026-11-16T10:00:10.000Z" })).toMatchObject({
      history_authorized: false, authorization_version: 5, status: "paused", stop_reason: "history_authorization_revoked",
    });
    expect(store.wechatAssist.canContinueReplyTask({ id: task.id, owner: "owner-1", authorization_version: 4 })).toBe(false);
    expect(store.wechatAssist.listReplyTurns(task.id)[0]).toMatchObject({ status: "skipped", generated_body: null });
    store.close();
  });

  it("events.on 返回的 unsubscribe 函数清除订阅后不再被通知", () => {
    const store = makeStore();
    const received: string[] = [];
    const unsub = store.events.on(() => {
      received.push("A");
    });
    unsub();
    store.write({ target: "core", body: "test", provenance: "user" }, { callerKind: "ui" });
    expect(received).toEqual([]);
    store.close();
  });

  it("reply task progress round-trips facts, asked slots and stage goal", () => {
    const store = makeStore();
    const task = {
      id: "reply-progress", account_scope: "account-1", conversation_id: "conv-a", contact_id: "alice",
      objective: "reply", provider_id: "provider-1", model_id: "model-1", history_authorized: false,
      authorization_version: 1, status: "running" as const, stop_reason: null, lease_owner: "owner-1",
      lease_until: null, turn_count: 0, send_count: 0, created_at: "2026-11-16T10:00:00.000Z",
      updated_at: "2026-11-16T10:00:00.000Z", stopped_at: null,
    };
    store.wechatAssist.createReplyTask(task);
    expect(store.wechatAssist.getReplyTaskProgress(task.id)).toBeUndefined();

    store.wechatAssist.saveReplyTaskProgress({
      task_id: task.id,
      facts_json: JSON.stringify(["对方在准备考试"]),
      asked_slots_json: JSON.stringify(["考试科目"]),
      stage_goal: "什么时候考完",
      updated_at: "2026-11-16T10:00:05.000Z",
      turn_count: 1,
    });
    const saved = store.wechatAssist.getReplyTaskProgress(task.id);
    expect(saved).toMatchObject({ stage_goal: "什么时候考完", turn_count: 1 });
    expect(JSON.parse(saved!.facts_json)).toEqual(["对方在准备考试"]);

    // UPSERT 覆盖而不是追加第二条
    store.wechatAssist.saveReplyTaskProgress({
      task_id: task.id,
      facts_json: JSON.stringify(["对方在准备考试", "下周有空"]),
      asked_slots_json: JSON.stringify(["考试科目"]),
      stage_goal: "约时间",
      updated_at: "2026-11-16T10:00:10.000Z",
      turn_count: 2,
    });
    expect(JSON.parse(store.wechatAssist.getReplyTaskProgress(task.id)!.facts_json)).toHaveLength(2);
    store.close();
  });

  it("hourly send window compares epochs, not local-time strings against a UTC cutoff", () => {
    const store = makeStore();
    const insert = (id: string, sentAt: string) =>
      store.wechatAssist.createDraft({
        id, contact_id: "alice", body: "x", status: "sent",
        created_at: sentAt, sent_at: sentAt, external_id: null,
      });
    // 本地 16:56（UTC 08:56）——远早于「最近一小时」，旧实现按字符串比较会误把它算进来。
    insert("old", "2026-11-17T16:56:24+08:00");
    // 本地 21:12（UTC 13:12）——在窗口内。
    insert("recent", "2026-11-17T21:12:18+08:00");
    const since = "2026-11-17T12:15:53.000Z"; // UTC 12:15:53（= 本地 20:15:53）
    const times = store.wechatAssist.listSuccessfulSendTimes(since);
    expect(times).toEqual([Date.parse("2026-11-17T21:12:18+08:00")]);
    store.close();
  });
});
