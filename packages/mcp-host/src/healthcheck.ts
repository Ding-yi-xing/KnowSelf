import type { ToolSourceId } from "@knowself/contracts";
import type { IMcpClient } from "./client/types";
import type { createStatusTracker } from "./status";

export async function runStartupCheck(
  client: IMcpClient,
  sourceId: ToolSourceId,
  statusTracker: ReturnType<typeof createStatusTracker>,
): Promise<void> {
  try {
    await client.listTools();
    statusTracker.set(sourceId, {
      state: "healthy",
      ready_at: new Date().toISOString(),
    });
  } catch {
    // Failure handled by lifecycle
  }
}
