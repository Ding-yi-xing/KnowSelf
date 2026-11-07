/**
 * global-teardown.ts — e2e 全局清理
 */

import { rmSync } from "node:fs";

export default async function globalTeardown(): Promise<void> {
  const g = globalThis.__KNOWSELF_E2E__;
  if (!g) return;

  // Kill processes
  if (g.serverProc && !g.serverProc.killed) {
    g.serverProc.kill("SIGTERM");
  }
  if (g.webProc && !g.webProc.killed) {
    g.webProc.kill("SIGTERM");
  }

  // Close browser
  if (g.browser) {
    await g.browser.close();
  }

  // Clean up temp dir
  try {
    rmSync(g.tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  console.log("[e2e] teardown complete");
}
