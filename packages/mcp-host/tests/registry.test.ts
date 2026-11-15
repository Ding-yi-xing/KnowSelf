import { describe, it, expect, beforeEach } from "vitest";
import { createToolRegistry } from "../src/registry.js";
import { toFullName } from "../src/namespace.js";
import type { ToolRegistry } from "../src/registry.js";
import type { ToolResult } from "@knowself/contracts";

function makeMockClient(sourceId: string) {
  return {
    sourceId,
    async listTools() {
      return [
        {
          name: toFullName(sourceId as never, "echo" as never),
          source_id: sourceId as never,
          bare_name: "echo" as never,
          description: "Echo tool",
          input_schema: {},
          tags: [],
          declared_dangerous: false,
          timeout_ms: 60000,
          created_at: new Date().toISOString(),
        },
      ];
    },
    async invoke(bareName: string, input: unknown) {
      return {
        tool_use_id: "test-use-id",
        name: toFullName(sourceId as never, bareName as never),
        is_error: false,
        output: `echo: ${JSON.stringify(input)}`,
        error_code: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 1,
        source_id: sourceId as never,
      } satisfies ToolResult;
    },
    async dispose() {},
  };
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createToolRegistry();
  });

  it("returns empty list initially", () => {
    expect(registry.list()).toEqual([]);
  });

  it("get returns null for unknown tool", () => {
    expect(registry.get("unknown__tool" as never)).toBeNull();
  });

  it("mergeFromSource registers tools with full names", () => {
    registry.mergeFromSource("fetch" as never, [
      { name: "get", description: "Fetch a URL", input_schema: {} },
    ]);
    const tools = registry.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("fetch__get");
    expect(tools[0]!.source_id).toBe("fetch");
  });

  it("mergeFromSource replaces old tools from same source", () => {
    registry.mergeFromSource("fetch" as never, [
      { name: "get", description: "v1", input_schema: {} },
    ]);
    registry.mergeFromSource("fetch" as never, [
      { name: "get", description: "v2", input_schema: {} },
      { name: "post", description: "POST", input_schema: {} },
    ]);
    expect(registry.list()).toHaveLength(2);
  });

  it("onChange fires when tools are registered", () => {
    const calls: unknown[] = [];
    registry.onChange((e) => calls.push(e));
    registry.mergeFromSource("fetch" as never, [
      { name: "get", description: "Fetch", input_schema: {} },
    ]);
    expect(calls).toHaveLength(1);
    const change = calls[0] as { reason: string; tools: unknown[] };
    expect(change.reason).toBe("source_reconnected");
    expect(change.tools).toHaveLength(1);
  });

  it("invoke routes to correct client and returns result", async () => {
    const client = makeMockClient("fetch");
    registry.registerClient("fetch" as never, client);
    registry.mergeFromSource("fetch" as never, [
      { name: "echo", description: "Echo", input_schema: {} },
    ]);

    const result = await registry.invoke({
      tool_use_id: "test-use",
      name: "fetch__echo" as never,
      input: { message: "hello" },
      conversation_id: "conv-1",
      message_id: "msg-1",
      trace_id: "trace-1",
    });

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("hello");
  });

  it("invoke returns error for unknown tool source", async () => {
    const result = await registry.invoke({
      tool_use_id: "test-use",
      name: "unknown__tool" as never,
      input: {},
      conversation_id: "conv-1",
      message_id: "msg-1",
      trace_id: "trace-1",
    });

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("TOOL_NOT_FOUND");
  });

  it("invoke returns error when client throws", async () => {
    const client = {
      sourceId: "bad" as never,
      async listTools() {
        return [];
      },
      async invoke() {
        throw new Error("crash");
      },
      async dispose() {},
    };
    registry.registerClient("bad" as never, client);
    registry.mergeFromSource("bad" as never, [
      { name: "crash", description: "", input_schema: {} },
    ]);

    const result = await registry.invoke({
      tool_use_id: "test-use",
      name: "bad__crash" as never,
      input: {},
      conversation_id: "conv-1",
      message_id: "msg-1",
      trace_id: "trace-1",
    });

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("UPSTREAM_ERROR");
  });
});
