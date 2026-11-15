import { WechatAssistError } from "../wechat-assist-adapter.js";
import { BadRequestError, decodePathSegment, degradedBody, type DispatchResult, type RouteContext } from "./http.js";

function serviceOf(ctx: RouteContext) {
  return ctx.services.wechatAssist;
}

function bodyObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  return raw as Record<string, unknown>;
}

function textField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(name + " 必须是非空字符串");
  }
  return value.trim();
}

function errorResult(error: WechatAssistError): DispatchResult {
  const status = error.code === "DRAFT_NOT_FOUND" ? 404
    : error.code === "DISABLED" || error.code === "SEND_NOT_ENABLED" || error.code === "NOT_ALLOWLISTED" ? 403
    : error.code === "RATE_LIMITED" || error.code === "SEND_IN_PROGRESS" ? 409
    : error.code === "AUDIT_FAILED" || error.code === "TRANSPORT_UNAVAILABLE" ? 503
    : error.code === "TARGET_MISMATCH" || error.code === "SEND_UNCERTAIN" ? 409
    : error.code === "REPLY_TASK_NOT_FOUND" ? 404
    : error.code === "REPLY_TASK_ACTIVE" ? 409
    : error.code === "REPLY_TASK_UNAVAILABLE" ? 503
    : 400;
  return { status, body: { error: error.code.toLowerCase(), message: error.message } };
}

/**
 * WeChat assistance is intentionally a small, explicit REST surface:
 * drafts are readable, discard is reversible only by creating a new draft,
 * and sending requires a JSON { explicit: true } confirmation.
 */
export async function handleWechatAssistRoute(ctx: RouteContext): Promise<DispatchResult | undefined> {
  if (!ctx.path.startsWith("/wechat-assist")) return undefined;
  const service = serviceOf(ctx);
  if (service === undefined) return degradedBody("微信协助服务未装配", "core");

  if (ctx.path === "/wechat-assist/contacts" && ctx.method === "GET") {
    const people = ctx.services.personStore?.replyHistory.listDirectConversations();
    if (people === undefined) return degradedBody("加密聊天记录未解锁", "person");
    const replyIndex = ctx.services.contextRouter?.replyRetrieval;
    return {
      status: 200,
      body: people.map((person) => ({
        ...person,
        index_state: replyIndex?.state(person.conversation_id)?.state ?? "pending",
      })),
    };
  }

  if (ctx.path === "/wechat-assist/reply-tasks" && ctx.method === "GET") {
    return { status: 200, body: service.listReplyTasks() };
  }

  if (ctx.path === "/wechat-assist/providers" && ctx.method === "GET") {
    const providers = (ctx.services.settings.providers ?? []) as Array<{
      id: string; label?: string; model: string; purposes?: string[]; default_for?: string[];
    }>;
    return {
      status: 200,
      body: providers.filter((item) => item.purposes?.includes("chat") || item.default_for?.includes("chat"))
        .map(({ id, label, model }) => ({ id, label: label ?? id, model })),
    };
  }

  const taskStop = /^\/wechat-assist\/reply-tasks\/([^/]+)\/stop$/.exec(ctx.path);
  if (taskStop !== null && ctx.method === "POST" && ctx.writeChannel === true) {
    try {
      return { status: 200, body: await service.stopReplyTask(decodePathSegment(taskStop[1], "task id")) };
    } catch (error) {
      if (error instanceof WechatAssistError) return errorResult(error);
      throw error;
    }
  }

  if (ctx.path === "/wechat-assist/reply-tasks" && ctx.method === "POST" && ctx.writeChannel === true) {
    try {
      const body = bodyObject(ctx.body);
      const conversationId = textField(body.conversation_id, "conversation_id");
      const contactId = textField(body.contact_id, "contact_id");
      const contacts = ctx.services.personStore?.replyHistory.listDirectConversations();
      if (contacts === undefined) return degradedBody("加密聊天记录未解锁", "person");
      const selected = contacts.find((item) => item.conversation_id === conversationId && item.contact_id === contactId);
      if (selected === undefined) throw new BadRequestError("所选会话不是已解锁的好友直聊");
      const providers = (ctx.services.settings.providers ?? []) as Array<{ id: string; model: string; purposes?: string[]; default_for?: string[] }>;
      const preferred = providers.find((item) => item.default_for?.includes("chat")) ?? providers.find((item) => item.purposes?.includes("chat")) ?? providers[0];
      const providerId = typeof body.provider_id === "string" ? body.provider_id : preferred?.id;
      const provider = providers.find((item) => item.id === providerId);
      if (provider === undefined) throw new BadRequestError("provider_id 未配置");
      return {
        status: 201,
        body: await service.startReplyTask({
          conversation_id: conversationId,
          contact_id: contactId,
          objective: textField(body.objective, "objective"),
          provider_id: provider.id,
          model_id: typeof body.model_id === "string" && body.model_id.trim() !== "" ? body.model_id.trim() : provider.model,
          history_authorized: body.history_authorized === true,
        }),
      };
    } catch (error) {
      if (error instanceof WechatAssistError) return errorResult(error);
      throw error;
    }
  }

  const draftPrefix = "/wechat-assist/drafts";
  if (ctx.path === draftPrefix && ctx.method === "GET") {
    return { status: 200, body: service.listDrafts() };
  }

  if (!ctx.path.startsWith(draftPrefix + "/")) return undefined;
  const suffix = ctx.path.slice((draftPrefix + "/").length);
  const parts = suffix.split("/");

  try {
    if (parts.length === 1 && ctx.method === "POST" && ctx.writeChannel === true) {
      const body = bodyObject(ctx.body);
      return {
        status: 201,
        body: await service.createDraft({
          contact_id: textField(body.contact_id, "contact_id"),
          body: textField(body.body, "body"),
        }),
      };
    }

    if (parts.length === 2 && parts[1] === "send" && ctx.method === "POST" && ctx.writeChannel === true) {
      const body = bodyObject(ctx.body);
      if (body.explicit !== true) throw new BadRequestError("发送必须显式确认 explicit=true");
      const draftId = decodePathSegment(parts[0], "draft id");
      return { status: 200, body: await service.sendDraft(draftId, { explicit: true }) };
    }

    if (parts.length === 1 && ctx.method === "DELETE" && ctx.writeChannel === true) {
      const draftId = decodePathSegment(parts[0], "draft id");
      return { status: 200, body: await service.discardDraft(draftId) };
    }
  } catch (error) {
    if (error instanceof WechatAssistError) return errorResult(error);
    throw error;
  }

  return undefined;
}
