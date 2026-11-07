/**
 * @knowself/server — Hono BFF
 *
 * Entry point: main() → bootRuntime → createApp → serve
 * Routes: 7 route groups, ~api-routes
 *
 * File manifest:
 *   src/app.ts / runtime.ts
 *   src/middleware/{error,validate,logger,cors}.ts
 *   src/routes/{chat,conversations,profile,sources,proposals,settings,system}.ts
 *   src/orchestrator/{ask,sse,append,upload,export,init,shutdown}.ts
 *   src/persistence/{conversation,db}.ts
 *   src/lib/{mask,trace,abort}.ts
 *   src/errors.ts
 */

import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { bootRuntime } from "./orchestrator/init";
import { createApp } from "./app";

async function main(): Promise<void> {
  // npm workspace 将 cwd 设为 apps/server/，但 settings.json 在项目根
  // 可以通过 KNOWSELF_DATA_DIR 环境变量覆盖（桌面端 sidecar 使用）
  const rootDir = process.env.KNOWSELF_DATA_DIR || resolve(process.cwd(), "../../");

  // ── E2E mode: mock provider calls with MSW ──────────────────────
  if (process.env.KNOWSELF_E2E_MODE) {
    const { setupServer } = await import("msw/node");
    const { handlers } = await import("./e2e-mock");
    const server = setupServer(...handlers);
    server.listen({ onUnhandledRequest: "bypass" });
    console.log("[e2e] MSW intercepting provider API calls");
  }

  console.log("[server] booting runtime...");
  const { runtime, settings } = await bootRuntime(rootDir);

  const app = createApp(runtime);
  const port = settings.app.server_port;

  console.log(`[server] listening on http://127.0.0.1:${port}`);
  const httpServer = serve({ fetch: app.fetch, port }) as unknown as Server;
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[server] FATAL: port ${port} already in use; another sidecar is likely still running`,
      );
    } else {
      console.error(`[server] FATAL: server error: ${err.message}`);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
