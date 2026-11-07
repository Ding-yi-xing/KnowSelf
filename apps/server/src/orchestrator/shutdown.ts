import type { Runtime } from "../runtime";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function gracefulShutdown(runtime: Runtime, signal: string): Promise<void> {
  console.log(`[shutdown] received ${signal}, shutting down...`);
  let exited = false;

  const forceTimer = setTimeout(() => {
    console.error("[shutdown] forced exit after timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  // Reverse order (reverse of init)
  for (const item of [...runtime.shutdownItems].reverse()) {
    try {
      const result = item.fn();
      if (result instanceof Promise) {
        await result;
      }
      console.log(`[shutdown] ${item.name} done`);
    } catch (err) {
      console.error(`[shutdown] ${item.name} failed:`, err);
    }
  }

  clearTimeout(forceTimer);
  if (!exited) {
    exited = true;
    console.log("[shutdown] graceful shutdown complete");
    process.exit(0);
  }
}
