import type {
  ToolDescriptor,
  ToolInvocation,
  ToolResult,
  ToolRegistryChange,
  ToolSourceId,
  ToolFullName,
} from "@knowself/contracts";
import type { IMcpClient } from "./client/types";
import type { ToolDescriptorInput } from "./client/types";
import { fromFullName, toFullName } from "./namespace";

export interface ToolRegistry {
  list(): ToolDescriptor[];
  get(name: ToolFullName): ToolDescriptor | null;
  invoke(invocation: ToolInvocation): Promise<ToolResult>;
  onChange(listener: (e: ToolRegistryChange) => void): () => void;
  mergeFromSource(sourceId: ToolSourceId, tools: ToolDescriptorInput[]): void;
  registerClient(sourceId: ToolSourceId, client: IMcpClient): void;
  getClient(sourceId: ToolSourceId): IMcpClient | undefined;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<ToolFullName, ToolDescriptor>();
  const clients = new Map<ToolSourceId, IMcpClient>();
  const listeners = new Set<(e: ToolRegistryChange) => void>();

  function emit(reason: ToolRegistryChange["reason"]) {
    const change: ToolRegistryChange = {
      reason,
      tools: [...tools.values()],
      occurred_at: new Date().toISOString(),
    };
    for (const fn of listeners) {
      try {
        fn(change);
      } catch {
        /* isolate */
      }
    }
  }

  return {
    list(): ToolDescriptor[] {
      return [...tools.values()];
    },

    get(name: ToolFullName): ToolDescriptor | null {
      return tools.get(name) ?? null;
    },

    async invoke(invocation: ToolInvocation): Promise<ToolResult> {
      const parsed = fromFullName(invocation.name);
      if (!parsed) {
        return {
          tool_use_id: invocation.tool_use_id,
          name: invocation.name,
          is_error: true,
          output: `Invalid tool name: ${invocation.name}`,
          error_code: "TOOL_NOT_FOUND",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 0,
          source_id: "fetch" as ToolSourceId,
        } satisfies ToolResult;
      }

      const client = clients.get(parsed.sourceId);
      if (!client) {
        return {
          tool_use_id: invocation.tool_use_id,
          name: invocation.name,
          is_error: true,
          output: `Tool source not found: ${parsed.sourceId}`,
          error_code: "TOOL_NOT_FOUND",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 0,
          source_id: parsed.sourceId,
        } satisfies ToolResult;
      }

      try {
        return await client.invoke(parsed.bareName, invocation.input);
      } catch (err) {
        return {
          tool_use_id: invocation.tool_use_id,
          name: invocation.name,
          is_error: true,
          output: err instanceof Error ? err.message : String(err),
          error_code: "UPSTREAM_ERROR",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 0,
          source_id: parsed.sourceId,
        } satisfies ToolResult;
      }
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    mergeFromSource(sourceId: ToolSourceId, input: ToolDescriptorInput[]) {
      // Remove old tools from this source
      for (const [name, t] of tools) {
        if (t.source_id === sourceId) tools.delete(name);
      }
      const now = new Date().toISOString();
      for (const t of input) {
        const fullName = toFullName(sourceId, t.name as never);
        tools.set(fullName, {
          name: fullName,
          source_id: sourceId,
          bare_name: t.name as never,
          description: t.description,
          input_schema: t.input_schema,
          tags: [],
          declared_dangerous: false,
          timeout_ms: 60_000,
          created_at: now,
        } satisfies ToolDescriptor);
      }
      emit("source_reconnected");
    },

    registerClient(sourceId: ToolSourceId, client: IMcpClient) {
      clients.set(sourceId, client);
    },

    getClient(sourceId: ToolSourceId) {
      return clients.get(sourceId);
    },
  };
}
