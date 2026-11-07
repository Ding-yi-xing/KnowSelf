import type {
  ToolSourceId,
  ToolFullName,
  McpServerStatus,
  McpHostSnapshot,
  McpHealthState,
} from "@knowself/contracts";

export function createStatusTracker() {
  const states = new Map<ToolSourceId, McpServerStatus>();

  function ensure(sourceId: ToolSourceId): McpServerStatus {
    let s = states.get(sourceId);
    if (!s) {
      s = {
        server_id: sourceId,
        state: "starting" as McpHealthState,
        pid: null,
        started_at: null,
        ready_at: null,
        last_error: null,
        restart_count: 0,
        reactivate_at: null,
        tool_names: [],
      };
      states.set(sourceId, s);
    }
    return s;
  }

  return {
    set(sourceId: ToolSourceId, partial: Partial<McpServerStatus>): void {
      const s = ensure(sourceId);
      Object.assign(s, partial);
      states.set(sourceId, s);
    },

    setToolNames(sourceId: ToolSourceId, names: ToolFullName[]): void {
      const s = ensure(sourceId);
      s.tool_names = names;
    },

    snapshot(): McpHostSnapshot {
      const servers = [...states.values()];
      const toolCount = servers.reduce((sum, s) => sum + s.tool_names.length, 0);
      const allReady = servers.every((s) => s.state === "healthy" || s.state === "degraded");
      return {
        servers,
        tool_count: toolCount,
        all_ready: allReady,
        collected_at: new Date().toISOString(),
      };
    },
  };
}
