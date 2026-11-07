import type { FetchFallbackPolicy, ToolInvocation, ToolResult } from "@knowself/contracts";
import type { IMcpClient } from "./client/types";

export function isAntiCrawl(output: string, policy: FetchFallbackPolicy): boolean {
  if (!policy.enabled) return false;

  if (output.length < policy.min_content_length) return true;

  const lower = output.toLowerCase();
  for (const kw of policy.fallback_keywords) {
    if (lower.includes(kw.toLowerCase())) return true;
  }

  return false;
}

export function wrapFetchWithFallback(
  primary: IMcpClient,
  fallback: IMcpClient | null,
  policy: FetchFallbackPolicy,
): (invocation: ToolInvocation) => Promise<ToolResult> {
  return async (invocation) => {
    const { bareName } = (() => {
      const idx = invocation.name.indexOf("__");
      return { bareName: idx >= 0 ? invocation.name.slice(idx + 2) : invocation.name };
    })();

    if (!policy.enabled || !fallback) {
      return primary.invoke(bareName, invocation.input);
    }

    try {
      const result = await primary.invoke(bareName, invocation.input);

      if (isAntiCrawl(result.output, policy)) {
        const _fbResult = await fallback.invoke("navigate_page" as never, {
          url: (invocation.input as Record<string, unknown>)?.url,
        });
        const snapshot = await fallback.invoke("take_snapshot" as never, {});

        return {
          ...result,
          output: snapshot.output,
          source_id: fallback.sourceId,
        } satisfies ToolResult;
      }

      return result;
    } catch {
      if (!fallback) throw new Error("no fallback available");

      const _fbResult = await fallback.invoke("navigate_page" as never, {
        url: (invocation.input as Record<string, unknown>)?.url,
      });
      const snapshot = await fallback.invoke("take_snapshot" as never, {});

      return {
        tool_use_id: invocation.tool_use_id,
        name: invocation.name,
        is_error: false,
        output: snapshot.output,
        error_code: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 0,
        source_id: fallback.sourceId,
      } satisfies ToolResult;
    }
  };
}
