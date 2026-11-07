import { Hono } from "hono";
import type { Context } from "hono";
import { ListConversationsQuerySchema, RenameConversationRequestSchema } from "@knowself/contracts";
import type { Runtime } from "../runtime";
import { zValidate } from "../middleware/validate";

export function conversationRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  // GET /api/conversations
  router.get("/", zValidate(ListConversationsQuerySchema, "query"), (c: Context) => {
    const q = c.get("validated") as Parameters<
      typeof runtime.conversationStore.listConversations
    >[0];
    return c.json(runtime.conversationStore.listConversations(q));
  });

  // GET /api/conversations/:id
  router.get("/:id", (c: Context) => {
    const id = c.req.param("id")!;
    try {
      return c.json(runtime.conversationStore.getConversation(id));
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "NOT_FOUND") {
        return c.json({ code: "NOT_FOUND", message: "Conversation not found" }, 404 as never);
      }
      throw err;
    }
  });

  // PATCH /api/conversations/:id
  router.patch("/:id", zValidate(RenameConversationRequestSchema, "json"), (c: Context) => {
    const id = c.req.param("id")!;
    const body = c.get("validated") as { title: string };
    try {
      return c.json(runtime.conversationStore.renameConversation(id, body.title));
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "NOT_FOUND") {
        return c.json({ code: "NOT_FOUND", message: "Conversation not found" }, 404 as never);
      }
      throw err;
    }
  });

  // DELETE /api/conversations/:id
  router.delete("/:id", (c: Context) => {
    const id = c.req.param("id")!;
    try {
      runtime.conversationStore.deleteConversation(id);
      return c.json({ ok: true });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "NOT_FOUND") {
        return c.json({ code: "NOT_FOUND", message: "Conversation not found" }, 404 as never);
      }
      throw err;
    }
  });

  return router;
}
