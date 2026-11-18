import { describe, expect, it } from "vitest";
import type { ChatChunk, ChatOptions } from "@knowself/contracts";
import {
  MODEL_RETRY_DEFAULTS,
  ModelFailure,
  isRetryableModelFailure,
  modelRetryDelayMs,
  sleepWithSignal,
  withModelRetry,
} from "../src/model-retry.js";

function options(): ChatOptions {
  return {
    provider_id: "provider-1",
    stream: true,
    max_tokens: 256,
    temperature: 0.4,
    stop_sequences: [],
    tools: [],
    metadata: {},
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
}

function busy(status = 429): ModelFailure {
  return new ModelFailure("provider busy", { code: "RATE_LIMIT", status });
}

/** 收集一次 generate 的全部文本与调用次数。 */
async function collect(generate: (input: ChatOptions, signal: AbortSignal) => AsyncIterable<ChatChunk>, signal = new AbortController().signal): Promise<{ text: string; chunks: ChatChunk[] }> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of generate(options(), signal)) chunks.push(chunk);
  const text = chunks.filter((chunk) => chunk.type === "text").map((chunk) => (chunk.type === "text" ? chunk.delta : "")).join("");
  return { text, chunks };
}

describe("model retry (429 / provider busy)", () => {
  it("keeps retrying far past the dsh default of 5 until the model answers", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        if (calls <= 9) throw busy();
        yield { type: "text", delta: "好了" };
      },
      { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 },
    );

    const { text } = await collect(generate);
    expect(text).toBe("好了");
    expect(calls).toBe(10);
    expect(sleeps).toHaveLength(9);
  });

  it("retries structured RATE_LIMIT failures thrown as plain errors with a code", async () => {
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("upstream said 429"), { code: "RATE_LIMIT" });
        yield { type: "text", delta: "ok" };
      },
      { sleep: async () => {} },
    );
    expect((await collect(generate)).text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries provider-busy wording that carries no status code at all", async () => {
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        if (calls === 1) throw new Error("服务繁忙，请稍后重试");
        yield { type: "text", delta: "ok" };
      },
      { sleep: async () => {} },
    );
    expect((await collect(generate)).text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries the adapter error chunk and honours its retry_after_ms", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        if (calls === 1) {
          yield { type: "error", upstream_status: 429, message: "slow down", retryable: true, retry_after_ms: 1_500 };
          return;
        }
        yield { type: "text", delta: "ok" };
      },
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect((await collect(generate)).text).toBe("ok");
    expect(sleeps).toEqual([1_500]);
  });

  it("treats an adapter error chunk marked retryable=false as terminal", async () => {
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        yield { type: "error", upstream_status: 401, message: "bad key", retryable: false };
      },
      { sleep: async () => {} },
    );
    await expect(collect(generate)).rejects.toThrow("bad key");
    expect(calls).toBe(1);
  });

  it("drops partial text from a failed attempt instead of duplicating it", async () => {
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        if (calls === 1) {
          yield { type: "text", delta: "半截" };
          throw busy();
        }
        yield { type: "text", delta: "完整" };
      },
      { sleep: async () => {} },
    );
    expect((await collect(generate)).text).toBe("完整");
  });

  it("never retries terminal failures (auth, quota, invalid request)", async () => {
    for (const code of ["AUTH", "QUOTA", "INVALID_REQUEST", "INVALID_CREDENTIAL"]) {
      let calls = 0;
      const generate = withModelRetry(
        async function* (): AsyncGenerator<ChatChunk> {
          calls += 1;
          throw new ModelFailure("nope", { code });
        },
        { sleep: async () => {} },
      );
      await expect(collect(generate)).rejects.toThrow("nope");
      expect(calls, code).toBe(1);
      expect(isRetryableModelFailure(new ModelFailure("nope", { code }))).toBe(false);
    }
  });

  it("never retries an unrecognised failure, so a real bug cannot loop forever", async () => {
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        throw new TypeError("cannot read properties of undefined");
      },
      { sleep: async () => {} },
    );
    await expect(collect(generate)).rejects.toThrow(TypeError);
    expect(calls).toBe(1);
  });

  it("stops the moment the user stops the task, even while waiting to retry", async () => {
    const controller = new AbortController();
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        throw busy();
      },
      { sleep: async (_ms, signal) => { controller.abort("user_stopped"); expect(signal.aborted).toBe(true); } },
    );

    await expect(collect(generate, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("honours maxAttempts when a caller wants a bounded run", async () => {
    let calls = 0;
    const generate = withModelRetry(
      async function* (): AsyncGenerator<ChatChunk> {
        calls += 1;
        throw busy();
      },
      { sleep: async () => {}, maxAttempts: 3 },
    );
    await expect(collect(generate)).rejects.toThrow("provider busy");
    expect(calls).toBe(3);
  });
});

describe("model retry backoff", () => {
  it("grows exponentially and caps at maxDelayMs", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => modelRetryDelayMs(attempt, { random: () => 0.5 }));
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it("keeps jitter inside the configured band", () => {
    const low = modelRetryDelayMs(1, { random: () => 0 });
    const high = modelRetryDelayMs(1, { random: () => 1 });
    expect(low).toBe(MODEL_RETRY_DEFAULTS.initialDelayMs * (1 - MODEL_RETRY_DEFAULTS.jitterRatio));
    expect(high).toBe(Math.round(MODEL_RETRY_DEFAULTS.initialDelayMs * (1 + MODEL_RETRY_DEFAULTS.jitterRatio)));
  });

  it("prefers the provider's retry_after_ms but still respects the cap", () => {
    expect(modelRetryDelayMs(1, { retryAfterMs: 3_000, random: () => 0.5 })).toBe(3_000);
    expect(modelRetryDelayMs(1, { retryAfterMs: 900_000, random: () => 0.5 })).toBe(60_000);
  });
});

describe("sleepWithSignal", () => {
  it("resolves early when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = sleepWithSignal(5_000, controller.signal);
    setTimeout(() => controller.abort("stop"), 5);
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
