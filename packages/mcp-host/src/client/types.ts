import type { ToolDescriptor, ToolResult, ToolBareName, ToolSourceId } from "@knowself/contracts";

export interface IMcpClient {
  readonly sourceId: ToolSourceId;
  listTools(): Promise<ToolDescriptor[]>;
  invoke(bareName: ToolBareName, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
  dispose(): Promise<void>;
}

export interface ToolDescriptorInput {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
