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

  if (ctx.path === "/wechat-assist/transport" && ctx.method === "GET") {
    const transport = ctx.services.wechatTransport;
    if (transport === undefined) {
      return { status: 200, body: {
        available: false,
        can_inspect_conversation: false,
        can_list_unread: false,
        can_send: false,
        can_lookup_send_result: false,
        transport_version: "unavailable",
        reason: "微信桌面 transport 未装配",
      } };
    }
    return { status: 200, body: await transport.probeCapabilities() };
  }

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

  if (ctx.path === "/wechat-assist/models" && ctx.method === "GET") {
    const models = (await ctx.services.listDshModels?.()) ?? [];
    return { status: 200, body: { models, current: ctx.services.resolveDshModel?.() ?? null } };
  }

  if (ctx.path === "/wechat-assist/model" && ctx.method === "GET") {
    const dsh = ctx.services.resolveDshModel?.();
    return { status: 200, body: dsh === undefined ? { source: "knowself", provider: "", model: "" } : { source: "dsh", ...dsh } };
  }

  if (ctx.path === "/wechat-assist/reply-tasks" && ctx.method === "GET") {
    return { status: 200, body: service.listReplyTasks() };
  }

  const taskPersona = /^\/wechat-assist\/reply-tasks\/([^/]+)\/persona$/.exec(ctx.path);
  if (taskPersona !== null && ctx.method === "GET") {
    const taskId = decodePathSegment(taskPersona[1], "task id");
    const record = ctx.services.profileStore.wechatAssist.getReplyPersona(taskId);
    if (record === undefined) {
      return { status: 404, body: { error: "persona_not_found", message: "画像尚未生成" } };
    }
    try {
      return { status: 200, body: JSON.parse(record.payload_json) };
    } catch {
      return { status: 200, body: { degraded: true, target: { summary: "" }, voice: {} } };
    }
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

  const historyRevoke = /^\/wechat-assist\/reply-tasks\/([^/]+)\/history\/revoke$/.exec(ctx.path);
  if (historyRevoke !== null && ctx.method === "POST" && ctx.writeChannel === true) {
    try {
      return { status: 200, body: await service.revokeReplyTaskHistory(decodePathSegment(historyRevoke[1], "task id")) };
    } catch (error) {
      if (error instanceof WechatAssistError) return errorResult(error);
      throw error;
    }
  }

  if (ctx.path === "/wechat-assist/reply-tasks" && ctx.method === "POST" && ctx.writeChannel === true) {
    try {
      const transport = ctx.services.wechatTransport;
      const capabilities = transport === undefined ? null : await transport.probeCapabilities();
      if (capabilities === null || !capabilities.available || !capabilities.can_inspect_conversation || !capabilities.can_list_unread
        || !capabilities.can_send || !capabilities.can_lookup_send_result) {
        const reason = capabilities?.reason ?? "微信桌面 transport 未装配";
        return { status: 503, body: { error: "transport_unavailable", message: `自动回复不可启动：${reason}` } };
      }
      const body = bodyObject(ctx.body);
      const conversationId = textField(body.conversation_id, "conversation_id");
      const contactId = textField(body.contact_id, "contact_id");
      const contacts = ctx.services.personStore?.replyHistory.listDirectConversations();
      if (contacts === undefined) return degradedBody("加密聊天记录未解锁", "person");
      const selected = contacts.find((item) => item.conversation_id === conversationId && item.contact_id === contactId);
      if (selected === undefined) throw new BadRequestError("所选会话不是已解锁的好友直聊");
      // transport 用微信 username 发送；会话 ID 形如 `wechat:<username>`。
      const transportContactId = conversationId.startsWith("wechat:") ? conversationId.slice("wechat:".length) : contactId;
      const settings = ctx.services.settings as {
        conversation?: { default_provider_id?: string };
        providers?: Array<{ id: string; model: string; default_for?: string[] }>;
      };
      const dshModel = ctx.services.resolveDshModel?.();
      const requestedProvider = typeof body.provider_id === "string" ? body.provider_id.trim() : "";
      const requestedModel = typeof body.model_id === "string" ? body.model_id.trim() : "";
      let providerId = "";
      let modelId = "";
      let resolved = false;
      if (requestedProvider !== "" && requestedModel !== "" && ctx.services.listDshModels !== undefined) {
        // 只接受 dsh 已配置模型；目录为空时 fail-closed，不落回旧配置。
        const catalog = await ctx.services.listDshModels();
        if (!catalog.some((item) => item.provider === requestedProvider && item.model === requestedModel)) {
          throw new BadRequestError("所选模型不在 dsh 已配置模型中");
        }
        providerId = requestedProvider;
        modelId = requestedModel;
        resolved = true;
      }
      if (!resolved && dshModel !== undefined) {
        // 自动回复跟随 dsh 当前模型；在 dsh 里切换模型后，新任务直接生效。
        providerId = dshModel.provider;
        modelId = dshModel.model;
        resolved = true;
      }
      if (!resolved) {
        const providers = settings.providers ?? [];
        const defaultProviderId = settings.conversation?.default_provider_id?.trim();
        const provider = (defaultProviderId
          ? providers.find((item) => item.id === defaultProviderId)
          : undefined)
          ?? (defaultProviderId ? undefined : providers.find((item) => item.default_for?.includes("chat")));
        if (provider === undefined || provider.model.trim() === "") {
          throw new BadRequestError("dsh 当前聊天模型未配置，请先在 dsh 里选择模型");
        }
        providerId = provider.id;
        modelId = provider.model;
      }
      if (providerId === "" || modelId === "") {
        throw new BadRequestError("dsh 当前聊天模型未配置，请先在 dsh 里选择模型");
      }
      return {
        status: 201,
        body: await service.startReplyTask({
          conversation_id: conversationId,
          contact_id: transportContactId,
          objective: textField(body.objective, "objective"),
          provider_id: providerId,
          model_id: modelId,
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
