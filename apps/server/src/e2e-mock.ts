/**
 * e2e-mock.ts — MSW handlers for KNOWSELF_E2E_MODE
 *
 * Intercepts provider API calls made by provider-adapter during e2e tests.
 * Returns mock OpenAI-compatible SSE streaming responses so the full
 * server pipeline (chat → ask → SSE → client) runs without real LLM calls.
 *
 * Activated by setting KNOWSELF_E2E_MODE=true before starting the server.
 */
import { http, HttpResponse } from "msw";

// ─── OpenAI-style SSE response template ───────────────────────────

const MOCK_CONTENT = "This is an e2e test mock response.";

async function* openaiSseStream(): AsyncGenerator<Uint8Array> {
  // Simulate a multi-chunk SSE response matching OpenAI streaming format
  const chunks = [
    `data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"${MOCK_CONTENT.slice(0, 20)}"},"index":0}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"${MOCK_CONTENT.slice(20)}"},"index":0}]}\n\n`,
    `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`,
    "data: [DONE]\n\n",
  ];

  for (const line of chunks) {
    yield new TextEncoder().encode(line);
  }
}

function createMockStream(): ReadableStream<Uint8Array> {
  const gen = openaiSseStream();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
  });
}

// ─── Anthropic-style SSE response template ────────────────────────

async function* anthropicSseStream(): AsyncGenerator<Uint8Array> {
  const lines = [
    `data: {"type":"message_start","message":{"id":"mock_msg_1","type":"message","role":"assistant","content":[],"model":"mock-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${MOCK_CONTENT}"}}\n\n`,
    `data: {"type":"content_block_stop","index":0}\n\n`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n`,
    `data: {"type":"message_stop"}\n\n`,
  ];

  for (const line of lines) {
    yield new TextEncoder().encode(line);
  }
}

function createAnthropicMockStream(): ReadableStream<Uint8Array> {
  const gen = anthropicSseStream();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
  });
}

// ─── MSW handlers ─────────────────────────────────────────────────

export const handlers = [
  // OpenAI-compatible: {base_url}/chat/completions
  http.post("*/chat/completions", async ({ request }) => {
    const body = request.body ? ((await request.clone().json()) as { stream?: boolean }) : {};
    const isStream = body.stream === true;

    if (isStream) {
      return new HttpResponse(createMockStream(), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return HttpResponse.json({
      id: "mock-cmpl-1",
      object: "chat.completion",
      choices: [
        { index: 0, message: { role: "assistant", content: MOCK_CONTENT }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }),

  // Anthropic-compatible: {base_url}/v1/messages
  http.post("*/v1/messages", () => {
    return new HttpResponse(createAnthropicMockStream(), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }),

  // Catch-all: return a simple text response for any other provider endpoint
  http.all("*", async ({ request }) => {
    // Skip local server requests and internal URLs
    const url = new URL(request.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return HttpResponse.json({ error: "not mocked" }, { status: 404 });
    }
    return HttpResponse.json({
      id: "mock-fallback",
      object: "chat.completion",
      choices: [
        { index: 0, message: { role: "assistant", content: MOCK_CONTENT }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }),
];
