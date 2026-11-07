/**
 * components-message-list.test.tsx — MessageList 组件渲染测试。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { useChatStore } from "../src/stores/chat";
import { MessageList } from "../src/components/MessageList";
import { I18nProvider } from "../src/lib/i18n";

// Mock markdown to avoid HTML parsing issues
vi.mock("../src/lib/markdown", () => ({
  renderMarkdown: (text: string) => `<p>${text}</p>`,
}));

function renderWithI18n(ui: React.ReactElement) {
  return render(React.createElement(I18nProvider, { locale: "zh-CN" }, ui));
}

describe("MessageList", () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
  });

  it("无消息时显示空状态提示", () => {
    renderWithI18n(React.createElement(MessageList));
    expect(screen.getByText("开始一段对话")).toBeTruthy();
  });

  it("有消息时渲染消息气泡", () => {
    useChatStore.setState({
      messages: [
        {
          id: "msg-1",
          conversation_id: "conv-1",
          role: "user",
          content: [{ kind: "text", text: "你好" }],
          created_at: new Date().toISOString(),
          provider_id: null,
          model: null,
        },
        {
          id: "msg-2",
          conversation_id: "conv-1",
          role: "assistant",
          content: [{ kind: "text", text: "你好！有什么可以帮助你的？" }],
          created_at: new Date().toISOString(),
          provider_id: "test-provider",
          model: "test-model",
        },
      ],
    });

    renderWithI18n(React.createElement(MessageList));
    expect(screen.getAllByText(/你好/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("你好！有什么可以帮助你的？")).toBeTruthy();
  });

  it("流式消息保持可见", () => {
    const msgId = "msg-streaming";
    useChatStore.setState({
      messages: [
        {
          id: msgId,
          conversation_id: "conv-1",
          role: "assistant",
          content: [{ kind: "text", text: "thinking..." }],
          created_at: new Date().toISOString(),
          provider_id: null,
          model: null,
        },
      ],
      streamingMessageId: msgId,
    });

    renderWithI18n(React.createElement(MessageList));
    expect(screen.getByText("thinking...")).toBeTruthy();
  });
});
