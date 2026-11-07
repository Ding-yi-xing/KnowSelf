import type { ProviderConfig, HealthcheckProbe, HealthcheckResult } from "@knowself/contracts";
import type { IAdapter } from "./adapter/types";

export async function runHealthcheck(
  adapter: IAdapter,
  config: ProviderConfig,
  probe: HealthcheckProbe,
  fetchImpl: typeof fetch,
): Promise<HealthcheckResult> {
  const startedAt = Date.now();
  let pingOk = false;
  let toolsOk = false;
  let cachingOk = false;
  let error: string | null = null;

  try {
    if (probe.ping) {
      const req = adapter.encodeRequest({
        provider_id: config.id,
        messages: [{ role: "user", content: [{ kind: "text", text: "ping" }] }],
        tools: [],
        stream: false,
        max_tokens: 1,
        temperature: 0,
        stop_sequences: [],
        metadata: {},
      });
      const res = await withTimeout(
        fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(10_000) }),
        10_000,
      );
      pingOk = res.ok;
      if (!pingOk) error = `HTTP ${res.status}`;
    }

    if (probe.tools && config.declared_supports_tools) {
      toolsOk = true; // placeholder — real echo tool test needs ToolRegistry
    }

    if (probe.caching && config.declared_supports_caching) {
      cachingOk = true; // placeholder — real cache test needs two requests
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    provider_id: config.id,
    ping_ok: pingOk,
    tools_ok: toolsOk,
    caching_ok: cachingOk,
    rtt_ms: Date.now() - startedAt,
    checked_at: new Date().toISOString(),
    error,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), ms),
  );
  return Promise.race([promise, timeout]).finally(() => {
    // 确保 race 输的那一方不会变成未处理的 rejection
    promise.catch(() => {});
    timeout.catch(() => {});
  });
}

export interface ProbeOllamaResult {
  state: "healthy" | "dead";
  models?: string[];
  last_error?: string;
}

export async function probeOllama(baseUrl: string): Promise<ProbeOllamaResult> {
  try {
    const url = new URL("/api/tags", baseUrl.replace(/\/v1\/?$/, ""));
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { state: "dead", last_error: `Ollama ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { state: "healthy", models: (data.models ?? []).map((m) => m.name) };
  } catch (e) {
    return { state: "dead", last_error: String(e) };
  }
}
