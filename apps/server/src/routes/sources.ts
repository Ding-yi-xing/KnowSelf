import { Hono } from "hono";
import type { Context } from "hono";
import { ListSourcesQuerySchema, IngestRequestSchema } from "@knowself/contracts";
import type { SourceStatus } from "@knowself/contracts";
import { SourceNotFoundError } from "@knowself/ingestion";
import type { Runtime } from "../runtime";
import { zValidate } from "../middleware/validate";
import { handleSourceUpload } from "../orchestrator/upload";

export function sourceRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  // GET /api/sources
  router.get("/", zValidate(ListSourcesQuerySchema, "query"), (c: Context) => {
    const q = c.get("validated") as {
      status?: string;
      tag?: string;
      limit: number;
      offset: number;
    };
    return c.json(
      runtime.profileStore.sources.list({
        limit: q.limit ?? 50,
        offset: q.offset ?? 0,
        status: q.status as SourceStatus | undefined,
        tag: q.tag,
      }),
    );
  });

  // POST /api/sources -- upload
  router.post("/", async (c: Context) => {
    const source = await handleSourceUpload(
      { ingestion: runtime.ingestion, maxFileBytes: 10_485_760 },
      c,
    );
    return c.json(source, 201 as never);
  });

  // POST /api/sources/batch-delete
  router.post("/batch-delete", async (c: Context) => {
    const body = await c.req.json<{ ids: string[] }>().catch(() => ({ ids: [] }));
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) {
      return c.json({ code: "BAD_REQUEST", message: "ids required" }, 400 as never);
    }
    runtime.profileStore.sources.deleteMany(ids);
    return c.json({ ok: true, deleted: ids.length });
  });

  // GET /api/sources/:id
  router.get("/:id", (c: Context) => {
    const id = c.req.param("id")!;
    const source = getSourceOrThrow(runtime, id);
    const proposals = runtime.ingestion.listProposals(id);
    return c.json({ source, proposals, linked_profile_count: 0 });
  });

  // DELETE /api/sources/:id
  router.delete("/:id", (c: Context) => {
    const id = c.req.param("id")!;
    getSourceOrThrow(runtime, id);
    runtime.profileStore.sources.delete(id);
    return c.json({ ok: true });
  });

  // POST /api/sources/:id/ingest
  router.post("/:id/ingest", zValidate(IngestRequestSchema, "json"), async (c: Context) => {
    const id = c.req.param("id")!;
    const req = c.get("validated") as Parameters<typeof runtime.ingestion.runDistill>[1];
    const source = getSourceOrThrow(runtime, id);
    const result = await runtime.ingestion.runDistill(source, req);
    return c.json(result);
  });

  return router;
}

function getSourceOrThrow(runtime: Runtime, id: string) {
  try {
    return runtime.profileStore.sources.get(id);
  } catch (err) {
    if ((err as { code?: string }).code === "PROFILE_NOT_FOUND") {
      throw new SourceNotFoundError(id);
    }
    throw err;
  }
}
