import type {
  ProviderConfig,
  ProviderHealth,
  ProviderPurpose,
  HealthcheckProbe,
  HealthcheckResult,
  ChatOptions,
  ChatChunk,
  ProviderMessage,
} from "@knowself/contracts";
import type { ToolRegistry } from "@knowself/mcp-host";
import type { ZodTypeAny } from "zod";
import { createRegistry } from "./registry";
import { runHealthcheck } from "./healthcheck";
import { chat as doChat } from "./chat";
import { runWithTools } from "./runWithTools";
import { requestStructured } from "./structured";

export type { ToolRegistry };

export interface ProviderAdapter {
  init(): Promise<void>;
  healthcheck(probe?: HealthcheckProbe): Promise<HealthcheckResult[]>;
  listProviders(): ProviderConfig[];
  listHealth(): ProviderHealth[];
  pickProvider(purpose: ProviderPurpose): ProviderConfig | null;
  chat(opts: ChatOptions): AsyncIterable<ChatChunk>;
  runWithTools(opts: ChatOptions, signal?: AbortSignal): AsyncIterable<ChatChunk>;
  requestStructured(req: {
    provider_id: string;
    messages: ProviderMessage[];
    schema: ZodTypeAny;
    schemaName: string;
    maxRepairAttempts?: number;
  }): Promise<unknown>;
  shutdown(): Promise<void>;
}

export function createProviderAdapter(opts: {
  configs: ProviderConfig[];
  toolRegistry: ToolRegistry;
  now?: () => string;
  fetchImpl?: typeof fetch;
}): ProviderAdapter {
  const registry = createRegistry(opts.configs);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toolRegistry = opts.toolRegistry;

  return {
    async init() {
      await Promise.allSettled(
        opts.configs.map(async (c) => {
          const adapter = registry.getAdapter(c.id);
          if (!adapter) return;
          const result = await runHealthcheck(
            adapter,
            c,
            { ping: true, tools: false, caching: false },
            fetchImpl,
          );
          const health = registry.getHealth(c.id);
          if (health)
            registry.updateHealth(c.id, {
              ...health,
              probed_supports_tools: result.tools_ok,
              probed_supports_caching: result.caching_ok,
              last_checked_at: result.checked_at,
              last_error: result.error,
            });
        }),
      );
    },

    async healthcheck(probe) {
      const p = probe ?? { ping: true, tools: false, caching: false };
      return Promise.all(
        opts.configs.map(async (c) => {
          const adapter = registry.getAdapter(c.id);
          return adapter
            ? runHealthcheck(adapter, c, p, fetchImpl)
            : {
                provider_id: c.id,
                ping_ok: false,
                tools_ok: false,
                caching_ok: false,
                rtt_ms: 0,
                checked_at: new Date().toISOString(),
                error: "No adapter",
              };
        }),
      );
    },

    listProviders: () => registry.list(),
    listHealth: () => registry.listHealth(),
    pickProvider: (p: ProviderPurpose) => registry.pickProvider(p),

    chat(opts) {
      return doChat({ registry, fetchImpl }, opts);
    },
    runWithTools(opts, signal) {
      return runWithTools(
        { registry, toolRegistry, fetchImpl },
        opts as ChatOptions & { messages: ProviderMessage[] },
        { maxIterations: 8 },
        signal,
      );
    },
    requestStructured(req) {
      return requestStructured({ registry, fetchImpl }, req);
    },
    shutdown: async () => {},
  };
}

export { ProviderError } from "./errors";
export { createRegistry } from "./registry";
export { createSemaphore } from "./concurrency";

export { createOpenAiAdapter } from "./adapter/openai";
export { createAnthropicAdapter } from "./adapter/anthropic";
export { probeOllama } from "./healthcheck";
export type { ProbeOllamaResult } from "./healthcheck";
