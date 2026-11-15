import { describe, it, expect } from "vitest";
import { createDangerousGate } from "../src/dangerous.js";

describe("createDangerousGate", () => {
  const safeTool = {
    name: "fetch__get",
    source_id: "fetch",
    bare_name: "get",
    description: "Fetch",
    input_schema: {},
    tags: [],
    declared_dangerous: false,
    timeout_ms: 60000,
    created_at: new Date().toISOString(),
  };

  const dangerousTool = { ...safeTool, declared_dangerous: true, name: "shell__exec" };

  const invocation = {
    tool_use_id: "inv-1",
    name: "shell__exec" as never,
    input: { command: "ls" },
    conversation_id: "conv-1",
    message_id: "msg-1",
    trace_id: "trace-1",
  };

  it("returns null for non-dangerous tools", async () => {
    const gate = createDangerousGate();
    const result = await gate(invocation, safeTool);
    expect(result).toBeNull();
  });

  it("returns error when dangerous and no confirm handler", async () => {
    const gate = createDangerousGate();
    const result = await gate(invocation, dangerousTool);
    expect(result).not.toBeNull();
    expect(result!.is_error).toBe(true);
    expect(result!.error_code).toBe("DANGEROUS_REJECTED");
  });

  it("returns error when dangerous and confirm returns false", async () => {
    const gate = createDangerousGate(async () => false);
    const result = await gate(invocation, dangerousTool);
    expect(result).not.toBeNull();
    expect(result!.is_error).toBe(true);
  });

  it("returns null when dangerous and confirm returns true", async () => {
    const gate = createDangerousGate(async () => true);
    const result = await gate(invocation, dangerousTool);
    expect(result).toBeNull();
  });
});
