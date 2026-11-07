import type { BuiltinToolConfig } from "@knowself/contracts";
import type { IMcpClient } from "../client/types";

export interface IBuiltinTool {
  readonly kind: string;
  createClient(config: BuiltinToolConfig): Promise<IMcpClient>;
}
