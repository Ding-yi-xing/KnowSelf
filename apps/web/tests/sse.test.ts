// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatRequest } from "@knowself/contracts";
import {
  CHAT_ABORT_PATH,
  CHAT_STREAM_PATH,
  SseTransportError,
  createSseDecoder,
  openChatStream,
  parseSseFrame,
} from "../src/transport/sse";
import { resolveProviderDefaults } from "../src/transport/chatApi";
import {
  initialChatViewState,
  reduceChatView,
  type ChatViewState,
} from "../src/features/chat/chatState";
import {
  CONV_ID,
  DEFAULT_CHAT_CHUNKS,
  DEFAULT_SETTINGS,
  doneEvent,
  errorEvent,
  messageEnd,
  messageStart,
  sseFrame,
  sseResponse,
  textDelta,
  toolResult,
  toolUseEnd,
  toolUseStart,
} from "./chatFixtures";

const REQUEST: ChatRequest = {
  conversation_id: CONV_ID,
  user_message: "你好",
  provider_id: "primary",
  stream: true,
  tools_enabled: true,
  write_back: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SSE 帧解析（ChatEventSchema 形状）", () => {
  it("解析契约里的全部 8 种事件", () => {
    const events: ChatEvent[] = [
      messageStart(),
      textDelta("片段"),
      toolUseStart(),
      toolUseEnd(),
      toolResult(),
      messageEnd(),
      doneEvent(),
      errorEvent(),
    ];
    for (const event of events) {
      expect(parseSseFrame(sseFrame(event))).toEqual(event);
    }
  });

  it("忽略保活注释帧 / 非法 JSON / 未知事件 / event 与 data.type 不一致", () => {
    expect(parseSseFrame(": ping")).toBeNull();
    expect(parseSseFrame("data: not-json")).toBeNull();
    expect(parseSseFrame('data: {"type":"mystery"}')).toBeNull();
    expect(
      parseSseFrame(`event: done\ndata: ${JSON.stringify(textDelta("x"))}`),
    ).toBeNull();
  });

  it("支持 \\r\\n 分帧与多行 data", () => {
    const event = textDelta("甲\n乙");
    const json = JSON.stringify(event);
    const multi = `event: text_delta\r\ndata: ${json.slice(0, 20)}\r\ndata: ${json.slice(20)}`;
    expect(parseSseFrame(multi)).toEqual(event);
  });
});

describe("增量 SSE 解码器", () => {
  it("帧与 UTF-8 中文跨 chunk 时不丢事件", () => {
    const decoder = createSseDecoder();
    const stream = [
      sseFrame(messageStart()),
      sseFrame(textDelta("你")),
      sseFrame(textDelta("好")),
      sseFrame(doneEvent()),
    ].join("");

    const half = Math.floor(stream.length / 2);
    const first = decoder.push(stream.slice(0, half));
    const second = decoder.push(stream.slice(half));
    const tail = decoder.flush();
    expect([...first, ...second, ...tail].map((event) => event.type)).toEqual([
      "message_start",
      "text_delta",
      "text_delta",
      "done",
    ]);
  });

  it("flush 能冲刷没有结尾空行的最后一帧", () => {
    const decoder = createSseDecoder();
    expect(decoder.push(`event: done\ndata: ${JSON.stringify(doneEvent())}`)).toEqual([]);
    expect(decoder.flush()).toEqual([doneEvent()]);
  });
});

describe("openChatStream", () => {
  it("逐块 yield 文本增量并在 done 后结束，UI 状态机正确追加文本", async () => {
    const chunks = [
      DEFAULT_CHAT_CHUNKS.slice(0, 2).join(""),
      DEFAULT_CHAT_CHUNKS.slice(2).join(""),
    ];
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const events: ChatEvent[] = [];
    for await (const event of openChatStream(REQUEST)) events.push(event);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CHAT_STREAM_PATH);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "text_delta",
      "text_delta",
      "done",
    ]);

    let state: ChatViewState = initialChatViewState;
    state = reduceChatView(state, { type: "appendUser", id: "u1", text: "你好" });
    state = reduceChatView(state, { type: "beginAssistant", id: "a1" });
    for (const event of events) {
      state = reduceChatView(state, { type: "event", event });
    }
    expect(state.messages[1]?.text).toBe("你好，世界");
    expect(state.status).toBe("idle");
    expect(state.activeMessageId).toBeNull();
  });

  it("error 事件被 yield 且作为终止，之后不再有事件", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          sseFrame(messageStart()),
          sseFrame(errorEvent("模型不可用")),
          sseFrame(textDelta("不该出现")),
        ]),
      ),
    );

    const events: ChatEvent[] = [];
    for await (const event of openChatStream(REQUEST)) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(errorEvent("模型不可用"));

    const state = reduceChatView(initialChatViewState, {
      type: "event",
      event: events[1] as ChatEvent,
    });
    expect(state.status).toBe("error");
    expect(state.error).toEqual({ code: "PROVIDER_FAIL", message: "模型不可用" });
  });

  it("未收到 done / error 就断链时抛出可见的 incomplete 错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([sseFrame(messageStart()), sseFrame(textDelta("半句"))]),
      ),
    );

    await expect(async () => {
      const events: ChatEvent[] = [];
      for await (const event of openChatStream(REQUEST)) events.push(event);
    }).rejects.toMatchObject({ name: "SseTransportError", phase: "incomplete" });
  });

  it("HTTP 非 2xx 抛出带端点与状态码的 http 错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([], { status: 422, ok: false })),
    );
    await expect(async () => {
      for await (const _event of openChatStream(REQUEST)) {
        void _event;
      }
    }).rejects.toBeInstanceOf(SseTransportError);
  });

  it("端点常量与后端契约一致", () => {
    expect(CHAT_STREAM_PATH).toBe("/api/chat");
    expect(CHAT_ABORT_PATH).toBe("/api/chat/abort");
  });
});

describe("工具调用事件 → UI", () => {
  it("tool_use_start / end / result 依次落到同一条工具气泡", () => {
    let state = reduceChatView(initialChatViewState, {
      type: "beginAssistant",
      id: "a1",
    });
    for (const event of [messageStart(), toolUseStart(), toolUseEnd(), toolResult(), doneEvent()]) {
      state = reduceChatView(state, { type: "event", event });
    }
    const tool = state.messages[0]?.toolCalls[0];
    expect(tool?.name).toBe("fetch__fetch");
    expect(tool?.input).toEqual({ url: "https://example.test" });
    expect(tool?.output).toBe("页面正文");
    expect(tool?.phase).toBe("done");
    expect(tool?.durationMs).toBe(12);
  });
});

describe("默认 provider 解析（GET /api/settings）", () => {
  it("优先 conversation.default_provider_id", () => {
    expect(resolveProviderDefaults(DEFAULT_SETTINGS)).toEqual({
      selectedId: "primary",
      choices: [
        { id: "primary", label: "主模型" },
        { id: "backup", label: "备用模型" },
      ],
    });
  });

  it("缺省时取 default_for=chat，绝不返回占位值", () => {
    expect(
      resolveProviderDefaults({
        conversation: { default_provider_id: "" },
        providers: [
          { id: "a", label: "A", purposes: ["chat"], default_for: [] },
          { id: "b", label: "B", purposes: ["chat"], default_for: ["chat"] },
        ],
      })?.selectedId,
    ).toBe("b");
  });

  it("providers 为空时返回 null（UI 显示明确空态）", () => {
    expect(resolveProviderDefaults({ providers: [] })).toBeNull();
    expect(resolveProviderDefaults(null)).toBeNull();
    expect(resolveProviderDefaults({})).toBeNull();
  });
});
