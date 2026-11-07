import { describe, it, expect, vi } from "vitest";
import { createProviderAdapter } from "../dist/index.js";
import type { ChatChunk, ProviderMessage, ProviderConfig } from "@knowself/contracts";
import type { ToolRegistry } from "@knowself/mcp-host";

// --------------- helpers ---------------

function makeConfig(): ProviderConfig {
  return {
    id: "test",
    label: "Test",
    protocol: "openai",
    base_url: "https://api.example.com",
    api_key: "sk-test",
    model: "test",
    purposes: ["chat"],
    default_for: [],
    request_timeout_ms: 60000,
    max_retries: 1,
    max_concurrency: 4,
    extra_headers: {},
    declared_supports_tools: true,
    declared_supports_caching: false,
    tags: [],
  };
}

function makeFakeToolRegistry(
  invokeImpl?: (name: string) => { is_error: boolean; output: string },
): ToolRegistry {
  return {
    list: () => [
      {
        name: "echo__echo" as never,
        source_id: "echo" as never,
        bare_name: "echo" as never,
        description: "Echo",
        input_schema: {},
        tags: [],
        declared_dangerous: false,
        timeout_ms: 60000,
        created_at: new Date().toISOString(),
      },
    ],
    get: () => null,
    invoke: async (inv) => {
      if (invokeImpl) {
        const r = invokeImpl(inv.name);
        return {
          tool_use_id: inv.tool_use_id,
          name: inv.name,
          is_error: r.is_error,
          output: r.output,
          error_code: null,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 1,
          source_id: "echo" as never,
        };
      }
      return {
        tool_use_id: inv.tool_use_id,
        name: inv.name,
        is_error: false,
        output: "echo ok",
        error_code: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 1,
        source_id: "echo" as never,
      };
    },
    onChange: () => () => {},
    mergeFromSource: () => {},
    registerClient: () => {},
    getClient: () => undefined,
  };
}

function makeMessages(): ProviderMessage[] {
  return [{ role: "user", content: [{ kind: "text", text: "hello" }] }];
}

/**
 * Fake the `chat` module by mocking the import. Since we cannot easily mock
 * async generators across ESM boundaries, we test runWithTools by providing
 * a real ProviderAdapter whose fetch is mocked.
 */

describe("runWithTools", () => {
  it("happy path — yields end_turn and returns when model finishes without tool use", async () => {
    // Mock fetch to return a simple text response with end_turn
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello!"},"finish_reason":"stop"}]}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );

    const pa = createProviderAdapter({
      configs: [makeConfig()],
      toolRegistry: makeFakeToolRegistry(),
      fetchImpl: mockFetch as never,
    });

    const messages = makeMessages();
    const chunks: ChatChunk[] = [];
    for await (const c of pa.runWithTools({
      provider_id: "test",
      messages,
      stream: true,
      max_tokens: 100,
      tools: [],
      stop_sequences: [],
      metadata: {},
    })) {
      chunks.push(c);
    }

    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks.length).toBeGreaterThan(0);
    expect(textChunks[0]!.type).toBe("text");

    const endChunks = chunks.filter((c) => c.type === "message_end");
    expect(endChunks.length).toBeGreaterThan(0);
  });

  it("abort — yields error when AbortSignal is pre-aborted", async () => {
    const pa = createProviderAdapter({
      configs: [makeConfig()],
      toolRegistry: makeFakeToolRegistry(),
      fetchImpl: vi.fn() as never,
    });

    const ctrl = new AbortController();
    ctrl.abort();

    const chunks: ChatChunk[] = [];
    for await (const c of pa.runWithTools(
      {
        provider_id: "test",
        messages: makeMessages(),
        stream: true,
        max_tokens: 100,
        tools: [],
        stop_sequences: [],
        metadata: {},
      },
      ctrl.signal,
    )) {
      chunks.push(c);
    }

    const errors = chunks.filter((c) => c.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/abort/i);
  });

  it("max iterations — yields TOOL_LOOP_OVERFLOW when limit exceeded", async () => {
    // Mock that always returns tool_use, causing infinite loop
    let _callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      _callCount++;
      return Promise.resolve(
        new Response(
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"echo__echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    });

    const pa = createProviderAdapter({
      configs: [makeConfig()],
      toolRegistry: makeFakeToolRegistry(),
      fetchImpl: mockFetch as never,
    });

    const chunks: ChatChunk[] = [];
    for await (const c of pa.runWithTools({
      provider_id: "test",
      messages: makeMessages(),
      stream: true,
      max_tokens: 100,
      tools: [{ name: "echo__echo", description: "echo", input_schema: {} }],
      stop_sequences: [],
      metadata: {},
    })) {
      chunks.push(c);
    }

    const errors = chunks.filter((c) => c.type === "error");
    const overflowErrors = errors.filter((c) => c.message.includes("max iterations"));
    expect(overflowErrors.length).toBeGreaterThan(0);
  });

  it("tool error — continues loop when tool returns is_error=true", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      // First call: tool_use → tool returns error
      // Second call: end_turn (model decides to stop)
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"echo__echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"OK, done."},"finish_reason":"stop"}]}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    });

    const errorToolRegistry = makeFakeToolRegistry(() => ({
      is_error: true,
      output: "tool execution failed",
    }));

    const pa = createProviderAdapter({
      configs: [makeConfig()],
      toolRegistry: errorToolRegistry,
      fetchImpl: mockFetch as never,
    });

    const chunks: ChatChunk[] = [];
    for await (const c of pa.runWithTools({
      provider_id: "test",
      messages: makeMessages(),
      stream: true,
      max_tokens: 100,
      tools: [{ name: "echo__echo", description: "echo", input_schema: {} }],
      stop_sequences: [],
      metadata: {},
    })) {
      chunks.push(c);
    }

    // Should have tool_use from first round + text from second round
    const toolUses = chunks.filter((c) => c.type === "tool_use");
    expect(toolUses.length).toBeGreaterThan(0);
    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks.length).toBeGreaterThan(0);
  });

  it("stream recovery — handles empty tool_uses gracefully when model returns end_turn directly", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"content":"No tools needed."},"finish_reason":"stop"}]}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );

    const pa = createProviderAdapter({
      configs: [makeConfig()],
      toolRegistry: makeFakeToolRegistry(),
      fetchImpl: mockFetch as never,
    });

    const chunks: ChatChunk[] = [];
    for await (const c of pa.runWithTools({
      provider_id: "test",
      messages: makeMessages(),
      stream: true,
      max_tokens: 100,
      tools: [],
      stop_sequences: [],
      metadata: {},
    })) {
      chunks.push(c);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const ends = chunks.filter((c) => c.type === "message_end");
    expect(ends.length).toBeGreaterThan(0);
  });
});
