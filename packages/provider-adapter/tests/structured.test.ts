import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ProviderMessage } from "@knowself/contracts";

const TestSchema = z.object({ name: z.string(), age: z.number() });

// Mock the chat module that structured.ts depends on
vi.mock("../src/chat", () => ({
  chat: vi.fn(),
}));

describe("requestStructured", () => {
  it("returns parsed data when provider returns valid JSON", async () => {
    const { chat } = await import("../src/chat");
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "text", delta: '{"name":"Alice","age":30}' };
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        token_usage: {
          input_tokens: 5,
          output_tokens: 10,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    });

    const { requestStructured } = await import("../src/structured");
    const result = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "Give me JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
      },
    );

    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("gives one repair attempt when first JSON is invalid", async () => {
    const { chat } = await import("../src/chat");
    let callCount = 0;
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: "text", delta: "not valid json" };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          token_usage: {
            input_tokens: 5,
            output_tokens: 10,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        };
      } else {
        yield { type: "text", delta: '{"name":"Bob","age":25}' };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          token_usage: {
            input_tokens: 10,
            output_tokens: 15,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        };
      }
    });

    const { requestStructured } = await import("../src/structured");
    const result = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "Give me JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 1,
      },
    );

    expect(result).toEqual({ name: "Bob", age: 25 });
    expect(callCount).toBe(2);
  });

  it("throws ProviderError when repair also fails", async () => {
    const { chat } = await import("../src/chat");
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "text", delta: "always bad json" };
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        token_usage: {
          input_tokens: 5,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    });

    const { requestStructured } = await import("../src/structured");
    const { ProviderError } = await import("../src/errors");

    await expect(
      requestStructured(
        { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
        {
          provider_id: "test",
          messages: [
            { role: "user", content: [{ kind: "text", text: "JSON please" }] },
          ] as ProviderMessage[],
          schema: TestSchema,
          schemaName: "TestSchema",
          maxRepairAttempts: 1,
        },
      ),
    ).rejects.toThrow(ProviderError);
  });

  it("skips repair when maxRepairAttempts is 0", async () => {
    const { chat } = await import("../src/chat");
    let callCount = 0;
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      callCount++;
      yield { type: "text", delta: "bad json" };
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        token_usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    });

    const { requestStructured } = await import("../src/structured");
    const { ProviderError } = await import("../src/errors");

    await expect(
      requestStructured(
        { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
        {
          provider_id: "test",
          messages: [
            { role: "user", content: [{ kind: "text", text: "JSON" }] },
          ] as ProviderMessage[],
          schema: TestSchema,
          schemaName: "TestSchema",
          maxRepairAttempts: 0,
        },
      ),
    ).rejects.toThrow(ProviderError);
    expect(callCount).toBe(1);
  });

  it("surfaces a non-retryable upstream 404 verbatim instead of faking a validation failure", async () => {
    const { chat } = await import("../src/chat");
    let callCount = 0;
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      callCount++;
      // W-5 实测形状：模型名不存在时网关回 404 + not_found_error 体
      yield {
        type: "error",
        upstream_status: 404,
        message: 'HTTP 404: {"type":"error","error":{"type":"not_found_error","message":"model is not found"}}',
        retryable: false,
      };
    });

    const { requestStructured } = await import("../src/structured");
    const { ProviderError } = await import("../src/errors");

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 1,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ProviderError);
    const message = (error as Error).message;
    expect(message).toContain("404");
    expect(message).toContain("model is not found");
    // 绝不能伪装成 schema 校验失败（W-5 的误诊根因）
    expect(message).not.toContain("Structured output validation failed");
    // 不可重试 → 不浪费第二次调用
    expect(callCount).toBe(1);
  });

  it("retries a retryable upstream 5xx and reports the last transport error", async () => {
    const { chat } = await import("../src/chat");
    let callCount = 0;
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      callCount++;
      yield {
        type: "error",
        upstream_status: 503,
        message: `HTTP 503: upstream overloaded (call ${callCount})`,
        retryable: true,
      };
    });

    const { requestStructured } = await import("../src/structured");
    const { ProviderError } = await import("../src/errors");

    // W-8/A3：**必须注入 sleep 桩**。不注入就走 defaultSleep，
    // 这条用例会真等 500+1000 = 1520ms，把整个套件拖慢一个数量级。
    const sleep = vi.fn(async (_ms: number) => {});

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never, sleep },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 2,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ProviderError);
    // 1 次首发 + 2 次重试
    expect(callCount).toBe(3);
    // 退避被真正走到（次数 + 递增毫秒），而不是"恰好没等"
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
    const message = (error as Error).message;
    expect(message).toContain("503");
    expect(message).toContain("call 3");
    expect(message).not.toContain("Structured output validation failed");
  });

  it("puts schema name and field-level zod issues into the thrown message", async () => {
    const { chat } = await import("../src/chat");
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      // 缺 excerpts，body 存在 —— 典型「字段级」失败
      yield { type: "text", delta: '{"writes":[{"body":"x"}]}' };
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        token_usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    });

    const NestedSchema = z.object({
      writes: z.array(
        z.object({
          body: z.string(),
          excerpts: z.array(z.object({ start: z.number(), end: z.number() })),
        }),
      ),
    });

    const { requestStructured } = await import("../src/structured");

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: NestedSchema,
        schemaName: "NestedSchema",
        maxRepairAttempts: 0,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Structured output validation failed after 1 attempts");
    expect(message).toContain("schema=NestedSchema");
    expect(message).toContain("writes[0].excerpts");
    expect(message).toContain("Required");
  });

  it("reports both transport and validation failures when they occur together", async () => {
    const { chat } = await import("../src/chat");
    let callCount = 0;
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // 第一轮：模型给了输出，但漏了必需字段
        yield { type: "text", delta: '{"writes":[{"body":"x"}]}' };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          token_usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        };
        return;
      }
      // 第二轮：上游挂了
      yield {
        type: "error",
        upstream_status: 502,
        message: "HTTP 502: bad gateway",
        retryable: false,
      };
    });

    const NestedSchema = z.object({
      writes: z.array(
        z.object({
          body: z.string(),
          excerpts: z.array(z.object({ start: z.number(), end: z.number() })),
        }),
      ),
    });

    const { requestStructured } = await import("../src/structured");

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: NestedSchema,
        schemaName: "NestedSchema",
        maxRepairAttempts: 1,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Structured output validation failed after 2 attempts");
    expect(message).toContain("writes[0].excerpts");
    expect(message).toContain("also saw upstream error");
    expect(message).toContain("HTTP 502");
  });
});

describe("extractZodIssues", () => {
  it("flattens invalid_union branches into field-level paths", async () => {
    const { extractZodIssues } = await import("../src/structured");

    const UnionSchema = z.union([
      z.object({ writes: z.array(z.object({ body: z.string() })) }),
      z.array(z.object({ body: z.string() })),
    ]);

    let caught: unknown = null;
    try {
      UnionSchema.parse({ writes: [{ body: 1 }] });
    } catch (err) {
      caught = err;
    }

    const issues = extractZodIssues(caught);
    const paths = issues.map((i) => i.path);
    // union 自身位置被记录，且分支错误被展开到字段级
    expect(issues.some((i) => i.code === "invalid_union")).toBe(true);
    expect(paths).toContain("writes[0].body");
  });

  it("returns an empty array for non-zod errors", async () => {
    const { extractZodIssues } = await import("../src/structured");
    expect(extractZodIssues(new SyntaxError("Unexpected token }"))).toEqual([]);
    expect(extractZodIssues(null)).toEqual([]);
    expect(extractZodIssues(undefined)).toEqual([]);
  });
});

describe("requestStructured 错误码映射（W-6/C）", () => {
  it("401 映射为 AUTH_FAILED 且 retryable=false", async () => {
    const { chat } = await import("../src/chat");
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "error",
        upstream_status: 401,
        message: "HTTP 401: invalid api key",
        retryable: false,
      };
    });

    const { requestStructured } = await import("../src/structured");
    const { ProviderError } = await import("../src/errors");

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 1,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as { code: string }).code).toBe("AUTH_FAILED");
    expect((error as { retryable: boolean }).retryable).toBe(false);
    expect((error as Error).message).toContain("invalid api key");
  });

  it("403 同样映射为 AUTH_FAILED", async () => {
    const { chat } = await import("../src/chat");
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "error",
        upstream_status: 403,
        message: "HTTP 403: forbidden",
        retryable: false,
      };
    });

    const { requestStructured } = await import("../src/structured");

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 0,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect((error as { code: string }).code).toBe("AUTH_FAILED");
    expect((error as { retryable: boolean }).retryable).toBe(false);
  });

  it("503 仍是 UPSTREAM_5XX 且 retryable=true", async () => {    const { chat } = await import("../src/chat");
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "error",
        upstream_status: 503,
        message: "HTTP 503: overloaded",
        retryable: true,
      };
    });

    const { requestStructured } = await import("../src/structured");

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 0,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect((error as { code: string }).code).toBe("UPSTREAM_5XX");
    expect((error as { retryable: boolean }).retryable).toBe(true);
  });
});

/**
 * W-7/B：429 归 `RATE_LIMITED` 且**必须退避**。
 *
 * 之前 429 走 `UPSTREAM_5XX + retryable=false`（因为判定是 `status>=500`），
 * 结果既不重试也不记录「被限流」——真机复验时正好撞上。
 *
 * 退避用**注入的 sleep 桩**断言毫秒数，测试自己绝不真等待。
 */
describe("requestStructured 429 限流与退避（W-7/B）", () => {
  /** 构造一个只回 429 的 chat 桩；`retryAfterMs` 决定 chunk 里带不带建议值。 */
  async function mock429(retryAfterMs?: number) {
    const { chat } = await import("../src/chat");
    let calls = 0;
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      calls++;
      yield {
        type: "error",
        upstream_status: 429,
        message: "HTTP 429: inference exceeds tpm/rpm limit",
        retryable: true,
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      };
    });
    return () => calls;
  }

  it("429 → code=RATE_LIMITED 且 retryable=true，按 attempts 重试", async () => {
    const callCount = await mock429();
    const sleep = vi.fn(async () => {});
    const { requestStructured } = await import("../src/structured");

    const error = await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never, sleep },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 2,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect((error as { code: string }).code).toBe("RATE_LIMITED");
    expect((error as { retryable: boolean }).retryable).toBe(true);
    // 1 次首发 + 2 次重试
    expect(callCount()).toBe(3);
    // 两次重试前各退避一次
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("有 retry-after 时退避取建议值（1000ms），不走指数 500ms", async () => {
    await mock429(1000);
    const sleep = vi.fn(async (_ms: number) => {});
    const { requestStructured } = await import("../src/structured");

    await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never, sleep },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 1,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("无 retry-after 时走指数退避 500ms → 1000ms", async () => {
    await mock429();
    const sleep = vi.fn(async (_ms: number) => {});
    const { requestStructured } = await import("../src/structured");

    await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never, sleep },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 2,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it("不可重试的 404 不退避", async () => {
    const { chat } = await import("../src/chat");
    (chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "error",
        upstream_status: 404,
        message: "HTTP 404: model is not found",
        retryable: false,
      };
    });
    const sleep = vi.fn(async () => {});
    const { requestStructured } = await import("../src/structured");

    await requestStructured(
      { registry: { getConfig: () => ({ request_timeout_ms: 5000 }) } as never, sleep },
      {
        provider_id: "test",
        messages: [
          { role: "user", content: [{ kind: "text", text: "JSON" }] },
        ] as ProviderMessage[],
        schema: TestSchema,
        schemaName: "TestSchema",
        maxRepairAttempts: 2,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("computeBackoffMs（W-7/B）", () => {
  it("有建议值时取建议值，上限 8000ms", async () => {
    const { computeBackoffMs } = await import("../src/structured");
    expect(computeBackoffMs(0, 1000)).toBe(1000);
    expect(computeBackoffMs(3, 60_000)).toBe(8000);
  });

  it("无建议值时指数增长并封顶 8000ms", async () => {
    const { computeBackoffMs } = await import("../src/structured");
    expect(computeBackoffMs(0, null)).toBe(500);
    expect(computeBackoffMs(1, null)).toBe(1000);
    expect(computeBackoffMs(2, null)).toBe(2000);
    expect(computeBackoffMs(9, null)).toBe(8000);
    expect(computeBackoffMs(0, undefined)).toBe(500);
  });
});
