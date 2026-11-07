import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ProviderMessage } from "@knowself/contracts";

const TestSchema = z.object({ name: z.string(), age: z.number() });

// Mock the chat module that structured.ts depends on
vi.mock("../dist/chat.js", () => ({
  chat: vi.fn(),
}));

describe("requestStructured", () => {
  it("returns parsed data when provider returns valid JSON", async () => {
    const { chat } = await import("../dist/chat.js");
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

    const { requestStructured } = await import("../dist/structured.js");
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
    const { chat } = await import("../dist/chat.js");
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

    const { requestStructured } = await import("../dist/structured.js");
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
    const { chat } = await import("../dist/chat.js");
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

    const { requestStructured } = await import("../dist/structured.js");
    const { ProviderError } = await import("../dist/errors.js");

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
    const { chat } = await import("../dist/chat.js");
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

    const { requestStructured } = await import("../dist/structured.js");
    const { ProviderError } = await import("../dist/errors.js");

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
});
