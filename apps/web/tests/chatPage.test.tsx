// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatRequest } from "@knowself/contracts";
import { ChatPage } from "../src/features/chat/ChatPage";
import {
  CONV_ID,
  DEFAULT_CHAT_CHUNKS,
  errorEvent,
  makeConversation,
  makeFetch,
  makeHistoryMessage,
  messageStart,
  sseFrame,
  textDelta,
} from "./chatFixtures";

beforeEach(() => {
  window.history.pushState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(options: Parameters<typeof makeFetch>[0] = {}) {
  const { impl, calls } = makeFetch(options);
  vi.stubGlobal("fetch", impl);
  return calls;
}

async function waitForProvider(value = "primary"): Promise<void> {
  await waitFor(() => {
    expect((screen.getByLabelText("对话模型") as HTMLSelectElement).value).toBe(value);
  });
}

describe("ChatPage 会话列表", () => {
  it("挂载拉取列表并渲染空态", async () => {
    const calls = stubFetch({ conversations: [] });
    render(<ChatPage />);

    await waitFor(() => expect(screen.getByText("暂无历史会话")).toBeDefined());
    expect(screen.getByText("开始一段新对话")).toBeDefined();
    expect(
      calls.some(
        (call) =>
          call.url === "/api/conversations?limit=50&offset=0" &&
          (call.init.method ?? "GET") === "GET",
      ),
    ).toBe(true);
  });

  it("列表加载失败时错误可见，不静默", async () => {
    stubFetch({ conversationsFail: true });
    render(<ChatPage />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("会话列表加载失败");
    });
  });

  it("点击会话读取历史并渲染消息气泡", async () => {
    const conversation = makeConversation({ title: "第一次对话" });
    const calls = stubFetch({
      conversations: [conversation],
      history: {
        [CONV_ID]: {
          conversation,
          messages: [
            makeHistoryMessage("历史消息内容", "user"),
            makeHistoryMessage("历史回答内容", "assistant"),
          ],
        },
      },
    });
    render(<ChatPage />);

    await waitFor(() => expect(screen.getByText("第一次对话")).toBeDefined());
    fireEvent.click(screen.getByText("第一次对话"));

    await waitFor(() =>
      expect(calls.some((call) => call.url === `/api/conversations/${CONV_ID}`)).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("历史消息内容")).toBeDefined());
    expect(screen.getByText("历史回答内容")).toBeDefined();
  });

  it("重命名走 PATCH、删除走 DELETE", async () => {
    const calls = stubFetch({ conversations: [makeConversation()] });
    render(<ChatPage />);

    await waitFor(() => expect(screen.getByText("第一次对话")).toBeDefined());
    fireEvent.click(screen.getByLabelText("重命名 第一次对话"));
    fireEvent.change(screen.getByLabelText("会话标题"), {
      target: { value: "改名后" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === `/api/conversations/${CONV_ID}` &&
            call.init.method === "PATCH" &&
            (JSON.parse(String(call.init.body)) as { title: string }).title === "改名后",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("改名后")).toBeDefined());

    fireEvent.click(screen.getByLabelText("删除 改名后"));
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === `/api/conversations/${CONV_ID}` &&
            call.init.method === "DELETE",
        ),
      ).toBe(true),
    );
  });
});

describe("ChatPage 发送与中止", () => {
  it("Enter 发送 → POST /api/chat（ChatRequestSchema 全字段）→ 流式文本逐块渲染", async () => {
    const calls = stubFetch({ chatChunks: DEFAULT_CHAT_CHUNKS });
    render(<ChatPage />);
    await waitForProvider();

    const input = screen.getByLabelText("消息输入框");
    fireEvent.change(input, { target: { value: "讲个故事" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/chat")).toBe(true),
    );
    const call = calls.find((entry) => entry.url === "/api/chat");
    expect(call?.init.method).toBe("POST");
    const body = JSON.parse(String(call?.init.body)) as ChatRequest;
    expect(body.user_message).toBe("讲个故事");
    expect(body.provider_id).toBe("primary");
    expect(body.stream).toBe(true);
    expect(body.tools_enabled).toBe(true);
    expect(body.write_back).toBe(true);
    expect(body.conversation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await waitFor(() => expect(screen.getByText("你好，世界")).toBeDefined());
    expect(screen.getByText("发送")).toBeDefined();
  });

  it("Shift+Enter 不发送", async () => {
    const calls = stubFetch();
    render(<ChatPage />);
    await waitForProvider();

    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "换行" },
    });
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(calls.some((call) => call.url === "/api/chat")).toBe(false);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("换行");
  });

  it("发送中点击中止 → POST /api/chat/abort，body 带 conversation_id", async () => {
    const calls = stubFetch({
      holdOpen: true,
      chatChunks: [sseFrame(messageStart()), sseFrame(textDelta("正在"))],
    });
    render(<ChatPage />);
    await waitForProvider();

    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "继续" },
    });
    fireEvent.click(screen.getByText("发送"));

    await waitFor(() => expect(screen.getByText("中止")).toBeDefined());
    fireEvent.click(screen.getByText("中止"));

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/chat/abort")).toBe(true),
    );
    const abortCall = calls.find((call) => call.url === "/api/chat/abort");
    expect(abortCall?.init.method).toBe("POST");
    expect(JSON.parse(String(abortCall?.init.body))).toEqual({
      conversation_id: expect.any(String),
    });
  });

  it("SSE error 事件在页面上可见", async () => {
    stubFetch({ chatChunks: [sseFrame(errorEvent("模型不可用"))] });
    render(<ChatPage />);
    await waitForProvider();

    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "触发错误" },
    });
    fireEvent.click(screen.getByText("发送"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("模型不可用"),
    );
  });
});

describe("ChatPage provider 空态", () => {
  it("无可用 provider 时显示明确提示、停用发送、不发假请求", async () => {
    const calls = stubFetch({
      settings: { conversation: { default_provider_id: "" }, providers: [] },
    });
    render(<ChatPage />);

    await waitFor(() =>
      expect(screen.getByText(/尚未配置可用的对话模型/)).toBeDefined(),
    );
    expect((screen.getByText("发送") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "不该发出去" },
    });
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), {
      key: "Enter",
      shiftKey: false,
    });
    expect(calls.some((call) => call.url === "/api/chat")).toBe(false);
  });
});
