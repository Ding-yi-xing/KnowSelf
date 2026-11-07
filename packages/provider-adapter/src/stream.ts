const STREAM_TIMEOUT_MS = 90_000;

export interface SseEvent {
  event?: string;
  data?: string;
  id?: string;
}

export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEventTime = Date.now();

  const _timeoutLoop = (async function* () {
    while (true) {
      await new Promise((r) => setTimeout(r, 5000));
      if (Date.now() - lastEventTime > STREAM_TIMEOUT_MS) {
        yield { _timeout: true as const };
        return;
      }
    }
  })();

  try {
    while (true) {
      if (signal?.aborted) break;

      const result = await reader.read();
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        const event: SseEvent = {};
        for (const line of trimmed.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          if (colon < 0) continue;
          const field = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trimStart();
          if (field === "event") event.event = value;
          else if (field === "data") event.data = value;
          else if (field === "id") event.id = value;
        }

        if (event.data !== undefined || event.event !== undefined) {
          lastEventTime = Date.now();
          yield event;
        }
      }
    }
  } finally {
    try {
      void reader.cancel();
    } catch {
      /* cleanup */
    }
  }
}
