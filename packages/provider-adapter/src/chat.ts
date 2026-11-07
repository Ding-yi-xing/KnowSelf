import type { ChatOptions, ChatChunk } from "@knowself/contracts";
import { parseSseStream } from "./stream";
import { transitionOnSuccess, transitionOnFailure } from "./failover";
import type { createRegistry } from "./registry";

export async function* chat(
  deps: {
    registry: ReturnType<typeof createRegistry>;
    fetchImpl?: typeof fetch;
  },
  opts: ChatOptions,
  signal?: AbortSignal,
): AsyncIterable<ChatChunk> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const providerId = opts.provider_id;
  const adapter = deps.registry.getAdapter(providerId);

  if (!adapter) {
    yield {
      type: "error",
      upstream_status: null,
      message: `Provider not found: ${providerId}`,
      retryable: false,
    } satisfies ChatChunk;
    return;
  }

  const semaphore = deps.registry.getSemaphore(providerId);
  const release = await semaphore.acquire(signal);

  try {
    const req = adapter.encodeRequest(opts);
    const controller = new AbortController();
    const linkedSignal = signal ? combineSignals(signal, controller.signal) : controller.signal;

    const response = await fetchImpl(req.url, {
      ...req.init,
      signal: linkedSignal,
    });

    if (!response.ok) {
      const msg = `HTTP ${response.status}`;
      deps.registry.updateHealth(
        providerId,
        transitionOnFailure(
          deps.registry.getHealth(providerId)!,
          {
            code: "UPSTREAM_5XX",
            message: msg,
            retryable: response.status >= 500,
            provider_id: providerId,
            upstream_status: response.status,
          },
          new Date().toISOString(),
        ),
      );
      yield {
        type: "error",
        upstream_status: response.status,
        message: msg,
        retryable: response.status >= 500,
      } satisfies ChatChunk;
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        upstream_status: null,
        message: "No response body",
        retryable: true,
      } satisfies ChatChunk;
      return;
    }

    const reader = response.body.getReader();
    const sseStream = parseSseStream(reader, linkedSignal);

    const startMs = Date.now();
    for await (const chunk of adapter.decodeStream(sseStream)) {
      yield chunk;
      if (chunk.type === "message_end") {
        deps.registry.updateHealth(
          providerId,
          transitionOnSuccess(
            deps.registry.getHealth(providerId)!,
            Date.now() - startMs,
            new Date().toISOString(),
          ),
        );
      }
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      yield {
        type: "error",
        upstream_status: null,
        message: "Request aborted",
        retryable: false,
      } satisfies ChatChunk;
      return;
    }
    yield {
      type: "error",
      upstream_status: null,
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
    } satisfies ChatChunk;
  } finally {
    try {
      release();
    } catch {
      /* already released */
    }
  }
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const handler = () => { try { ctrl.abort(a.reason ?? b.reason); } catch { /* already aborted */ } };
  a.addEventListener("abort", handler, { once: true });
  b.addEventListener("abort", handler, { once: true });
  if (a.aborted || b.aborted) ctrl.abort();
  return ctrl.signal;
}
