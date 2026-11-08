// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App";
import {
  ChatCommandContext,
  NOOP_CHAT_COMMANDS,
  useChatCommands,
  type ChatCommandState,
} from "../src/features/chat/ChatCommandContext";
import { makeFetch } from "./chatFixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubShell(pathname: string): void {
  window.history.pushState(null, "", pathname);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })),
  );
  const { impl } = makeFetch();
  vi.stubGlobal("fetch", impl);
}

function TokenProbe() {
  const commands = useChatCommands();
  return <span data-testid="token">{commands.newConversationToken}</span>;
}

describe("新建会话命令 contract", () => {
  it("无 Provider 时返回明确的 no-op 默认值", () => {
    render(<TokenProbe />);
    expect(screen.getByTestId("token").textContent).toBe("0");
    expect(NOOP_CHAT_COMMANDS.newConversationToken).toBe(0);
  });

  it("request 递增 token、consume 归零，可被 ChatPage 消费一次", () => {
    function Harness() {
      const [token, setToken] = useState(0);
      const state: ChatCommandState = {
        newConversationToken: token,
        requestNewConversation: () => setToken((value) => value + 1),
        consumeNewConversation: () => setToken(0),
      };
      return (
        <ChatCommandContext.Provider value={state}>
          <button type="button" onClick={state.requestNewConversation}>
            请求
          </button>
          <button type="button" onClick={state.consumeNewConversation}>
            消费
          </button>
          <TokenProbe />
        </ChatCommandContext.Provider>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("token").textContent).toBe("0");
    fireEvent.click(screen.getByText("请求"));
    expect(screen.getByTestId("token").textContent).toBe("1");
    fireEvent.click(screen.getByText("消费"));
    expect(screen.getByTestId("token").textContent).toBe("0");
  });
});

describe("Ctrl/⌘+N 全局快捷键", () => {
  it("在对话页按 Ctrl+N 会新建会话（清空已有消息、回到空态）", async () => {
    stubShell("/");
    render(<App />);

    await waitFor(() => {
      expect((screen.getByLabelText("对话模型") as HTMLSelectElement).value).toBe("primary");
    });
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "先聊一句" },
    });
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), {
      key: "Enter",
      shiftKey: false,
    });
    await waitFor(() => expect(screen.getByText("你好，世界")).toBeDefined());

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });

    await waitFor(() => expect(screen.queryByText("你好，世界")).toBeNull());
    expect(screen.getByText("开始一段新对话")).toBeDefined();
    expect(window.location.pathname).toBe("/");
  });

  it("从其它页按 Ctrl+N 会回到对话页（URL 契约保持）", async () => {
    stubShell("/inbox");
    render(<App />);
    await waitFor(() => expect(screen.getByText("暂无待整理内容")).toBeDefined());

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    expect(window.location.pathname).toBe("/");
    await waitFor(() => expect(screen.getByText("开始一段新对话")).toBeDefined());
  });
});
