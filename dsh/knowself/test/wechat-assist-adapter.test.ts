import { describe, expect, it, vi } from "vitest";
import {
  createWechatAssistAdapter,
  WechatAssistError,
  WechatTransportError,
  type WechatAssistPersistence,
  type WechatAssistAuditEntry,
} from "../src/wechat-assist-adapter.js";

function policy(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    send_enabled: false,
    drafts_only: true,
    allowlist: ["alice"],
    max_messages_per_hour: 2,
    cooldown_ms: 100,
    ...overrides,
  } as never;
}

function harness(overrides: Record<string, unknown> = {}) {
  let nowMs = 1_700_000_000_000;
  const audit: WechatAssistAuditEntry[] = [];
  const send = vi.fn(async () => ({ external_id: "wx-1" }));
  const adapter = createWechatAssistAdapter(policy(overrides), {
    transport: { send },
    audit: { append: (entry) => audit.push(entry) },
    now: () => new Date(nowMs),
    createId: () => "draft-1",
  });
  return { adapter, audit, send, advance: (ms: number) => (nowMs += ms) };
}

function persistentHarness() {
  const drafts = new Map<string, any>();
  const audit: WechatAssistAuditEntry[] = [];
  const persistence: WechatAssistPersistence = {
    createDraft: (draft) => drafts.set(draft.id, { ...draft }),
    listDrafts: () => [...drafts.values()].map((draft) => ({ ...draft })),
    getDraft: (id) => drafts.get(id),
    updateDraft: (draft) => drafts.set(draft.id, { ...draft }),
    listSuccessfulSendTimes: (since) => [...drafts.values()]
      .filter((draft) => draft.status === "sent" && draft.sent_at >= since)
      .map((draft) => Date.parse(draft.sent_at)),
    appendAudit: (entry) => audit.push({ ...entry }),
  };
  const send = vi.fn(async () => ({ external_id: "wx-persisted" }));
  let nowMs = 1_700_000_000_000;
  let nextId = 0;
  const make = (overrides: Record<string, unknown> = {}) => createWechatAssistAdapter(
    policy({ drafts_only: false, send_enabled: true, ...overrides }),
    {
      transport: { send },
      audit: { append: () => {} },
      persistence,
      now: () => new Date(nowMs),
      createId: () => `persisted-draft-${++nextId}`,
    },
  );
  return { make, drafts, audit, send, advance: (ms: number) => (nowMs += ms) };
}

function desktopHarness() {
  const drafts = new Map<string, any>();
  const attempts = new Map<string, any>();
  const tasks = new Map<string, any>();
  const persistence: WechatAssistPersistence = {
    createDraft: (draft) => drafts.set(draft.id, { ...draft }),
    listDrafts: () => [...drafts.values()].map((draft) => ({ ...draft })),
    getDraft: (id) => drafts.get(id),
    updateDraft: (draft) => drafts.set(draft.id, { ...draft }),
    listSuccessfulSendTimes: () => [...drafts.values()]
      .filter((draft) => draft.status === "sent")
      .map((draft) => Date.parse(draft.sent_at)),
    appendAudit: () => {},
    createReplyTask: (task) => { tasks.set(task.id, { ...task }); },
    getReplyTask: (id) => tasks.get(id),
    getActiveReplyTask: (accountScope) => [...tasks.values()].find((task) =>
      task.account_scope === accountScope && ["starting", "running", "stopping"].includes(task.status)) as never,
    listReplyTasks: () => [...tasks.values()].map((task) => ({ ...task })) as never,
    updateReplyTask: (task) => { tasks.set(task.id, { ...task }); },
    canContinueReplyTask: () => true,
    revokeReplyTaskHistory: (input) => tasks.get(input.id) as never,
    pauseStartingReplyTask: ({ id, at, reason }) => {
      const task = tasks.get(id);
      if (task === undefined) return false;
      Object.assign(task, { status: "paused", stop_reason: reason, updated_at: at });
      return true;
    },
    stopReplyTask: (id, at, reason) => {
      const task = tasks.get(id);
      if (task === undefined) return undefined as never;
      Object.assign(task, { status: "stopped", stop_reason: reason ?? task.stop_reason, updated_at: at, stopped_at: at });
      return task as never;
    },
    claimReplyTaskLease: ({ id, owner, lease_until }) => {
      const task = tasks.get(id);
      if (task === undefined) return false;
      // 真实仓储在 claim 时把 status 置为 running（wechat-assist.ts L446-453）。
      Object.assign(task, { status: "running", lease_owner: owner, lease_until });
      return true;
    },
    progressReplyTask: () => true,
    createOwnedReplyTurn: () => 1,
    finishOwnedReplyTurn: () => true,
    getSendAttempt: (draftId) => attempts.get(draftId),
    claimSendAttempt: (input) => {
      const existing = attempts.get(input.draft_id);
      if (existing?.status === "sent") return existing;
      if (existing?.status === "processing" && existing.lease_until > input.now) return undefined;
      const next = {
        ...(existing ?? {}),
        draft_id: input.draft_id,
        idempotency_key: input.idempotency_key,
        contact_id: input.contact_id,
        body_hash: input.body_hash,
        target_fingerprint: input.target_fingerprint ?? null,
        status: "processing",
        external_id: null,
        lease_owner: input.lease_owner,
        lease_until: input.lease_until,
        attempt_count: (existing?.attempt_count ?? 0) + 1,
        last_error: null,
      };
      attempts.set(input.draft_id, next);
      return next;
    },
    markSendSent: (draftId, leaseOwner, externalId) => {
      const attempt = attempts.get(draftId);
      if (attempt?.lease_owner === leaseOwner) {
        attempts.set(draftId, { ...attempt, status: "sent", external_id: externalId, lease_owner: null });
      }
    },
    markSendUncertain: (draftId, leaseOwner, reason) => {
      const attempt = attempts.get(draftId);
      if (attempt?.lease_owner === leaseOwner) {
        attempts.set(draftId, { ...attempt, status: "uncertain", last_error: reason, lease_owner: null });
      }
    },
    reconcileSend: (draftId, externalId) => {
      const attempt = attempts.get(draftId);
      if (attempt !== undefined) attempts.set(draftId, { ...attempt, status: "sent", external_id: externalId });
    },
  };
  const sendMessage = vi.fn(async () => ({ external_id: "desktop-1" }));
  const lookupSendResult = vi.fn(async () => null);
  const transport = {
    probeCapabilities: vi.fn(async () => ({
      available: true,
      can_inspect_conversation: true,
      can_list_unread: true,
      can_send: true,
      can_lookup_send_result: true,
      transport_version: "fake-1",
    })),
    inspectCurrentConversation: vi.fn(async () => ({
      account_scope: "default",
      conversation_id: "alice",
      kind: "contact" as const,
      visible_name: "alice",
    })),
    listUnreadMessages: vi.fn(async () => []),
    prepareTarget: vi.fn(async (conversationId: string) => ({
      account_scope: "default",
      conversation_id: conversationId,
      kind: "contact" as const,
      visible_name: conversationId.split(":").pop() ?? conversationId,
    })),
    sendMessage,
    lookupSendResult,
    stop: vi.fn(async () => {}),
  };
  let nextId = 0;
  const replyWorker = vi.fn(async () => {});
  const make = (overrides: Record<string, unknown> = {}) => createWechatAssistAdapter(
    policy({ drafts_only: false, send_enabled: true, ...overrides }),
    {
      transport: { desktop: transport },
      audit: { append: () => {} },
      persistence,
      createId: () => "desktop-draft-" + (++nextId),
      replyWorker,
    },
  );
  return { make, persistence, transport, sendMessage, lookupSendResult, tasks, replyWorker };
}

describe("wechat assist adapter", () => {
  it("creates drafts and never sends while drafts_only is enabled", async () => {
    const h = harness();
    const draft = await h.adapter.createDraft({ contact_id: "alice", body: "你好" });

    await expect(h.adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "SEND_NOT_ENABLED",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.audit.map((entry) => entry.action)).toEqual(["draft_created", "send_rejected"]);
  });

  it("requires an allowlisted contact and explicit authorization before transport", async () => {
    const h = harness({ drafts_only: false, send_enabled: true, allowlist: ["alice"] });
    const draft = await h.adapter.createDraft({ contact_id: "bob", body: "不应发送" });

    await expect(h.adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "NOT_ALLOWLISTED",
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("records a successful send only after both gates pass", async () => {
    const h = harness({ drafts_only: false, send_enabled: true });
    const draft = await h.adapter.createDraft({ contact_id: "alice", body: "已确认" });

    const sent = await h.adapter.sendDraft(draft.id, { explicit: true });

    expect(sent.status).toBe("sent");
    expect(sent.external_id).toBe("wx-1");
    expect(h.send).toHaveBeenCalledWith("alice", "已确认");
    expect(h.audit.map((entry) => entry.action)).toEqual([
      "draft_created",
      "send_attempted",
      "send_succeeded",
    ]);
  });

  it("enforces both cooldown and rolling hourly quota", async () => {
    const h = harness({ drafts_only: false, send_enabled: true, max_messages_per_hour: 1 });
    const first = await h.adapter.createDraft({ contact_id: "alice", body: "第一条" });
    await h.adapter.sendDraft(first.id, { explicit: true });

    const second = await h.adapter.createDraft({ contact_id: "alice", body: "第二条" });
    await expect(h.adapter.sendDraft(second.id, { explicit: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("lets a reply skip the cooldown but still honours the hourly quota", async () => {
    const h = harness({ drafts_only: false, send_enabled: true, cooldown_ms: 60_000, max_messages_per_hour: 2 });
    const first = await h.adapter.createDraft({ contact_id: "alice", body: "回你第一条" });
    await h.adapter.sendDraft(first.id, { explicit: true, reply: true });

    // 冷却 60s 还没过，但它是在回对方的新消息 → 立刻允许发送。
    const second = await h.adapter.createDraft({ contact_id: "alice", body: "再回一句" });
    await expect(h.adapter.sendDraft(second.id, { explicit: true, reply: true })).resolves.toMatchObject({
      status: "sent",
    });

    // 每小时上限对秒回同样生效。
    const third = await h.adapter.createDraft({ contact_id: "alice", body: "第三条" });
    await expect(h.adapter.sendDraft(third.id, { explicit: true, reply: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("still applies the cooldown to proactive sends", async () => {
    const h = harness({ drafts_only: false, send_enabled: true, cooldown_ms: 60_000, max_messages_per_hour: 6 });
    const first = await h.adapter.createDraft({ contact_id: "alice", body: "主动问候" });
    await h.adapter.sendDraft(first.id, { explicit: true });

    const second = await h.adapter.createDraft({ contact_id: "alice", body: "又主动一句" });
    await expect(h.adapter.sendDraft(second.id, { explicit: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("does not change a draft when the transport fails and audits the failure", async () => {
    const h = harness({ drafts_only: false, send_enabled: true });
    h.send.mockRejectedValueOnce(new Error("desktop bridge unavailable"));
    const draft = await h.adapter.createDraft({ contact_id: "alice", body: "稍后再发" });

    await expect(h.adapter.sendDraft(draft.id, { explicit: true })).rejects.toThrow(
      "desktop bridge unavailable",
    );
    expect(h.adapter.listDrafts()[0]?.status).toBe("draft");
    expect(h.audit.at(-1)?.action).toBe("send_failed");
  });

  it("fails closed when audit persistence is unavailable", async () => {
    const audit = { append: vi.fn(async () => { throw new Error("disk full"); }) };
    const send = vi.fn(async () => ({}));
    const adapter = createWechatAssistAdapter(policy(), {
      transport: { send },
      audit,
    });

    await expect(adapter.createDraft({ contact_id: "alice", body: "不可丢审计" })).rejects.toMatchObject<
      Partial<WechatAssistError>
    >({ code: "AUDIT_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not call transport when persistent audit fails before sending", async () => {
    const drafts = new Map<string, any>();
    const persistence: WechatAssistPersistence = {
      createDraft: (draft) => drafts.set(draft.id, { ...draft }),
      listDrafts: () => [...drafts.values()],
      getDraft: (id) => drafts.get(id),
      updateDraft: (draft) => drafts.set(draft.id, { ...draft }),
      listSuccessfulSendTimes: () => [],
      appendAudit: (entry) => {
        if (entry.action === "send_attempted") throw new Error("audit database unavailable");
      },
    };
    const send = vi.fn(async () => ({ external_id: "must-not-send" }));
    const adapter = createWechatAssistAdapter(policy({ drafts_only: false, send_enabled: true }), {
      transport: { send },
      audit: { append: () => {} },
      persistence,
      createId: () => "audit-failure-draft",
    });
    const draft = await adapter.createDraft({ contact_id: "alice", body: "审计先行" });

    await expect(adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "AUDIT_FAILED",
    });
    expect(send).not.toHaveBeenCalled();
    expect(adapter.listDrafts()[0]).toMatchObject({ status: "draft" });
  });

  it("keeps a sent draft terminal across restart and cannot send it twice", async () => {
    const h = persistentHarness();
    const first = h.make();
    const draft = await first.createDraft({ contact_id: "alice", body: "只发一次" });
    await first.sendDraft(draft.id, { explicit: true });

    const second = h.make();
    await expect(second.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "INVALID_DRAFT",
    });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("enforces the persisted cooldown after restart", async () => {
    const h = persistentHarness();
    const first = h.make({ max_messages_per_hour: 6, cooldown_ms: 100 });
    const sent = await first.createDraft({ contact_id: "alice", body: "冷却中的第一条" });
    await first.sendDraft(sent.id, { explicit: true });

    const second = h.make({ max_messages_per_hour: 6, cooldown_ms: 100 });
    const next = await second.createDraft({ contact_id: "alice", body: "冷却中的第二条" });
    await expect(second.sendDraft(next.id, { explicit: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    h.advance(100);
    await expect(second.sendDraft(next.id, { explicit: true })).resolves.toMatchObject({
      status: "sent",
    });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("restores drafts and the rolling send quota from injected persistence", async () => {
    const h = persistentHarness();
    const first = h.make();
    const draft = await first.createDraft({ contact_id: "alice", body: "重启前发送" });
    await first.sendDraft(draft.id, { explicit: true });

    const second = h.make();
    expect(second.listDrafts()[0]).toMatchObject({ status: "sent", external_id: "wx-persisted" });
    const next = await second.createDraft({ contact_id: "alice", body: "重启后发送" });
    await expect(second.sendDraft(next.id, { explicit: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.audit.map((entry) => entry.action)).toContain("send_succeeded");
  });

  it("fails closed when desktop transport capabilities are unavailable", async () => {
    const h = desktopHarness();
    h.transport.probeCapabilities.mockResolvedValueOnce({
      available: false,
      can_inspect_conversation: false,
      can_list_unread: false,
      can_send: false,
      can_lookup_send_result: false,
      transport_version: "fake-1",
      reason: "wechat window unavailable",
    });
    const adapter = h.make();
    const draft = await adapter.createDraft({ contact_id: "alice", body: "cannot send" });

    await expect(adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a changed desktop conversation before claiming or sending", async () => {
    const h = desktopHarness();
    h.transport.inspectCurrentConversation.mockResolvedValueOnce({
      account_scope: "default",
      conversation_id: "bob",
      kind: "contact",
      visible_name: "bob",
    });
    const adapter = h.make();
    const draft = await adapter.createDraft({ contact_id: "alice", body: "target check" });

    await expect(adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "TARGET_MISMATCH",
    });
    expect(h.persistence.getSendAttempt?.(draft.id)).toBeUndefined();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain timeout after restart without sending twice", async () => {
    const h = desktopHarness();
    h.sendMessage.mockRejectedValueOnce(new WechatTransportError("desktop timeout", "timeout"));
    const first = h.make();
    const draft = await first.createDraft({ contact_id: "alice", body: "send once" });

    await expect(first.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "SEND_UNCERTAIN",
    });
    h.lookupSendResult.mockResolvedValueOnce({ external_id: "desktop-1" });
    const second = h.make({ max_messages_per_hour: 0 });

    await expect(second.sendDraft(draft.id, { explicit: true })).resolves.toMatchObject({
      status: "sent",
      external_id: "desktop-1",
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.lookupSendResult).toHaveBeenCalledWith(draft.id);
  });

  it("marks a send uncertain when the desktop conversation changes during send", async () => {
    const h = desktopHarness();
    h.transport.inspectCurrentConversation
      .mockResolvedValueOnce({
        account_scope: "default",
        conversation_id: "alice",
        kind: "contact",
        visible_name: "alice",
      })
      .mockResolvedValueOnce({
        account_scope: "default",
        conversation_id: "bob",
        kind: "contact",
        visible_name: "bob",
      });
    const adapter = h.make();
    const draft = await adapter.createDraft({ contact_id: "alice", body: "window check" });

    await expect(adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "SEND_UNCERTAIN",
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.persistence.getSendAttempt?.(draft.id)).toMatchObject({ status: "uncertain" });
  });

  it("keeps reply tasks paused until an inbound reply worker is installed", async () => {
    const h = harness();
    const task = await h.adapter.startReplyTask({
      conversation_id: "wechat:alice",
      contact_id: "alice",
      objective: "哄好她",
      provider_id: "provider-1",
      model_id: "model-1",
      history_authorized: true,
    });

    expect(task.status).toBe("paused");
    expect(task.stop_reason).toContain("worker 尚未装配");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.audit.at(-1)?.action).toBe("reply_task_paused");
  });

  it("stops a paused reply task idempotently", async () => {
    const h = harness();
    const task = await h.adapter.startReplyTask({
      conversation_id: "wechat:alice",
      contact_id: "alice",
      objective: "哄好她",
      provider_id: "provider-1",
      model_id: "model-1",
      history_authorized: false,
    });

    await expect(h.adapter.stopReplyTask(task.id)).resolves.toMatchObject({ status: "stopped" });
    await expect(h.adapter.stopReplyTask(task.id)).resolves.toMatchObject({ status: "stopped" });
    expect(h.audit.filter((entry) => entry.action === "reply_task_stopped")).toHaveLength(1);
  });
});

describe("explicitly started reply task authorizes its own contact", () => {
  function startBob(adapter: ReturnType<ReturnType<typeof desktopHarness>["make"]>) {
    return adapter.startReplyTask({
      conversation_id: "wechat:bob",
      contact_id: "bob",
      objective: "问清楚昨晚去哪了",
      provider_id: "hcnsec",
      model_id: "DeepSeek-V4.1-Flash",
      history_authorized: false,
    });
  }

  it("runs and sends for a contact that is not in the global allowlist", async () => {
    const h = desktopHarness();
    const adapter = h.make({ allowlist: ["alice"] });

    const task = await startBob(adapter);

    expect(task.status).toBe("running");
    expect(task.stop_reason).toBeNull();
    expect(h.replyWorker).toHaveBeenCalledTimes(1);

    // 微信当前停在该联系人的会话上（发送前的目标校验）。
    h.transport.inspectCurrentConversation.mockResolvedValue({
      account_scope: "default",
      conversation_id: "bob",
      kind: "contact" as const,
      visible_name: "bob",
    });
    const draft = await adapter.createDraft({ contact_id: "bob", body: "昨晚去哪了" });
    await expect(adapter.sendDraft(draft.id, { explicit: true })).resolves.toMatchObject({ status: "sent" });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("still blocks ad-hoc drafts to a contact nothing was started for", async () => {
    const h = desktopHarness();
    const adapter = h.make({ allowlist: ["alice"] });
    const draft = await adapter.createDraft({ contact_id: "bob", body: "不该发" });

    await expect(adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "NOT_ALLOWLISTED",
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("reclaims the authorization as soon as the task stops", async () => {
    const h = desktopHarness();
    const adapter = h.make({ allowlist: ["alice"] });
    const task = await startBob(adapter);
    await adapter.stopReplyTask(task.id);

    const draft = await adapter.createDraft({ contact_id: "bob", body: "任务停了" });
    await expect(adapter.sendDraft(draft.id, { explicit: true })).rejects.toMatchObject({
      code: "NOT_ALLOWLISTED",
    });
  });

  it("still refuses to start when the global send switch is off", async () => {
    const h = desktopHarness();
    const adapter = h.make({ allowlist: ["alice"], send_enabled: false });

    const task = await startBob(adapter);

    expect(task.status).toBe("paused");
    expect(task.stop_reason).toBe("全局发送开关未开启");
    expect(h.replyWorker).not.toHaveBeenCalled();
  });

  it("keeps the current-conversation identity when prepareTarget fails", async () => {
    // 真实事故：所选对象就是微信当前打开的那个会话 → prepareTarget 抛错 → 旧实现把 identity
    // 抹成 null → 判「当前微信账号或联系人与所选目标不匹配」并暂停任务。
    const h = desktopHarness();
    h.transport.inspectCurrentConversation.mockResolvedValue({
      account_scope: "wxid_me",
      conversation_id: "wechat:bob",
      kind: "contact" as const,
      visible_name: "bob",
    });
    h.transport.prepareTarget.mockRejectedValue(new Error("bridge did not report an open conversation"));
    const adapter = h.make({ allowlist: ["alice"] });

    const task = await startBob(adapter);

    expect(task.status).toBe("running");
    expect(task.stop_reason).toBeNull();
    expect(task.account_scope).toBe("wxid_me");
  });

  it("still refuses to start when the open conversation is somebody else", async () => {
    const h = desktopHarness();
    h.transport.inspectCurrentConversation.mockResolvedValue({
      account_scope: "wxid_me",
      conversation_id: "wechat:carol",
      kind: "contact" as const,
      visible_name: "carol",
    });
    h.transport.prepareTarget.mockRejectedValue(new Error("target mismatch"));
    const adapter = h.make({ allowlist: ["alice"] });

    const task = await startBob(adapter);

    expect(task.status).toBe("paused");
    expect(task.stop_reason).toBe("当前微信账号或联系人与所选目标不匹配");
  });

  it("still refuses to start under the drafts-only policy", async () => {
    const h = desktopHarness();
    const adapter = h.make({ allowlist: ["alice"], drafts_only: true });

    const task = await startBob(adapter);

    expect(task.status).toBe("paused");
    expect(task.stop_reason).toBe("当前是「只存草稿」策略");
  });
});
