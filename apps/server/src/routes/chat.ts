import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { ChatRequestSchema } from "@knowself/contracts";
import type { ChatRequest, ChatHistoryMessage } from "@knowself/contracts";
import type { Runtime } from "../runtime";
import { zValidate } from "../middleware/validate";
import { newTraceId } from "../lib/trace";
import { runAskToStream } from "../orchestrator/ask";
import { scheduleWriteback } from "../orchestrator/append";

export function chatRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  // POST /api/chat — SSE stream
  router.post("/", zValidate(ChatRequestSchema, "json"), async (c: Context) => {
    const req = c.get("validated") as ChatRequest;
    const traceId = newTraceId();
    c.set("traceId", traceId);

    const signal = runtime.abortRegistry.register(req.conversation_id);

    // Load existing history
    let history: Array<{ role: string; content: unknown }> = [];
    try {
      const conv = runtime.conversationStore.getConversation(req.conversation_id);
      history = conv.messages;
    } catch {
      runtime.conversationStore.ensureConversation(req.conversation_id, {
        title: req.user_message.slice(0, 128),
        provider_id: req.provider_id,
      });
    }

    const historyMsgs = history as Parameters<typeof runAskToStream>[1]["history"];

    // 持久化用户消息
    try {
      runtime.conversationStore.appendMessage({
        id: randomUUID(),
        conversation_id: req.conversation_id,
        role: "user",
        content: [{ kind: "text", text: req.user_message }],
        created_at: new Date().toISOString(),
        provider_id: req.provider_id,
        model: null,
      });
    } catch {
      /* 持久化失败不阻塞对话 */
    }

    const { stream, getAssistantText } = runAskToStream(
      {
        contextRouter: runtime.contextRouter,
        providerAdapter: runtime.providerAdapter,
        toolRegistry: runtime.mcpHost.getToolRegistry(),
        settings: {
          conversation: runtime.settings.conversation,
          tool_defaults: runtime.settings.tool_defaults,
        },
      },
      { req, traceId, history: historyMsgs, signal },
    );

    // Persist assistant message + schedule writeback after stream completes
    const [responseStream, watchStream] = (stream as unknown as ReadableStream<Uint8Array>).tee();
    void (async () => {
      const reader = watchStream.getReader();
      while (!(await reader.read()).done) {
        /* drain */
      }
      reader.releaseLock();

      const assistantText = getAssistantText();
      if (!assistantText) return;

      const now = new Date().toISOString();

      // 持久化助手消息
      try {
        runtime.conversationStore.appendMessage({
          id: randomUUID(),
          conversation_id: req.conversation_id,
          role: "assistant",
          content: [{ kind: "text", text: assistantText }],
          created_at: now,
          provider_id: req.provider_id,
          model: null,
        });
      } catch {
        /* 持久化失败不阻塞 */
      }

      // Schedule writeback — 仅用户消息进蒸馏
      const writeBack = req.write_back ?? true;
      if (writeBack) {
        scheduleWriteback({ ingestion: runtime.ingestion }, req.conversation_id, [
          {
            id: randomUUID(),
            conversation_id: req.conversation_id,
            role: "user",
            content: [{ kind: "text", text: req.user_message }],
            created_at: now,
            provider_id: req.provider_id,
            model: null,
          },
        ]);
      }
    })();

    return new Response(responseStream as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Trace-Id": traceId,
      },
    });
  });

  // POST /api/chat/abort
  router.post("/abort", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const conversationId = body.conversation_id as string | undefined;
    if (!conversationId) {
      return c.json({ ok: false, message: "Missing conversation_id" }, 400);
    }
    const aborted = runtime.abortRegistry.abort(conversationId);
    return c.json({ ok: aborted });
  });

  return router;
}
