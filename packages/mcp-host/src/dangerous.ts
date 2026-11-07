import type {
  ToolDescriptor,
  ToolInvocation,
  ToolResult,
  ToolErrorCode,
} from "@knowself/contracts";

export function createDangerousGate(
  confirm?: (d: ToolDescriptor) => Promise<boolean>,
): (invocation: ToolInvocation, descriptor: ToolDescriptor) => Promise<ToolResult | null> {
  return async (invocation, descriptor) => {
    if (!descriptor.declared_dangerous) return null;

    if (!confirm) {
      const startedAt = new Date().toISOString();
      return {
        tool_use_id: invocation.tool_use_id,
        name: descriptor.name,
        is_error: true,
        output: "Tool execution rejected: dangerous tool with no confirm handler",
        error_code: "DANGEROUS_REJECTED" as ToolErrorCode,
        started_at: startedAt,
        finished_at: startedAt,
        duration_ms: 0,
        source_id: descriptor.source_id,
      };
    }

    const allowed = await confirm(descriptor);
    if (!allowed) {
      const startedAt = new Date().toISOString();
      return {
        tool_use_id: invocation.tool_use_id,
        name: descriptor.name,
        is_error: true,
        output: "Tool execution rejected by user",
        error_code: "DANGEROUS_REJECTED" as ToolErrorCode,
        started_at: startedAt,
        finished_at: startedAt,
        duration_ms: 0,
        source_id: descriptor.source_id,
      };
    }

    return null;
  };
}
