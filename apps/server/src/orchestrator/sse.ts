import type { ChatChunk, ChatEvent } from "@knowself/contracts";

interface ChunkCtx {
  conversationId: string;
  messageId: string;
  traceId: string;
  now: string;
}

export function fromChatChunk(chunk: ChatChunk, ctx: ChunkCtx): ChatEvent[] {
  switch (chunk.type) {
    case "text":
      return [
        {
          type: "text_delta",
          message_id: ctx.messageId,
          delta: chunk.delta,
        },
      ] as ChatEvent[];

    case "tool_use":
      return [
        {
          type: "tool_use_start",
          message_id: ctx.messageId,
          tool_use_id: chunk.tool_use_id,
          name: chunk.name,
        },
        {
          type: "tool_use_end",
          message_id: ctx.messageId,
          tool_use_id: chunk.tool_use_id,
          input: chunk.input,
        },
      ] as ChatEvent[];

    case "message_end":
      return [
        {
          type: "message_end",
          message_id: ctx.messageId,
          stop_reason: chunk.stop_reason,
        },
      ] as ChatEvent[];

    case "error":
      return [
        {
          type: "error",
          code: "PROVIDER_FAIL",
          message: chunk.message,
          message_id: ctx.messageId,
          trace_id: ctx.traceId,
        } as ChatEvent,
      ] as ChatEvent[];

    default:
      return [];
  }
}

function encodeEvent(event: ChatEvent): string {
  const type = event.type;
  const data = JSON.stringify(event);
  return "event: " + type + "\ndata: " + data + "\n\n";
}

export function makeToolResultEvent(
  result: {
    tool_use_id: string;
    is_error: boolean;
    output: string;
    duration_ms: number;
  },
  messageId: string,
): ChatEvent {
  return {
    type: "tool_result",
    message_id: messageId,
    tool_use_id: result.tool_use_id,
    is_error: result.is_error,
    output: result.output,
    duration_ms: result.duration_ms,
  } as ChatEvent;
}

export function toSseStream(events: AsyncIterable<ChatEvent>): ReadableStream<Uint8Array> {
  let sawError = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // stream already closed
        }
      }, 30_000);

      try {
        for await (const event of events) {
          if (sawError) continue;
          if (event.type === "error") {
            sawError = true;
          }
          controller.enqueue(encoder.encode(encodeEvent(event)));
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Stream error";
        controller.enqueue(
          encoder.encode(
            encodeEvent({
              type: "error",
              code: "INTERNAL",
              message: errMsg,
            } as ChatEvent),
          ),
        );
      } finally {
        if (timer) clearInterval(timer);
        controller.close();
      }
    },

    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return stream;
}

export function makeMessageStart(
  conversationId: string,
  messageId: string,
  traceId: string,
): ChatEvent {
  return {
    type: "message_start",
    conversation_id: conversationId,
    message_id: messageId,
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
  } as ChatEvent;
}

export function makeDone(
  conversationId: string,
  writeBackTriggered: boolean,
): ChatEvent {
  return {
    type: "done",
    conversation_id: conversationId,
    write_back_triggered: writeBackTriggered,
  } as ChatEvent;
}

type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "LOCK_BUSY"
  | "VALIDATION"
  | "INTERNAL"
  | "NOT_READY"
  | "PROVIDER_FAIL"
  | "TOOL_FAIL"
  | "ABORTED";

export function makeError(code: ErrorCode, message: string, traceId: string): ChatEvent {
  return {
    type: "error",
    code,
    message,
    trace_id: traceId,
  } as ChatEvent;
}
