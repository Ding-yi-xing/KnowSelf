import type { McpHttpConfig, ToolSourceId } from "@knowself/contracts";
import type { IMcpClient } from "./types";
import { InvalidTransportError } from "../errors";

export async function createHttpClient(
  _config: McpHttpConfig,
  _opts: {
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    sourceId: ToolSourceId;
  },
): Promise<IMcpClient> {
  throw new InvalidTransportError(
    _opts.sourceId,
    undefined,
    "streamable_http transport 在 V2 实现",
  );
}
