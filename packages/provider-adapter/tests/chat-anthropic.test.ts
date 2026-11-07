import { describe, it, expect } from "vitest";
import { createAnthropicAdapter } from "../dist/adapter/anthropic.js";

const testConfig = {
  id: "test-anthropic",
  label: "Test",
  protocol: "anthropic" as const,
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
  declared_supports_caching: true,
  tags: [],
};

describe("Anthropic adapter encodeRequest", () => {
  const adapter = createAnthropicAdapter(testConfig);

  it("builds correct request for simple chat", () => {
    const { url, init } = adapter.encodeRequest({
      provider_id: "test-anthropic",
      messages: [{ role: "user", content: [{ kind: "text", text: "Hello" }] }],
      tools: [],
      stream: true,
      max_tokens: 100,
      stop_sequences: [],
      metadata: {},
    });

    expect(url).toBe("https://api.example.com/messages");
    expect(init.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
    });

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts system messages", () => {
    const { init } = adapter.encodeRequest({
      provider_id: "test-anthropic",
      messages: [
        { role: "system", content: [{ kind: "text", text: "You are helpful." }] },
        { role: "user", content: [{ kind: "text", text: "Hi" }] },
      ],
      tools: [],
      stream: false,
      max_tokens: 50,
      stop_sequences: [],
      metadata: {},
    });

    const body = JSON.parse(init.body as string);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toBe("You are helpful.");
  });
});

describe("Anthropic adapter decodeStream", () => {
  const adapter = createAnthropicAdapter(testConfig);

  it("yields text chunks from content_block_delta", async () => {
    const events = (async function* () {
      yield {
        event: "content_block_start",
        data: '{"content_block":{"type":"text","text":""},"index":0}',
      };
      yield {
        event: "content_block_delta",
        data: '{"delta":{"type":"text_delta","text":"Hello"},"index":0}',
      };
      yield {
        event: "message_delta",
        data: '{"delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":5,"output_tokens":1}}',
      };
    })();

    const chunks: unknown[] = [];
    for await (const c of adapter.decodeStream(events)) {
      chunks.push(c);
    }

    const textChunks = chunks.filter((c: { type: string }) => c.type === "text");
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0]).toMatchObject({ type: "text", delta: "Hello" });
  });

  it("yields tool_use from content_block_start/stop", async () => {
    const events = (async function* () {
      yield {
        event: "content_block_start",
        data: JSON.stringify({
          content_block: { type: "tool_use", id: "toolu_1", name: "echo" },
          index: 0,
        }),
      };
      yield {
        event: "content_block_delta",
        data: JSON.stringify({
          delta: { type: "input_json_delta", partial_json: '{"msg":"hi"}' },
          index: 0,
        }),
      };
      yield { event: "content_block_stop", data: "{}" };
    })();

    const chunks: unknown[] = [];
    for await (const c of adapter.decodeStream(events)) {
      chunks.push(c);
    }

    const toolUse = chunks.find((c: { type: string }) => c.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse).toMatchObject({ type: "tool_use", name: "echo" });
  });
});
