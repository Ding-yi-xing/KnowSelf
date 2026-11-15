// @vitest-environment jsdom
/**
 * W-35-B：「聊天数据源」卡片的行为测试。
 *
 * 五个关键点（对应工单验收项）：
 *   ① 挂载即渲染目录默认值与三条统计；
 *   ② 点「立即更新」→ 端口收到幂等导入入参（含 `auto_commit: true` 与可回溯的 reason）；
 *   ③ 成功 → 展示本次的 解析 / 新写入 / 忽略，并**重读**统计；
 *   ④ 失败 → 原样显示错误（不是"更新失败"四个字）；
 *   ⑤ 目录为空 → 按钮 disabled 且**一个请求都不发**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatSourceCard, DEFAULT_CHAT_SOURCE_DIR } from "../src/client/chat-source-card.js";
import type { ChatImportPort, ChatImportResult } from "../src/client/chat-import-port.js";
import type { MiningStatus } from "../src/client/mining-port.js";

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // 卡片会把目录写进 localStorage；用例之间必须清干净，否则默认值断言会串
  try {
    localStorage.clear();
  } catch {
    /* jsdom 之外没有 localStorage，忽略 */
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 挖掘状态夹具（真实量级：151,886 条 / 285 会话 / 1,071 人）。 */
function status(over: Partial<MiningStatus> = {}): MiningStatus {
  return {
    has_snapshot: true,
    snapshot_id: "snap-1",
    node_count: 1206,
    edge_count: 10000,
    chat_message_count: 151886,
    chat_conversation_count: 285,
    person_count: 1071,
    ...over,
  };
}

/** 导入回包夹具（幂等重跑：全部 ignored）。 */
function result(over: Partial<ChatImportResult> = {}): ChatImportResult {
  return {
    source_id: "src-1",
    batch_id: "b1",
    conversations: 285,
    messages: { parsed: 151886, committed: 0, ignored: 151886, unattributed: 0 },
    persons_created: 0,
    auto_committed: 151886,
    snapshot_id: null,
    nodes: null,
    edges: null,
    ...over,
  };
}

/**
 * 造端口桩。
 * @param statuses 依次返回的挖掘状态（第 n 次调用取第 n 个，用尽后复用最后一个）
 */
function makePorts(statuses: MiningStatus[] = [status()]) {
  let index = 0;
  const getStatus = vi.fn(async () => {
    const picked = statuses[Math.min(index, statuses.length - 1)] ?? status();
    index += 1;
    return picked;
  });
  const importChat = vi.fn(async () => result());
  const mining = { getStatus };
  const chatImport = { importChat } as unknown as ChatImportPort;
  return { mining, chatImport, getStatus, importChat };
}

/**
 * 等到「统计已落地」，把首次 `getStatus` 的 setState 收进 act。
 *
 * 不这么做的话，那些"点一下就走"的用例会在挂载时的异步 setState 上打出
 * `not wrapped in act(...)` 噪声（断言本身不受影响，但输出会脏）。
 *
 * @param expected 期望在统计里出现的片段
 */
async function awaitStats(expected = "151,886 条"): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("chat-source-stats").textContent).toContain(expected),
  );
}

describe("聊天数据源卡片（W-35-B）", () => {
  it("① 初始渲染：目录默认值 + 消息/会话/人三条统计", async () => {
    const { mining, chatImport } = makePorts();
    render(createElement(ChatSourceCard, { mining, chatImport }));

    const dir = screen.getByTestId("chat-source-dir") as HTMLInputElement;
    expect(dir.value).toBe(DEFAULT_CHAT_SOURCE_DIR);

    await waitFor(() =>
      expect(screen.getByTestId("chat-source-stats").textContent).toContain("151,886 条"),
    );
    const stats = screen.getByTestId("chat-source-stats").textContent ?? "";
    expect(stats).toContain("285 会话");
    expect(stats).toContain("1,071 人");
  });

  it("② 点「立即更新」→ 端口收到幂等导入入参（source_path + auto_commit）", async () => {
    const { mining, chatImport, importChat } = makePorts();
    render(createElement(ChatSourceCard, { mining, chatImport }));
    await awaitStats();

    fireEvent.click(screen.getByTestId("chat-source-refresh"));
    await waitFor(() => expect(importChat).toHaveBeenCalledTimes(1));

    expect(importChat.mock.calls[0]![0]).toEqual({
      source_path: DEFAULT_CHAT_SOURCE_DIR,
      auto_commit: true,
      auto_commit_reason: "manual-refresh",
    });
  });

  it("③ 成功 → 展示 解析/新写入/忽略，并重读统计", async () => {
    // 第一次读到旧统计（0 条），导入后第二次读到新统计
    const { mining, chatImport, getStatus } = makePorts([
      status({ chat_message_count: 0, chat_conversation_count: 0, person_count: 0 }),
      status(),
    ]);
    render(createElement(ChatSourceCard, { mining, chatImport }));

    await waitFor(() =>
      expect(screen.getByTestId("chat-source-stats").textContent).toContain("0 条"),
    );

    fireEvent.click(screen.getByTestId("chat-source-refresh"));

    const line = await waitFor(() => screen.getByTestId("chat-source-result"));
    expect(line.textContent).toContain("解析 151,886");
    expect(line.textContent).toContain("新写入 0");
    expect(line.textContent).toContain("忽略 151,886");
    // 统计已刷新（重读了一次 /mining/status）
    await waitFor(() =>
      expect(screen.getByTestId("chat-source-stats").textContent).toContain("151,886 条"),
    );
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("④ 失败 → chat-source-error 显示**原始**错误文案", async () => {
    const { mining, chatImport, importChat } = makePorts();
    const raw = "POST /knowself-api/write/chat-import → 500（mining_failed）";
    importChat.mockRejectedValueOnce(new Error(raw));
    render(createElement(ChatSourceCard, { mining, chatImport }));
    await awaitStats();

    fireEvent.click(screen.getByTestId("chat-source-refresh"));

    const err = await waitFor(() => screen.getByTestId("chat-source-error"));
    expect(err.textContent).toBe(raw);
    // 失败时不该假装成功
    expect(screen.queryByTestId("chat-source-result")).toBeNull();
  });

  it("⑤ 目录为空 → 按钮 disabled、提示可见，且**不发请求**", async () => {
    const { mining, chatImport, importChat } = makePorts();
    render(createElement(ChatSourceCard, { mining, chatImport }));
    await awaitStats();

    fireEvent.change(screen.getByTestId("chat-source-dir"), { target: { value: "   " } });

    const button = screen.getByTestId("chat-source-refresh") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("请填入微信导出目录")).toBeDefined();

    fireEvent.click(button);
    expect(importChat).not.toHaveBeenCalled();
  });
});
