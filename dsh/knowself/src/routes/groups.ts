/**
 * 群聊只读路由（2026-11-16「群的消息单列」）。
 *
 *   GET /groups                     → 200 + 群会话列表（按最近消息倒序）
 *   GET /group/:id                  → 200 + 群会话行；不存在 → 404
 *   GET /group/:id/timeline?limit=  → 200 + 最新 N 条群消息（最新优先）
 *
 * 群消息按 `conversation_id` 直查 `chat_messages`，不与联系人直聊混算；
 * 联系人目录的直聊统计见 `persons.list({ direct_only: true })`。
 */
import type { PersonStore } from "@knowself/person-store";
import type { KnowselfServices } from "../services.js";
import {
  decodePathSegment,
  degradedBody,
  parseNonNegativeInt,
  type DispatchResult,
  type RouteContext,
} from "./http.js";
import { personDegradedReason } from "./persons.js";

/** 群消息投影（与人物时间线的消息形态对齐，便于前端复用渲染）。 */
interface GroupMessage {
  kind: "message";
  message_id: string;
  conversation_id: string;
  sender_name: string;
  role: "me" | "other" | "system";
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: string;
}

function resolveStore(services: KnowselfServices): PersonStore | undefined {
  return services.personStore;
}

function degraded(services: KnowselfServices): DispatchResult {
  return degradedBody(personDegradedReason(services), "person");
}

export function handleGroupsRoute(ctx: RouteContext): DispatchResult | undefined {
  const { path, url, services, method } = ctx;
  if (method !== "GET") return undefined;

  const mGroup = /^\/group\/([^/]+)$/.exec(path);
  const mTimeline = /^\/group\/([^/]+)\/timeline$/.exec(path);

  if (path === "/groups") {
    const limit = parseNonNegativeInt(url.searchParams.get("limit"), "limit") ?? 100;
    const offset = parseNonNegativeInt(url.searchParams.get("offset"), "offset") ?? 0;
    const store = resolveStore(services);
    if (store === undefined) return degraded(services);
    return {
      status: 200,
      body: store.conversations.list({ kind: "group", limit, offset }),
    };
  }

  if (mGroup !== null) {
    const id = decodePathSegment(mGroup[1], "群 id");
    const store = resolveStore(services);
    if (store === undefined) return degraded(services);
    const row = store.conversations.get(id);
    if (row === null || row.kind !== "group") {
      return { status: 404, body: { error: "not_found" } };
    }
    return { status: 200, body: row };
  }

  if (mTimeline !== null) {
    const id = decodePathSegment(mTimeline[1], "群 id");
    const limit = parseNonNegativeInt(url.searchParams.get("limit"), "limit") ?? 50;
    const offset = parseNonNegativeInt(url.searchParams.get("offset"), "offset") ?? 0;
    const store = resolveStore(services);
    if (store === undefined) return degraded(services);
    const row = store.conversations.get(id);
    if (row === null || row.kind !== "group") {
      return { status: 404, body: { error: "not_found" } };
    }
    const total = store.messages.count({ conversation_id: id });
    if (total === 0) return { status: 200, body: [] };
    const windowOffset = Math.max(0, total - limit - offset);
    const messages = store.messages.list({ conversation_id: id, limit, offset: windowOffset });
    const body: GroupMessage[] = messages.reverse().map((message) => ({
      kind: "message",
      message_id: message.message_id,
      conversation_id: message.conversation_id,
      sender_name: message.sender_name,
      role: message.role,
      ts_ms: message.ts_ms,
      msg_date: message.msg_date,
      content: message.content,
      content_type: message.content_type,
    }));
    return { status: 200, body };
  }

  return undefined;
}
