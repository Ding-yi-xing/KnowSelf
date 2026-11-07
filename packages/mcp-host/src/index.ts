import type {
  McpServerConfig,
  BuiltinToolConfig,
  ToolDefaults,
  McpHostSnapshot,
} from "@knowself/contracts";
import { createToolRegistry } from "./registry";
import type { ToolRegistry } from "./registry";
import { createStatusTracker } from "./status";
import { spawnAll, shutdownAll } from "./lifecycle";
import type { IMcpClient } from "./client/types";
import { createNativeFetchClient } from "./native-fetch";
import { createNativeSearchClient } from "./native-search";

export type McpHost = {
  init(): Promise<void>;
  getToolRegistry(): ToolRegistry;
  getStatus(): McpHostSnapshot;
  shutdown(): Promise<void>;
};

export async function createMcpHost(opts: {
  servers: McpServerConfig[];
  builtin: BuiltinToolConfig[];
  toolDefaults: ToolDefaults;
  dangerousConfirm?: (d: { name: string; description: string }) => Promise<boolean>;
  now?: () => string;
}): Promise<McpHost> {
  const toolRegistry = createToolRegistry();
  const statusTracker = createStatusTracker();
  let clients = new Map<string, IMcpClient>();

  return {
    async init() {
      clients = await spawnAll({ statusTracker, toolRegistry }, opts.servers);
      if (!toolRegistry.getClient("fetch" as never)) {
        const now = new Date().toISOString();
        const client = createNativeFetchClient({ sourceId: "fetch" as never });
        clients.set("fetch" as never, client);
        toolRegistry.registerClient("fetch" as never, client);
        const tools = await client.listTools();
        toolRegistry.mergeFromSource(
          "fetch" as never,
          tools.map((t) => ({
            name: t.bare_name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        );
        statusTracker.set("fetch" as never, {
          state: "healthy",
          pid: null,
          started_at: now,
          ready_at: now,
          last_error: null,
          restart_count: 0,
          reactivate_at: null,
          tool_names: tools.map((t) => t.name),
        });
      }
      if (!toolRegistry.getClient("web_search" as never)) {
        const now = new Date().toISOString();
        const client = createNativeSearchClient({ sourceId: "web_search" as never });
        clients.set("web_search" as never, client);
        toolRegistry.registerClient("web_search" as never, client);
        const tools = await client.listTools();
        toolRegistry.mergeFromSource(
          "web_search" as never,
          tools.map((t) => ({
            name: t.bare_name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        );
        statusTracker.set("web_search" as never, {
          state: "healthy",
          pid: null,
          started_at: now,
          ready_at: now,
          last_error: null,
          restart_count: 0,
          reactivate_at: null,
          tool_names: tools.map((t) => t.name),
        });
      }
    },

    getToolRegistry() {
      return toolRegistry;
    },

    getStatus() {
      return statusTracker.snapshot();
    },

    async shutdown() {
      await shutdownAll(clients);
    },
  };
}

export { createToolRegistry } from "./registry";
export type { ToolRegistry } from "./registry";
export { createStatusTracker } from "./status";
export { createStdioClient } from "./client/stdio";
export type { IMcpClient } from "./client/types";
export { toFullName, fromFullName, ensureSourceId } from "./namespace";
export { isAntiCrawl, wrapFetchWithFallback } from "./fallback";
export { createNativeFetchClient } from "./native-fetch";
export { createNativeSearchClient } from "./native-search";
export { createDangerousGate } from "./dangerous";
export * from "./errors";
