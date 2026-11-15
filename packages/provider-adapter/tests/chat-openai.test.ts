import { describe, it, expect } from "vitest";
import { createOpenAiAdapter } from "../src/adapter/openai";

const testConfig = {
  id: "test-openai",
  label: "Test",
  protocol: "openai" as const,
  base_url: "https://api.example.com",
  api_key: "sk-test",
  model: "test-model",
  purposes: ["chat" as const],
  default_for: [],
  request_timeout_ms: 60000,
  max_retries: 1,
  max_concurrency: 4,
  extra_headers: {} as Record<string, string>,
  declared_supports_tools: true,
  declared_supports_caching: false,
  tags: [],
};

describe("OpenAI adapter encodeRequest", () => {
  const adapter = createOpenAiAdapter(testConfig);

  it("builds correct request for simple chat", () => {
    const { url, init } = adapter.encodeRequest({
      provider_id: "test-openai",
      messages: [{ role: "user", content: [{ kind: "text", text: "Hello" }] }],
      tools: [],
      stream: true,
      max_tokens: 100,
      stop_sequences: [],
      metadata: {},
    });

    expect(url).toBe("https://api.example.com/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toBe("Hello");
  });

  it("includes tools when provided", () => {
    const { init } = adapter.encodeRequest({
      provider_id: "test-openai",
      messages: [{ role: "user", content: [{ kind: "text", text: "Hi" }] }],
      tools: [{ name: "echo", description: "Echo", input_schema: {} }],
      stream: false,
      max_tokens: 50,
      stop_sequences: [],
      metadata: {},
    });

    const body = JSON.parse(init.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
  });
});

describe("OpenAI adapter decodeStream", () => {
  const adapter = createOpenAiAdapter(testConfig);

  it("yields text chunks from content deltas", async () => {
    const events = (async function* () {
      yield { data: '{"choices":[{"delta":{"content":"Hello"}}]}' };
      yield { data: '{"choices":[{"delta":{"content":" World"}}]}' };
      yield {
        data: '{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      };
    })();

    const chunks: unknown[] = [];
    for await (const c of adapter.decodeStream(events)) {
      chunks.push(c);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ type: "text", delta: "Hello" });
    expect(chunks[1]).toMatchObject({ type: "text", delta: " World" });
    expect(chunks[2]).toMatchObject({ type: "message_end", stop_reason: "end_turn" });
  });

  it("yields tool_use for finish_reason=tool_calls", async () => {
    const events = (async function* () {
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "echo", arguments: '{"msg":"hi"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      };
    })();

    const chunks: unknown[] = [];
    for await (const c of adapter.decodeStream(events)) {
      chunks.push(c);
    }

    const toolUseChunks = chunks.filter((c: { type: string }) => c.type === "tool_use");
    expect(toolUseChunks).toHaveLength(1);
    expect(toolUseChunks[0]).toMatchObject({ type: "tool_use", name: "echo" });
  });
});
