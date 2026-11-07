import { describe, it, expect, vi } from "vitest";
import { scheduleAutoDistill } from "../dist/auto.js";
import type { AutoDeps } from "../dist/auto.js";
import type { ChatHistoryMessage } from "@knowself/contracts";

function makeMessages(): ChatHistoryMessage[] {
  return [
    {
      id: "m1",
      conversation_id: "conv-1",
      role: "user",
      content: [{ kind: "text", text: "I live in Beijing." }],
      created_at: new Date().toISOString(),
      provider_id: null,
      model: null,
      token_usage: null,
    },
    {
      id: "m2",
      conversation_id: "conv-1",
      role: "assistant",
      content: [{ kind: "text", text: "Got it, you live in Beijing." }],
      created_at: new Date().toISOString(),
      provider_id: "p1",
      model: "test",
      token_usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    },
  ];
}

describe("scheduleAutoDistill", () => {
  it("returns synchronously without blocking callers", () => {
    const deps: AutoDeps = {
      store: {
        sources: {
          get: vi.fn().mockResolvedValue({ id: "s1" }),
          insert: vi.fn(),
        },
      } as unknown as AutoDeps["store"],
      providerAdapter: {} as AutoDeps["providerAdapter"],
      distillProviderId: "p1",
      createSourceFromMessages: vi.fn().mockResolvedValue({ sourceId: "s1" }),
      now: () => new Date().toISOString(),
    };

    const start = Date.now();
    scheduleAutoDistill(deps, "conv-1", makeMessages());
    expect(Date.now() - start).toBeLessThan(1000); // returned immediately
  });

  it("calls createSourceFromMessages when triggered", async () => {
    const createSourceFromMessages = vi.fn().mockResolvedValue({ sourceId: "s1" });

    const sourceStored = {
      id: "s1",
      kind: "paste" as const,
      mime_type: "text/plain" as const,
      extracted_text: "test",
      original_name: "",
      file_path: null,
      url: null,
      truncated: false,
      char_count: 4,
      user_note: "",
      user_tags: [],
      status: "raw" as const,
      metadata: {} as Record<string, unknown>,
      created_at: new Date().toISOString(),
      last_ingested_at: null,
    };

    const srcGet = vi.fn().mockReturnValue(sourceStored);

    const deps: AutoDeps = {
      store: {
        sources: {
          get: srcGet,
          insert: vi.fn(),
          list: vi.fn(),
          updateStatus: vi.fn(),
          updateNote: vi.fn(),
          delete: vi.fn(),
        },
      } as unknown as AutoDeps["store"],
      providerAdapter: {
        requestStructured: vi.fn().mockResolvedValue({ writes: [] }),
      } as unknown as AutoDeps["providerAdapter"],
      distillProviderId: "p1",
      createSourceFromMessages,
      now: () => new Date().toISOString(),
    };

    scheduleAutoDistill(deps, "conv-1", makeMessages());

    // Wait for queueMicrotask + async operations
    await new Promise((r) => setTimeout(r, 100));

    expect(createSourceFromMessages).toHaveBeenCalled();
  });

  it("swallows errors gracefully without throw", async () => {
    const deps: AutoDeps = {
      store: {
        sources: {
          get: vi.fn().mockImplementation(() => {
            throw new Error("DB broken");
          }),
          insert: vi.fn(),
          list: vi.fn(),
          updateStatus: vi.fn(),
          updateNote: vi.fn(),
          delete: vi.fn(),
        },
      } as unknown as AutoDeps["store"],
      providerAdapter: {} as AutoDeps["providerAdapter"],
      distillProviderId: "p1",
      createSourceFromMessages: vi.fn().mockResolvedValue({ sourceId: "s1" }),
    };

    // Should not throw
    expect(() => scheduleAutoDistill(deps, "conv-1", makeMessages())).not.toThrow();

    // Wait for microtask — should also not throw
    await new Promise((r) => setTimeout(r, 50));
  });
});
