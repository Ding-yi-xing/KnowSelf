import { Hono } from "hono";
import type { Context } from "hono";
import { DecideProposalRequestSchema } from "@knowself/contracts";
import type { Runtime } from "../runtime";
import { zValidate } from "../middleware/validate";

export function proposalRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  // GET /api/proposals?source_id=xxx  或  GET /api/proposals?status=pending（全局）
  router.get("/", (c: Context) => {
    const sourceId = c.req.query("source_id");
    const status = c.req.query("status") ?? "pending";
    try {
      if (sourceId) {
        return c.json(runtime.ingestion.listProposals(sourceId));
      }
      return c.json(
        runtime.ingestion.listProposalsByStatus(
          status as "pending" | "accepted" | "edited" | "rejected" | "all",
          100,
        ),
      );
    } catch {
      return c.json([]);
    }
  });

  // PATCH /api/proposals/:id/decide
  router.patch("/:id/decide", zValidate(DecideProposalRequestSchema, "json"), (c: Context) => {
    const id = c.req.param("id")!;
    const req = c.get("validated") as { decision: string; body?: string };
    try {
      if (req.decision === "accept") {
        return c.json(runtime.ingestion.acceptProposal(id));
      }
      if (req.decision === "edit" && req.body) {
        return c.json(runtime.ingestion.editProposal(id, req.body));
      }
      if (req.decision === "reject") {
        return c.json(runtime.ingestion.rejectProposal(id));
      }
      return c.json({ code: "BAD_REQUEST", message: "Invalid decision" }, 400 as never);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "PROPOSAL_NOT_FOUND") {
        return c.json({ code: "PROPOSAL_NOT_FOUND", message: e.message }, 404 as never);
      }
      if (e.code === "PROPOSAL_NOT_PENDING") {
        return c.json({ code: "PROPOSAL_NOT_PENDING", message: e.message }, 409 as never);
      }
      if (e.code === "INVALID_TARGET_REF") {
        return c.json({ code: "INVALID_TARGET_REF", message: e.message }, 400 as never);
      }
      if (e.code === "CONSTRAINT_VIOLATION" || e.code === "AUTOWRITE_REJECTED") {
        return c.json({ code: e.code, message: e.message }, 409 as never);
      }
      if (e.code === "PROFILE_NOT_FOUND") {
        return c.json({ code: "PROFILE_NOT_FOUND", message: e.message }, 404 as never);
      }
      throw err;
    }
  });

  return router;
}
