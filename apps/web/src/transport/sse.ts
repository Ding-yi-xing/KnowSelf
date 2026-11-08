/**
 * SSE 传输层 —— 按 `packages/contracts/src/chat.ts` 的 ChatEventSchema 重写。
 *
 * wire 形态（服务端 `apps/server/src/orchestrator/sse.ts::encodeEvent`）：
 *   event: <type>\n
 *   data: <JSON>\n\n
 * 另外服务端每 30s 推 `: ping\n\n` 注释帧保活，解析器必须忽略。
 *
 * 本模块只负责「字节 → ChatEvent」以及网络生命周期，不做任何 UI 状态处理；
 * UI 状态机在 features/chat/chatState.ts。零复用迁移前的旧前端 transport。
 */
import type { ChatEvent, ChatRequest } from "@knowself/contracts";

export const CHAT_STREAM_PATH = "/api/chat";
export const CHAT_ABORT_PATH = "/api/chat/abort";

/** ChatEventSchema discriminated union 的 8 个分支，作为运行时形状白名单。 */
const CHAT_EVENT_TYPES: readonly string[] = [
  "message_start",
  "text_delta",
  "tool_use_start",
  "tool_use_end",
  "tool_result",
  "message_end",
  "done",
  "error",
];

export type SseFailurePhase = "http" | "stream" | "incomplete";

/** SSE 传输异常：phase 让 UI 能区分「请求被拒 / 断链 / 未正常收尾」。 */
export class SseTransportError extends Error {
  constructor(
    message: string,
    readonly phase: SseFailurePhase,
  ) {
    super(message);
    this.name = "SseTransportError";
  }
}

/** 判断 cause 是否为用户主动中止（fetch / AbortController 抛出的 AbortError）。 */
export function isAbortError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { name?: unknown }).name === "AbortError";
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 运行时形状守卫：只认契约中声明的事件类型，其余一律丢弃，不猜测。 */
function isChatEvent(value: unknown): value is ChatEvent {
  if (typeof value !== "object" || value === null) return false;
  const type: unknown = (value as Record<string, unknown>).type;
  return typeof type === "string" && CHAT_EVENT_TYPES.includes(type);
}

/**
 * 解析单个完整 SSE 帧（不含末尾空行）。
 * 注释帧、非法 JSON、未知事件、event: 与 data.type 不一致时返回 null。
 * 事件形状以 data JSON 的 `type` 判别字段为准（与 ChatEventSchema 一致）。
 */
export function parseSseFrame(frame: string): ChatEvent | null {
  const dataLines: string[] = [];
  let eventName = "";

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n")) as unknown;
  } catch {
    return null;
  }
  if (!isChatEvent(payload)) return null;
  if (eventName !== "" && eventName !== payload.type) return null;
  return payload;
}

/** 两个连续行结束符构成一个 SSE 帧边界（兼容 \n\n / \r\n\r\n / 混合）。 */
const FRAME_BOUNDARY = /(?:\r\n|\n|\r){2}/g;

export interface SseDecoder {
  /** 喂入一段（可能跨帧、可能半帧）文本，产出其中已完整的事件。 */
  push(chunk: string): ChatEvent[];
  /** 流结束时冲刷缓冲区里最后一帧。 */
  flush(): ChatEvent[];
}

/**
 * 增量 SSE 解码器。TextDecoder 负责字节→字符，本解码器只处理字符层面的分帧，
 * 因此能保证 UTF-8 中文与 SSE 帧同时跨 chunk 时也不丢事件。
 */
export function createSseDecoder(): SseDecoder {
  let buffer = "";

  const drain = (final: boolean): ChatEvent[] => {
    const events: ChatEvent[] = [];
    FRAME_BOUNDARY.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = FRAME_BOUNDARY.exec(buffer)) !== null) {
      const parsed = parseSseFrame(buffer.slice(cursor, match.index));
      if (parsed !== null) events.push(parsed);
      cursor = match.index + match[0].length;
    }
    buffer = buffer.slice(cursor);
    if (final) {
      const parsed = parseSseFrame(buffer);
      if (parsed !== null) events.push(parsed);
      buffer = "";
    }
    return events;
  };

  return {
    push: (chunk: string): ChatEvent[] => {
      buffer += chunk;
      return drain(false);
    },
    flush: (): ChatEvent[] => drain(true),
  };
}

function isTerminal(event: ChatEvent): boolean {
  return event.type === "done" || event.type === "error";
}

export interface OpenChatStreamOptions {
  readonly base?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * 发起 POST /api/chat 并把 SSE body 逐事件 yield。
 *
 * 结束语义：
 *   - 收到 done / error：yield 该事件后立即正常结束（error 不抛异常，交给 UI 显示）
 *   - 流提前关闭且未收到 done / error：抛 SseTransportError("incomplete")，断链可见
 *   - HTTP 非 2xx / 无 body / 读取异常：抛 SseTransportError，错误文案带端点与状态
 *   - 用户主动 abort：AbortError 原样冒泡，由调用方按「已中止」处理
 */
export async function* openChatStream(
  request: ChatRequest,
  options: OpenChatStreamOptions = {},
): AsyncGenerator<ChatEvent, void, undefined> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? globalThis.fetch;
  const init: RequestInit = {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(request),
  };
  if (options.signal !== undefined) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetchImpl(`${options.base ?? ""}${CHAT_STREAM_PATH}`, init);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new SseTransportError(
      `POST ${CHAT_STREAM_PATH} 失败：${describeError(cause)}`,
      "http",
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      /* 响应体不可读时保留状态文本 */
    }
    throw new SseTransportError(
      `POST ${CHAT_STREAM_PATH} → ${response.status}${detail ? `: ${detail}` : ""}`,
      "http",
    );
  }
  if (response.body === null) {
    throw new SseTransportError(`POST ${CHAT_STREAM_PATH} 响应没有可读的 SSE body`, "stream");
  }

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder("utf-8");
  const decoder = createSseDecoder();
  let terminal = false;

  const emit = function* (events: ChatEvent[]): Generator<ChatEvent, void, undefined> {
    for (const event of events) {
      yield event;
      if (isTerminal(event)) {
        terminal = true;
        return;
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = textDecoder.decode();
        for (const event of emit([...decoder.push(tail), ...decoder.flush()])) {
          yield event;
        }
        if (terminal) return;
        break;
      }
      const text = textDecoder.decode(value, { stream: true });
      for (const event of emit(decoder.push(text))) {
        yield event;
      }
      if (terminal) return;
    }
    if (!terminal) {
      throw new SseTransportError(
        "SSE 流在未收到 done / error 事件前中断（连接断开或服务端异常）",
        "incomplete",
      );
    }
  } catch (cause) {
    if (isAbortError(cause) || cause instanceof SseTransportError) throw cause;
    throw new SseTransportError(`读取 SSE 流失败：${describeError(cause)}`, "stream");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader 已释放则忽略 */
    }
  }
}
