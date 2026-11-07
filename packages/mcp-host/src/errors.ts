/**
 * errors.ts — MCP host 错误类层次
 *
 * 所有错误类继承 McpError，携带 McpErrorCode + 可选 server_id / trace_id。
 */
import type { McpErrorCode, McpErrorPayload, ToolSourceId } from "@knowself/contracts";

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly serverId: ToolSourceId | undefined;
  readonly traceId: string | undefined;

  constructor(code: McpErrorCode, message: string, serverId?: ToolSourceId, traceId?: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.serverId = serverId;
    this.traceId = traceId;
  }

  toPayload(): McpErrorPayload {
    return {
      code: this.code,
      message: this.message,
      server_id: this.serverId,
      trace_id: this.traceId,
    } satisfies McpErrorPayload;
  }
}

export class ServerNotFoundError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string) {
    super(
      "SERVER_NOT_FOUND",
      `MCP server not found: ${serverId ?? "(unknown)"}`,
      serverId,
      traceId,
    );
    this.name = "ServerNotFoundError";
  }
}

export class ServerDisabledError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string) {
    super("SERVER_DISABLED", `MCP server disabled: ${serverId ?? "(unknown)"}`, serverId, traceId);
    this.name = "ServerDisabledError";
  }
}

export class SpawnFailedError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string, detail?: string) {
    super(
      "SPAWN_FAILED",
      `Failed to spawn MCP server: ${serverId ?? "(unknown)"}${detail ? ` - ${detail}` : ""}`,
      serverId,
      traceId,
    );
    this.name = "SpawnFailedError";
  }
}

export class StartupTimeoutError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string) {
    super(
      "STARTUP_TIMEOUT",
      `MCP server startup timeout: ${serverId ?? "(unknown)"}`,
      serverId,
      traceId,
    );
    this.name = "StartupTimeoutError";
  }
}

export class RpcTimeoutError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string) {
    super("RPC_TIMEOUT", `MCP RPC call timeout: ${serverId ?? "(unknown)"}`, serverId, traceId);
    this.name = "RpcTimeoutError";
  }
}

export class RpcErrorError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string, detail?: string) {
    super(
      "RPC_ERROR",
      `MCP RPC error: ${serverId ?? "(unknown)"}${detail ? ` - ${detail}` : ""}`,
      serverId,
      traceId,
    );
    this.name = "RpcErrorError";
  }
}

export class DeadCooldownError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string) {
    super(
      "DEAD_COOLDOWN",
      `MCP server in dead cooldown: ${serverId ?? "(unknown)"}`,
      serverId,
      traceId,
    );
    this.name = "DeadCooldownError";
  }
}

export class InvalidTransportError extends McpError {
  constructor(serverId?: ToolSourceId, traceId?: string, transport?: string) {
    super(
      "INVALID_TRANSPORT",
      `Invalid transport: ${transport ?? "(unknown)"} for server ${serverId ?? "(unknown)"}`,
      serverId,
      traceId,
    );
    this.name = "InvalidTransportError";
  }
}
