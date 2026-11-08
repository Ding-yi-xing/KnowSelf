/**
 * Chat 前端测试夹具 —— 构造符合 ChatEventSchema 形状的 SSE 帧与 mock fetch。
 * 本文件不是测试（vitest include 只匹配 *.test.ts(x)），不修改任何既有测试。
 */
import { vi } from "vitest";
import type {
  ChatEvent,
  ChatHistoryMessage,
  ConversationRecord,
  GetConversationResponse,
} from "@knowself/contracts";

export const CONV_ID = "11111111-1111-4111-8111-111111111111";
export const MSG_ID = "22222222-2222-4222-8222-222222222222";
export const TRACE_ID = "trace-00000001";
export const PROVIDER_ID = "primary";
export const ISO = "2026-11-07T10:00:00.000Z";

export const DEFAULT_SETTINGS: unknown = {
  schema_version: 1,
  conversation: { default_provider_id: PROVIDER_ID },
  providers: [
    { id: PROVIDER_ID, label: "主模型", purposes: ["chat"], default_for: ["chat"] },
    { id: "backup", label: "备用模型", purposes: ["chat"], default_for: [] },
  ],
};

export function sseFrame(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function messageStart(): ChatEvent {
  return {
    type: "message_start",
    conversation_id: CONV_ID,
    message_id: MSG_ID,
    trace_id: TRACE_ID,
    occurred_at: ISO,
  };
}

export function textDelta(delta: string): ChatEvent {
  return { type: "text_delta", message_id: MSG_ID, delta };
}

export function toolUseStart(): ChatEvent {
  return {
    type: "tool_use_start",
    message_id: MSG_ID,
    tool_use_id: "tool-1",
    name: "fetch__fetch",
  };
}

export function toolUseEnd(): ChatEvent {
  return {
    type: "tool_use_end",
    message_id: MSG_ID,
    tool_use_id: "tool-1",
    input: { url: "https://example.test" },
  };
}

export function toolResult(): ChatEvent {
  return {
    type: "tool_result",
    message_id: MSG_ID,
    tool_use_id: "tool-1",
    is_error: false,
    output: "页面正文",
    duration_ms: 12,
  };
}

export function messageEnd(): ChatEvent {
  return { type: "message_end", message_id: MSG_ID, stop_reason: "end_turn" };
}

export function doneEvent(writeBack = false): ChatEvent {
  return {
    type: "done",
    conversation_id: CONV_ID,
    write_back_triggered: writeBack,
  };
}

export function errorEvent(message = "上游模型报错"): ChatEvent {
  return {
    type: "error",
    code: "PROVIDER_FAIL",
    message,
    message_id: MSG_ID,
    trace_id: TRACE_ID,
  };
}

/** 默认一轮完整流：start → 两个文本块 → done（文本应逐块追加为「你好，世界」）。 */
export const DEFAULT_CHAT_CHUNKS: string[] = [
  sseFrame(messageStart()),
  sseFrame(textDelta("你好")),
  sseFrame(textDelta("，世界")),
  sseFrame(doneEvent()),
];

export function encodeChunk(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface FakeReadResult {
  done: boolean;
  value: Uint8Array | undefined;
}

/** 不依赖 ReadableStream 实现的 reader：逐段吐字节，holdOpen 时永不结束。 */
export function fakeReader(
  chunks: readonly string[],
  holdOpen = false,
): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read: async (): Promise<FakeReadResult> => {
      if (index < chunks.length) {
        return { done: false, value: encodeChunk(chunks[index++] ?? "") };
      }
      if (holdOpen) return new Promise<FakeReadResult>(() => {});
      return { done: true, value: undefined };
    },
    releaseLock: () => {},
    cancel: async () => {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

export function sseResponse(
  chunks: readonly string[],
  over: { ok?: boolean; status?: number; holdOpen?: boolean } = {},
): Response {
  return {
    ok: over.ok ?? true,
    status: over.status ?? 200,
    body: { getReader: () => fakeReader(chunks, over.holdOpen ?? false) },
    text: async () => chunks.join(""),
    json: async () => ({}),
  } as unknown as Response;
}

export function makeConversation(
  over: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    id: CONV_ID,
    title: "第一次对话",
    created_at: ISO,
    updated_at: ISO,
    message_count: 1,
    last_provider_id: PROVIDER_ID,
    ...over,
  };
}

let historySeq = 0;

export function makeHistoryMessage(
  text: string,
  role: "user" | "assistant" = "user",
): ChatHistoryMessage {
  historySeq += 1;
  return {
    // 每条 history 消息独立 id，避免渲染时 React key 重复。
    id: `33333333-3333-4333-8333-${String(historySeq).padStart(12, "0")}`,
    conversation_id: CONV_ID,
    role,
    content: [{ kind: "text", text }],
    created_at: ISO,
    provider_id: role === "assistant" ? PROVIDER_ID : null,
    model: null,
  };
}

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export interface MakeFetchOptions {
  conversations?: ConversationRecord[];
  history?: Record<string, GetConversationResponse>;
  settings?: unknown;
  chatChunks?: readonly string[];
  holdOpen?: boolean;
  conversationsFail?: boolean;
  chatStatus?: number;
}

/** 覆盖 Chat 页 + App 轮询所需的全部端点；记录每次调用供断言。 */
export function makeFetch(options: MakeFetchOptions = {}): {
  impl: ReturnType<typeof vi.fn>;
  calls: FetchCall[];
} {
  let items: ConversationRecord[] = [...(options.conversations ?? [])];
  const calls: FetchCall[] = [];

  const impl = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ url, init });

      if (url.includes("/api/settings")) {
        return jsonResponse(options.settings ?? DEFAULT_SETTINGS);
      }
      if (url.includes("/api/system/status")) return jsonResponse({ ok: true });
      // InboxPage 试点页（App 从 /inbox 跳回对话时可能仍在挂载）需要数组响应。
      if (url.includes("/api/proposals")) return jsonResponse([]);
      if (url === "/api/chat/abort") return jsonResponse({ ok: true });
      if (url === "/api/chat") {
        return sseResponse(options.chatChunks ?? DEFAULT_CHAT_CHUNKS, {
          holdOpen: options.holdOpen ?? false,
          ...(options.chatStatus !== undefined ? { status: options.chatStatus, ok: false } : {}),
        });
      }
      if (url.startsWith("/api/conversations/")) {
        const id = decodeURIComponent(url.slice("/api/conversations/".length));
        if (method === "PATCH") {
          const body = JSON.parse(String(init.body ?? "{}")) as { title: string };
          items = items.map((item) =>
            item.id === id ? { ...item, title: body.title } : item,
          );
          return jsonResponse(
            items.find((item) => item.id === id) ?? makeConversation({ id, title: body.title }),
          );
        }
        if (method === "DELETE") {
          items = items.filter((item) => item.id !== id);
          return jsonResponse({ ok: true });
        }
        return jsonResponse(
          options.history?.[id] ?? {
            conversation: makeConversation({ id }),
            messages: [],
          },
        );
      }
      if (url.startsWith("/api/conversations")) {
        if (options.conversationsFail) {
          return jsonResponse({ code: "INTERNAL", message: "会话服务不可用" }, 500);
        }
        return jsonResponse({ items, total: items.length });
      }
      return jsonResponse({});
    },
  );

  return { impl, calls };
}
