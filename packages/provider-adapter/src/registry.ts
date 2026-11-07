import type {
  ProviderConfig,
  ProviderHealth,
  ProviderPurpose,
  ProviderId,
} from "@knowself/contracts";
import { createOpenAiAdapter } from "./adapter/openai";
import { createAnthropicAdapter } from "./adapter/anthropic";
import { createCustomAdapter } from "./adapter/custom";
import type { IAdapter } from "./adapter/types";
import { createSemaphore } from "./concurrency";
import { makeInitialHealth } from "./failover";

export function createRegistry(configs: ProviderConfig[]) {
  const adapters = new Map<ProviderId, IAdapter>();
  const healthMap = new Map<ProviderId, ProviderHealth>();
  const semaphores = new Map<ProviderId, ReturnType<typeof createSemaphore>>();

  for (const c of configs) {
    const adapter = (() => {
      switch (c.protocol) {
        case "openai":
          return createOpenAiAdapter(c);
        case "anthropic":
          return createAnthropicAdapter(c);
        default:
          return createCustomAdapter(c);
      }
    })();
    adapters.set(c.id, adapter);
    healthMap.set(c.id, makeInitialHealth(c.id, new Date().toISOString()));
    semaphores.set(c.id, createSemaphore(c.max_concurrency));
  }

  return {
    list(): ProviderConfig[] {
      return configs;
    },

    getConfig(id: ProviderId): ProviderConfig | undefined {
      return configs.find((c) => c.id === id);
    },

    listHealth(): ProviderHealth[] {
      return [...healthMap.values()];
    },

    pickProvider(purpose: ProviderPurpose): ProviderConfig | null {
      const candidates = configs
        .filter((c) => c.purposes.includes(purpose))
        .filter((c) => {
          const h = healthMap.get(c.id);
          return h?.state === "healthy" || h?.state === "degraded";
        })
        .sort((a, b) => {
          const ha = healthMap.get(a.id);
          const hb = healthMap.get(b.id);
          const la = ha?.latency_p50_ms ?? Infinity;
          const lb = hb?.latency_p50_ms ?? Infinity;
          return la - lb;
        });
      return candidates[0] ?? null;
    },

    getAdapter(id: ProviderId): IAdapter | undefined {
      return adapters.get(id);
    },

    getHealth(id: ProviderId): ProviderHealth | undefined {
      return healthMap.get(id);
    },

    updateHealth(id: ProviderId, health: ProviderHealth): void {
      healthMap.set(id, health);
    },

    getSemaphore(id: ProviderId) {
      return semaphores.get(id)!;
    },
  };
}
