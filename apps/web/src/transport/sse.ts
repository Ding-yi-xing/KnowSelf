import type { ChatEvent } from "@knowself/contracts";
import { TransportError } from "./types";

/**
 * SSE 解析器——把浏览器 fetch ReadableStream 逐行解析为 ChatEvent 异步迭代。
 *
 * SSE 协议形态：
 *   event: <type>\n
 *   data: <JSON>\n\n
 *
 * 调用方需处理 TransportError（error 事件码映射）与 AbortError（fetch 中断）。
 */
export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<ChatEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let _eventType = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // 最后一个片段可能不完整，保留到下次拼接
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          _eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const dataStr = line.slice(6);
          if (!dataStr) continue;

          let parsed: ChatEvent;
          try {
            parsed = JSON.parse(dataStr) as ChatEvent;
          } catch {
            // 跳过格式异常的 chunk
            continue;
          }

          // 做最轻量的 type 校验——若服务端发了 error 事件则直接抛异常中断迭代
          if (parsed.type === "error") {
            throw new TransportError(
              parsed.code,
              mapCodeToStatus(parsed.code),
              parsed.message,
              "trace_id" in parsed ? parsed.trace_id : undefined,
            );
          }

          yield parsed;
          _eventType = "";
        }
        // 空行 = 事件分隔符，已由上面 yield 消费，跳过
      }
    }
  } finally {
    // 确保 reader 释放
    try {
      reader.releaseLock();
    } catch {
      // 已经释放则忽略
    }
  }
}

/** 将 ChatEvent error code 映射为 HTTP 状态码（用于 TransportError.status）。 */
function mapCodeToStatus(code: string): number {
  switch (code) {
    case "BAD_REQUEST":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "NOT_FOUND":
      return 404;
    case "LOCK_BUSY":
      return 409;
    case "VALIDATION":
      return 422;
    case "ABORTED":
      return 499;
    case "INTERNAL":
      return 500;
    case "PROVIDER_FAIL":
    case "TOOL_FAIL":
      return 502;
    case "NOT_READY":
      return 503;
    default:
      return 500;
  }
}
