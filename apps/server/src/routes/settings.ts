import { Hono } from "hono";
import type { Context } from "hono";
import { PartialAppSettingsSchema } from "@knowself/contracts";
import { saveSettings } from "@knowself/config";
import { createProviderAdapter, probeOllama } from "@knowself/provider-adapter";
import type { Runtime } from "../runtime";
import { zValidate } from "../middleware/validate";
import { z } from "zod";

/** Strict version: rejects undeclared fields at any nesting level. */
const StrictPartialAppSettingsSchema = PartialAppSettingsSchema.strict();

export function settingsRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  // GET /api/settings — 返回明文（本地优先应用，无需脱敏）
  router.get("/", (_c: Context) => {
    return Response.json(runtime.settings);
  });

  // PATCH /api/settings — strict validation rejects undeclared fields
  router.patch("/", zValidate(StrictPartialAppSettingsSchema, "json"), async (c: Context) => {
    const patch = c.get("validated") as Parameters<typeof saveSettings>[1];
    const updated = saveSettings(runtime.paths.rootDir, patch);
    runtime.settings = updated;

    // providers 变更时重建 providerAdapter，确保新 api_key 生效
    if (patch.providers) {
      await runtime.providerAdapter.shutdown();
      runtime.providerAdapter = createProviderAdapter({
        configs: updated.providers,
        toolRegistry: runtime.mcpHost.getToolRegistry(),
      });
      await runtime.providerAdapter.init();
    }

    return c.json(updated);
  });

  // POST /api/settings/providers/scan-ollama
  const ScanOllamaBody = z.object({ base_url: z.string().url().optional() });
  router.post("/providers/scan-ollama", zValidate(ScanOllamaBody, "json"), async (c: Context) => {
    const { base_url } = c.get("validated") as z.infer<typeof ScanOllamaBody>;
    const result = await probeOllama(base_url ?? "http://localhost:11434");
    return c.json({ state: result.state, models: result.models ?? [] });
  });

  return router;
}
