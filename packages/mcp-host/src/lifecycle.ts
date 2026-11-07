import type { McpServerConfig, ToolSourceId } from "@knowself/contracts";
import type { IMcpClient } from "./client/types";
import { createClient } from "./client/index";
import type { ToolRegistry } from "./registry";
import type { createStatusTracker } from "./status";

export async function spawnAll(
  deps: {
    statusTracker: ReturnType<typeof createStatusTracker>;
    toolRegistry: ToolRegistry;
  },
  configs: McpServerConfig[],
): Promise<Map<ToolSourceId, IMcpClient>> {
  const clients = new Map<ToolSourceId, IMcpClient>();

  const promises = configs
    .filter((c) => c.enabled)
    .map(async (config) => {
      const now = new Date().toISOString();
      try {
        const client = await createClient(config, {
          startupTimeoutMs: config.startup_timeout_ms,
          requestTimeoutMs: config.request_timeout_ms,
        });

        clients.set(config.id, client);
        deps.toolRegistry.registerClient(config.id, client);

        const tools = await client.listTools();
        deps.toolRegistry.mergeFromSource(
          config.id,
          tools.map((t) => ({
            name: t.bare_name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        );

        deps.statusTracker.set(config.id, {
          state: "healthy",
          pid: null,
          started_at: now,
          ready_at: new Date().toISOString(),
          last_error: null,
          tool_names: tools.map((t) => t.name),
        });
      } catch (err) {
        deps.statusTracker.set(config.id, {
          state: "dead",
          pid: null,
          started_at: now,
          last_error: err instanceof Error ? err.message.slice(0, 512) : String(err),
          restart_count: 0,
          reactivate_at: new Date(Date.now() + config.dead_cooldown_ms).toISOString(),
          tool_names: [],
        });
      }
    });

  await Promise.allSettled(promises);
  return clients;
}

export async function shutdownAll(clients: Map<ToolSourceId, IMcpClient>): Promise<void> {
  const promises = [...clients.values()].map((c) =>
    Promise.race([c.dispose(), new Promise<void>((r) => setTimeout(r, 5000))]),
  );
  await Promise.allSettled(promises);
  clients.clear();
}
