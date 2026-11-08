/**
 * QA 独立验收（严过关）—— 不复用 apps/web/tests/sse.test.ts 与 chatFixtures.ts。
 *
 * 目标：
 *   ① `sse.ts` 是否覆盖 packages/contracts/src/chat.ts 的 ChatEventSchema 全部分支；
 *   ② 未收到 done / error 就断链，是否真的抛错且 UI 可见（自建截断流，不用工程师的 mock）。
 *
 * 独立手段：分支列表直接从契约的 Zod discriminatedUnion 推导（不手写白名单），
 * 并用自建的字节级 reader 伪造网络断链，不依赖 ReadableStream / 全局 fetch。
 */
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatRequest } from "@knowself/contracts";
// 契约源码直接引入：绕开 @knowself/contracts/dist 的 ESM 扩展名解析，
// 保证断言的是 chat.ts 这一份真相源。
import { ChatEventSchema } from "../../../packages/contracts/src/chat";
import { SseTransportError, openChatStream, parseSseFrame } from "../src/transport/sse";

const CONV = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const TRACE = "trace-qa-00000001";
const ISO = "2026-11-07T10:00:00.000Z";

const REQUEST: ChatRequest = {
  conversation_id: CONV,
  user_message: "QA 独立验收",
  provider_id: "primary",
  stream: true,
  tools_enabled: true,
  write_back: true,
};

/** 与 ChatEventSchema 的 8 个分支一一对应的合法载荷。 */
const EVENTS: readonly ChatEvent[] = [
  { type: "message_start", conversation_id: CONV, message_id: MSG, trace_id: TRACE, occurred_at: ISO },
  { type: "text_delta", message_id: MSG, delta: "独立片段" },
  { type: "tool_use_start", message_id: MSG, tool_use_id: "tool-1", name: "fetch__fetch" },
  { type: "tool_use_end", message_id: MSG, tool_use_id: "tool-1", input: { url: "https://example.test" } },
  {
    type: "tool_result",
    message_id: MSG,
    tool_use_id: "tool-1",
    is_error: false,
    output: "页面正文",
    duration_ms: 12,
  },
  { type: "message_end", message_id: MSG, stop_reason: "end_turn" },
  { type: "done", conversation_id: CONV, write_back_triggered: false },
  { type: "error", code: "PROVIDER_FAIL", message: "上游模型报错", message_id: MSG, trace_id: TRACE },
];

function frame(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function eventOf(type: string): ChatEvent {
  const found = EVENTS.find((e) => e.type === type);
  if (found === undefined) throw new Error(`测试夹具缺少事件 ${type}`);
  return found;
}

/** 自建字节 reader：逐段吐字节，最后返回 done=true，不依赖 ReadableStream / Response 实现。 */
function readerOf(chunks: readonly string[]) {
  const encoder = new TextEncoder();
  const bytes = chunks.map((c) => encoder.encode(c));
  let index = 0;
  return {
    read: async (): Promise<{ done: boolean; value: Uint8Array | undefined }> => {
      if (index < bytes.length) return { done: false, value: bytes[index++] };
      return { done: true, value: undefined };
    },
    releaseLock: () => {},
  };
}

function fetchReturning(chunks: readonly string[]): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      body: { getReader: () => readerOf(chunks) },
      text: async () => chunks.join(""),
    }) as unknown as Response) as unknown as typeof fetch;
}

async function collect(chunks: readonly string[]): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of openChatStream(REQUEST, { fetchImpl: fetchReturning(chunks) })) {
    seen.push(event.type);
  }
  return seen;
}

describe("QA 独立：ChatEventSchema 全分支解析", () => {
  it("契约的 8 个分支逐个可解析，且载荷通过 Zod 校验", () => {
    // 分支列表从契约推导，避免「测试白名单和实现白名单一起写错」
    const branchTypes = ChatEventSchema.options.map((option) => option.shape.type.value as string);
    expect(branchTypes).toHaveLength(8);
    expect(new Set(branchTypes)).toEqual(
      new Set([
        "message_start",
        "text_delta",
        "tool_use_start",
        "tool_use_end",
        "tool_result",
        "message_end",
        "done",
        "error",
      ]),
    );
    expect(EVENTS.map((e) => e.type)).toEqual(branchTypes);
    for (const event of EVENTS) {
      expect(ChatEventSchema.safeParse(event).success).toBe(true);
      expect(parseSseFrame(frame(event))).toEqual(event);
    }
  });

  it("注释保活帧与未知类型被丢弃，event/data.type 不一致的帧也被丢弃", () => {
    expect(parseSseFrame(": ping\n\n")).toBeNull();
    expect(parseSseFrame('event: unknown\ndata: {"type":"unknown"}\n\n')).toBeNull();
    expect(parseSseFrame(`event: text_delta\ndata: ${JSON.stringify(eventOf("done"))}\n\n`)).toBeNull();
  });
});

describe("QA 独立：未收到 done / error 的断链必须抛错可见", () => {
  it("截断流（start + delta 后 EOF）→ SseTransportError(phase=incomplete)，已收事件仍可见", async () => {
    const chunks = [frame(eventOf("message_start")), frame(eventOf("text_delta"))];
    await expect(collect(chunks)).rejects.toMatchObject({
      name: "SseTransportError",
      phase: "incomplete",
      message: expect.stringContaining("未收到 done / error"),
    });
    await expect(collect(chunks)).rejects.toBeInstanceOf(SseTransportError);
  });

  it("单个半帧后 EOF 仍然抛 incomplete（不会静默当作正常完成）", async () => {
    const chunks = ['event: text_delta\ndata: {"type":"text_delta","message_id":"' + MSG + '","delta":"半帧"}'];
    await expect(collect(chunks)).rejects.toMatchObject({ phase: "incomplete" });
  });

  it("完全空流（0 字节 body）也抛 incomplete", async () => {
    await expect(collect([])).rejects.toMatchObject({ phase: "incomplete" });
  });

  it("收到 done 正常收尾，且 done 之后的事件不再被 yield（不抛错）", async () => {
    const seen = await collect([
      frame(eventOf("message_start")),
      frame(eventOf("text_delta")),
      frame(eventOf("done")),
      frame(eventOf("text_delta")),
    ]);
    expect(seen).toEqual(["message_start", "text_delta", "done"]);
  });

  it("收到 error 正常收尾，error 作为事件可见且之后不再发 done（不抛错）", async () => {
    const seen = await collect([
      frame(eventOf("message_start")),
      frame(eventOf("error")),
      frame(eventOf("done")),
    ]);
    expect(seen).toEqual(["message_start", "error"]);
  });

  it("保活注释帧夹杂在流中不影响收尾判定", async () => {
    const seen = await collect([
      ": ping\n\n",
      frame(eventOf("message_start")),
      ": ping\n\n",
      frame(eventOf("done")),
    ]);
    expect(seen).toEqual(["message_start", "done"]);
  });
});
