export interface WechatAssistDraft {
  id: string;
  contact_id: string;
  body: string;
  status: "draft" | "sent" | "discarded";
  created_at: string;
  sent_at: string | null;
  external_id: string | null;
}

export type WechatReplyTaskStatus = "starting" | "running" | "stopping" | "stopped" | "paused" | "failed";

export interface WechatReplyContact {
  conversation_id: string;
  contact_id: string;
  title: string;
  last_msg_ts_ms: number | null;
  index_state: string;
}

export interface WechatReplyTask {
  id: string;
  conversation_id: string;
  contact_id: string;
  objective: string;
  provider_id: string;
  model_id: string;
  history_authorized: boolean;
  status: WechatReplyTaskStatus;
  stop_reason: string | null;
  turn_count: number;
  send_count: number;
  updated_at: string;
}

export interface WechatReplyProvider { id: string; label: string; model: string }

export interface WechatAssistPort {
  listDrafts(): Promise<WechatAssistDraft[]>;
  createDraft(input: { contact_id: string; body: string }): Promise<WechatAssistDraft>;
  discardDraft(id: string): Promise<WechatAssistDraft>;
  sendDraft(id: string): Promise<WechatAssistDraft>;
  listReplyContacts(): Promise<WechatReplyContact[]>;
  listReplyProviders(): Promise<WechatReplyProvider[]>;
  listReplyTasks(): Promise<WechatReplyTask[]>;
  startReplyTask(input: {
    conversation_id: string; contact_id: string; objective: string;
    provider_id?: string; model_id?: string; history_authorized: boolean;
  }): Promise<WechatReplyTask>;
  stopReplyTask(id: string): Promise<WechatReplyTask>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/knowself-api" + path, {
    ...init,
    headers: { accept: "application/json", ...(init?.body === undefined ? {} : { "content-type": "application/json" }), ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    throw new Error(typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : `请求失败：${response.status}`);
  }
  return body as T;
}

function newIdempotencyKey(): string {
  return `wechat-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeHeaders(idempotencyKey = newIdempotencyKey()): Record<string, string> {
  return {
    "x-knowself-write": "1",
    "x-knowself-idempotency-key": idempotencyKey,
  };
}

export function createRestWechatAssistPort(): WechatAssistPort {
  // Keep action keys stable for the lifetime of this port. If a send/discard
  // request times out after the server committed, a retry must replay the
  // write-bridge result instead of issuing a second action.
  const actionKeys = new Map<string, string>();
  const actionKey = (action: "discard" | "send", id: string): string => {
    const key = `${action}:${id}`;
    const existing = actionKeys.get(key);
    if (existing !== undefined) return existing;
    const created = newIdempotencyKey();
    actionKeys.set(key, created);
    return created;
  };

  return {
    listDrafts: () => request<WechatAssistDraft[]>("/wechat-assist/drafts"),
    createDraft: (input) => request<WechatAssistDraft>("/write/wechat-assist/drafts", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),
    discardDraft: (id) => request<WechatAssistDraft>(`/write/wechat-assist/drafts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: writeHeaders(actionKey("discard", id)),
    }),
    sendDraft: (id) => request<WechatAssistDraft>(`/write/wechat-assist/drafts/${encodeURIComponent(id)}/send`, {
      method: "POST",
      headers: writeHeaders(actionKey("send", id)),
      body: JSON.stringify({ explicit: true }),
    }),
    listReplyContacts: () => request<WechatReplyContact[]>("/wechat-assist/contacts"),
    listReplyProviders: () => request<WechatReplyProvider[]>("/wechat-assist/providers"),
    listReplyTasks: () => request<WechatReplyTask[]>("/wechat-assist/reply-tasks"),
    startReplyTask: (input) => request<WechatReplyTask>("/write/wechat-assist/reply-tasks", {
      method: "POST", headers: writeHeaders(), body: JSON.stringify(input),
    }),
    stopReplyTask: (id) => request<WechatReplyTask>(`/write/wechat-assist/reply-tasks/${encodeURIComponent(id)}/stop`, {
      method: "POST", headers: writeHeaders(`stop:${id}`), body: JSON.stringify({}),
    }),
  };
}
