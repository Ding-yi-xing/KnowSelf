import { describe, expect, it } from "vitest";
import type { ChatChunk, ChatOptions } from "@knowself/contracts";
import { createDshGenerate } from "../src/services.js";
import { withModelRetry } from "../src/model-retry.js";

function options(): ChatOptions {
  return {
    provider_id: "provider-1",
    stream: true,
    max_tokens: 128,
    temperature: 0.2,
    stop_sequences: [],
    tools: [],
    metadata: {},
    messages: [{ role: "user", content: [{ type: "text", text: "在吗" }] }],
  };
}

/** 一个永远挂起、只在 signal 中断时抛 AbortError 的 dsh 流。 */
function hangingStream(signal: AbortSignal): AsyncIterable<Record<string, unknown>> {
  return (async function* (): AsyncGenerator<Record<string, unknown>> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  })();
}

async function drain(generate: (input: ChatOptions, signal: AbortSignal) => AsyncIterable<ChatChunk>, signal: AbortSignal): Promise<string> {
  let text = "";
  for await (const chunk of generate(options(), signal)) {
    if (chunk.type === "text") text += chunk.delta;
  }
  return text;
}

describe("createDshGenerate + model retry", () => {
  it("treats the per-attempt timeout as a retryable TIMEOUT instead of a task failure", async () => {
    let attempts = 0;
    const host = {
      llm: {
        stream: (input: Record<string, unknown>) => {
          attempts += 1;
          const signal = input["signal"] as AbortSignal;
          if (attempts === 1) return hangingStream(signal);
          return (async function* (): AsyncGenerator<Record<string, unknown>> {
            yield { type: "text-delta", text: "在的" };
            yield { type: "finish", reason: { kind: "stop" } };
          })();
        },
      },
    };
    const generate = withModelRetry(
      createDshGenerate(host, () => ({ provider: "deepseek-official", model: "deepseek-flash" }), { provider: "", model: "" }, { attemptTimeoutMs: 30 }),
      { sleep: async () => {} },
    );

    const text = await drain(generate, new AbortController().signal);
    expect(text).toBe("在的");
    expect(attempts).toBe(2);
  });

  it("still surfaces a real provider failure with its code so the retry layer can classify it", async () => {
    const host = {
      llm: {
        stream: () => (async function* (): AsyncGenerator<Record<string, unknown>> {
          yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", status: 401, message: "invalid api key" } } };
        })(),
      },
    };
    const generate = withModelRetry(
      createDshGenerate(host, () => undefined, { provider: "deepseek-official", model: "deepseek-flash" }),
      { sleep: async () => {} },
    );
    await expect(drain(generate, new AbortController().signal)).rejects.toThrow("invalid api key");
  });

  it("stops without retrying when the caller aborts (user pressed stop)", async () => {
    const controller = new AbortController();
    const host = {
      llm: {
        stream: (input: Record<string, unknown>) => {
          controller.abort("user_stopped");
          return hangingStream(input["signal"] as AbortSignal);
        },
      },
    };
    const generate = withModelRetry(
      createDshGenerate(host, () => undefined, { provider: "deepseek-official", model: "deepseek-flash" }, { attemptTimeoutMs: 5_000 }),
      { sleep: async () => {} },
    );
    await expect(drain(generate, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
