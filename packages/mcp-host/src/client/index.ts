import type { McpTransportConfig, McpServerConfig, ToolSourceId } from "@knowself/contracts";
import { createStdioClient } from "./stdio";
import { createHttpClient } from "./http";
import type { IMcpClient } from "./types";

export async function createClient(
  config: McpServerConfig,
  opts: {
    startupTimeoutMs: number;
    requestTimeoutMs: number;
  },
): Promise<IMcpClient> {
  const sourceId: ToolSourceId = config.id;
  const transport: McpTransportConfig = config.transport_config;

  switch (transport.transport) {
    case "stdio":
      return createStdioClient(transport, {
        sourceId,
        ...opts,
      });
    case "streamable_http":
      return createHttpClient(transport, {
        sourceId,
        ...opts,
      });
    default:
      throw new Error(`Unknown transport`);
  }
}
