import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { Context } from "hono";
import { WriteRequestSchema, ExportRequestSchema } from "@knowself/contracts";
import { importProfile } from "@knowself/profile-store";
import type { ProfileDb } from "@knowself/profile-store";
import type { Runtime } from "../runtime";
import { zValidate } from "../middleware/validate";

const profileDbFromRuntime = (rt: Runtime): ProfileDb => ({
  raw: rt.profileDb as never,
  prepare: (sql: string) => rt.profileDb.prepare(sql) as ReturnType<ProfileDb["prepare"]>,
  transaction: <T>(fn: () => T) => rt.profileDb.transaction(fn) as unknown as () => T,
});

export function profileRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  // GET /api/profile/core
  // 单例资源:未初始化时返回默认空 stored,而不是 404。前端首次启动 / 全新数据目录
  // 都依赖此契约不抛错。
  router.get("/core", (_c: Context) => {
    try {
      return Response.json(runtime.profileStore.core.get());
    } catch {
      return Response.json({
        display_name: "我",
        locale: runtime.settings.app.locale ?? "zh-CN",
        section_tags: [],
        body: "",
        updated_at: new Date(0).toISOString(),
        schema_version: 1,
      });
    }
  });

  // PUT /api/profile/core
  router.put("/core", zValidate(WriteRequestSchema, "json"), (c: Context) => {
    const req = c.get("validated") as Parameters<typeof runtime.profileStore.write>[0];
    runtime.profileStore.write(req, { callerKind: "ui" });
    return c.json({ ok: true });
  });

  // GET /api/profile/cards
  router.get("/cards", (_c: Context) => {
    return Response.json(runtime.profileStore.cards.list());
  });

  // GET /api/profile/cards/:key
  router.get("/cards/:key", (c: Context) => {
    const key = c.req.param("key")!;
    try {
      return Response.json(runtime.profileStore.cards.get(key));
    } catch {
      return c.json({ code: "NOT_FOUND", message: "Card not found" }, 404 as never);
    }
  });

  // PUT /api/profile/cards/:key
  router.put("/cards/:key", zValidate(WriteRequestSchema, "json"), (c: Context) => {
    const req = c.get("validated") as Parameters<typeof runtime.profileStore.write>[0];
    runtime.profileStore.write(req, { callerKind: "ui" });
    return c.json({ ok: true });
  });

  // DELETE /api/profile/cards/:key
  router.delete("/cards/:key", (c: Context) => {
    const key = c.req.param("key")!;
    try {
      runtime.profileStore.cards.delete(key);
      return c.json({ ok: true });
    } catch {
      return c.json({ code: "NOT_FOUND", message: "Card not found" }, 404 as never);
    }
  });

  // GET /api/profile/journal
  router.get("/journal", (_c: Context) => {
    return Response.json(runtime.profileStore.journal.listDates());
  });

  // GET /api/profile/journal/:date
  router.get("/journal/:date", (c: Context) => {
    const date = c.req.param("date")!;
    try {
      return Response.json(runtime.profileStore.journal.get(date));
    } catch {
      return c.json({ code: "NOT_FOUND", message: "Journal entry not found" }, 404 as never);
    }
  });

  // POST /api/profile/journal
  router.post("/journal", zValidate(WriteRequestSchema, "json"), (c: Context) => {
    const req = c.get("validated") as Parameters<typeof runtime.profileStore.write>[0];
    runtime.profileStore.write(req, { callerKind: "ui" });
    return c.json({ ok: true });
  });

  // POST /api/profile/export
  router.post("/export", zValidate(ExportRequestSchema, "json"), async (c: Context) => {
    const req = c.get("validated") as Parameters<typeof runtime.profileStore.exportProfile>[0];
    const result = await runtime.profileStore.exportProfile(req);
    return c.json(result);
  });

  // V2-06: POST /api/profile/import
  router.post("/import", async (c: Context) => {
    const body = await c.req.parseBody();
    const file = body.file as File | undefined | null;
    const mode = (body.mode as string) ?? "dry-run";

    if (!file) {
      return c.json({ code: "BAD_REQUEST", message: "需要上传 .zip 文件" }, 400 as never);
    }
    if (!["replace", "merge", "dry-run"].includes(mode)) {
      return c.json(
        { code: "VALIDATION", message: "mode 必须为 replace/merge/dry-run" },
        422 as never,
      );
    }

    const tmpDir = join(tmpdir(), `knowself-import-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const zipPath = join(tmpDir, "upload.zip");
    writeFileSync(zipPath, Buffer.from(await file.arrayBuffer()));

    try {
      const result = await importProfile(
        profileDbFromRuntime(runtime),
        zipPath,
        mode as "replace" | "merge" | "dry-run",
      );
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导入失败";
      return c.json({ code: "IMPORT_FAILED", message: msg }, 500 as never);
    }
  });

  // V2-06: GET /api/profile/export/download
  router.get("/export/download", async (c: Context) => {
    try {
      const buffer = await runtime.profileStore.exportProfileBuffer();
      const filename = `knowself-export-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      c.header("Content-Type", "application/zip");
      c.header("Content-Disposition", `attachment; filename="${filename}"`);
      c.header("Content-Length", buffer.length.toString());
      return c.newResponse(new Uint8Array(buffer));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导出失败";
      return c.json({ code: "EXPORT_FAILED", message: msg }, 500 as never);
    }
  });

  return router;
}
