// @vitest-environment jsdom
/**
 * W-9 B：「导入聊天记录」tab 的行为测试。
 *
 * 三个关键点：
 *   ① `http://` 在前端就被拦下（不发请求）——reader 读的是文件系统，填 URL 只会白跑；
 *   ② `auto_commit=false` 的回执是「等待确认」+ 可批量采纳（不是假装成功）；
 *   ③ 批量采纳成功后触发 `onMiningRefresh`（显式回调，不靠切面板的隐式时序）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SourcesAddForm } from "../src/client/sources-add-form.js";
import { WechatKeyRequiredError } from "../src/client/chat-import-port.js";
import type { ChatImportPort } from "../src/client/chat-import-port.js";

afterEach(() => {
  cleanup();
});

/** 资料端口桩（本文件不关心资料创建）。 */
const profilePort = { createSource: vi.fn(async () => ({})) } as never;

/** 聊天导入端口桩。 */
function chatPort(overrides: Partial<ChatImportPort> = {}): ChatImportPort {
  return {
    importChat: vi.fn(async () => ({
      source_id: "src-1",
      batch_id: "b1",
      conversations: 1,
      messages: { parsed: 40, committed: 0, ignored: 0, unattributed: 0 },
      persons_created: 3,
      auto_committed: 0,
      snapshot_id: null,
      nodes: null,
      edges: null,
    })),
    acceptBatch: vi.fn(async () => ({ accepted: 40, failed: 0, failed_ids: [] })),
    ...overrides,
  } as ChatImportPort;
}

/** 渲染并切到 chat tab。 */
function renderChat(port: ChatImportPort, extra: Record<string, unknown> = {}) {
  render(
    createElement(SourcesAddForm, {
      port: profilePort,
      onDone: vi.fn(),
      onCancel: vi.fn(),
      chatImport: port,
      ...extra,
    }),
  );
  fireEvent.click(screen.getByTestId("sources-tab-chat"));
  return { input: screen.getByTestId("sources-chat-path") };
}

describe("导入聊天记录 tab（W-9 B）", () => {
  it("填 http:// → 前端拦下并提示「仅支持本地目录」，且**不发请求**", async () => {
    const port = chatPort();
    const { input } = renderChat(port);

    fireEvent.change(input, { target: { value: "http://example.com/export" } });
    // 即时校验：输入时就能看到提示
    await waitFor(() =>
      expect(screen.getByTestId("sources-add-error").textContent).toContain("仅支持本地目录"),
    );

    fireEvent.click(screen.getByTestId("sources-submit"));
    expect(port.importChat).not.toHaveBeenCalled();
  });

  it("没有新增 proposal 时回执说明「已是最新」，不显示『全部采纳本批』", async () => {
    const port = chatPort({
      importChat: vi.fn(async () => ({
        source_id: "src-none",
        batch_id: "b-none",
        conversations: 1,
        messages: { parsed: 100, committed: 0, ignored: 100, unattributed: 0 },
        persons_created: 0,
        auto_committed: 0,
        proposals_created: 0,
        wechat: { db_dir: "C:\\x", key_source: "reused", summary: { newest_message_at: "2026-07-22T19:56:00.000Z" } },
        snapshot_id: null,
        nodes: null,
        edges: null,
      })),
    } as never);
    const { input } = renderChat(port);
    fireEvent.change(input, { target: { value: "C:\\Data\\xwechat_files" } });
    fireEvent.click(screen.getByTestId("sources-submit"));
    const receipt = await screen.findByTestId("sources-chat-receipt");
    expect(receipt.textContent).toContain("没有新增消息");
    expect(screen.queryByTestId("sources-chat-accept-batch")).toBeNull();
  });

  it("auto_commit=false → 回执「等待确认」+【全部采纳本批】", async () => {
    const port = chatPort();
    const { input } = renderChat(port);

    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture" } });
    fireEvent.click(screen.getByTestId("sources-submit"));

    const receipt = await screen.findByTestId("sources-chat-receipt");
    expect(receipt.textContent).toContain("已导入 40 条，等待确认");
    expect(screen.getByTestId("sources-chat-accept-batch")).toBeDefined();
    // 传的参数里没有 auto_commit；请求体用 wechat_root（解密/导出由服务端完成）
    expect((port.importChat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toEqual({
      wechat_root: "C:\\dsh-lab\\tmp\\w9-fixture",
    });
  });

  it("auto_commit=true 必须填理由；填了则回执「已导入并自动采纳 N 条」并触发刷新", async () => {
    const onMiningRefresh = vi.fn();
    const port = chatPort({
      importChat: vi.fn(async () => ({
        source_id: "src-2",
        batch_id: "b2",
        conversations: 1,
        messages: { parsed: 80, committed: 80, ignored: 0, unattributed: 0 },
        persons_created: 3,
        auto_committed: 80,
        snapshot_id: "s1",
        nodes: 4,
        edges: 6,
      })),
    } as never);
    const { input } = renderChat(port, { onMiningRefresh });

    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture-b" } });
    fireEvent.click(screen.getByTestId("sources-chat-auto-commit"));

    // 勾了自动采纳但没填理由 → 前端就拦（不把 400 留给服务端）
    fireEvent.click(screen.getByTestId("sources-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("sources-add-error").textContent).toContain("必须填写理由"),
    );
    expect(port.importChat).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("sources-chat-auto-reason"), {
      target: { value: "w9-acceptance" },
    });
    fireEvent.click(screen.getByTestId("sources-submit"));

    const receipt = await screen.findByTestId("sources-chat-receipt");
    expect(receipt.textContent).toContain("已导入并自动采纳 80 条");
    expect(onMiningRefresh).toHaveBeenCalled();
    // 自动采纳过 → 不再显示「全部采纳本批」
    expect(screen.queryByTestId("sources-chat-accept-batch")).toBeNull();
  });

  it("【全部采纳本批】用回包的 source_id 调端点，成功后回执变「已采纳 N 条，正在生成关系图…」", async () => {
    const onMiningRefresh = vi.fn();
    const port = chatPort();
    const { input } = renderChat(port, { onMiningRefresh });

    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture" } });
    fireEvent.click(screen.getByTestId("sources-submit"));
    await screen.findByTestId("sources-chat-receipt");

    fireEvent.click(screen.getByTestId("sources-chat-accept-batch"));

    await waitFor(() =>
      expect(screen.getByTestId("sources-chat-accept-result").textContent).toContain(
        "已采纳 40 条，正在生成关系图…",
      ),
    );
    expect(port.acceptBatch).toHaveBeenCalledWith("src-1");
    expect(onMiningRefresh).toHaveBeenCalled();
  });

  /**
   * `messages.unattributed > 0` 必须**如实显示**：这 N 条不会进关系分析。
   * 之前客户端类型还写着 `inserted`（服务端早已改成 parsed/committed），
   * 真机上会显示「已导入 undefined 条」——这里一并锁住。
   */
  it("unattributed > 0 → 回执多一行「其中 N 条无法识别发送者，未参与关系分析」", async () => {
    const port = chatPort({
      importChat: vi.fn(async () => ({
        source_id: "src-3",
        batch_id: "b3",
        conversations: 1,
        messages: { parsed: 20, committed: 20, ignored: 0, unattributed: 6 },
        persons_created: 1,
        auto_committed: 0,
        snapshot_id: null,
        nodes: null,
        edges: null,
      })),
    } as never);
    const { input } = renderChat(port);

    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture" } });
    fireEvent.click(screen.getByTestId("sources-submit"));

    const line = await screen.findByTestId("sources-chat-unattributed");
    expect(line.textContent).toContain("其中 6 条无法识别发送者，未参与关系分析");
  });

  it("unattributed = 0 → 不显示该行（也别显示 undefined）", async () => {
    const port = chatPort();
    const { input } = renderChat(port);

    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture" } });
    fireEvent.click(screen.getByTestId("sources-submit"));

    await screen.findByTestId("sources-chat-receipt");
    expect(screen.queryByTestId("sources-chat-unattributed")).toBeNull();
    // 回归：回执正文用的是真实字段（parsed），不是 undefined
    expect(screen.getByTestId("sources-chat-receipt").textContent).toContain("已导入 40 条，等待确认");
  });
});

/**
 * 2026-11-16：只保留微信一个来源；不再有 QQ/抖音 平台 pill。
 *
 * 2026-11-17：密钥改为从**运行中的微信进程**只读提取，前端不再有「重启微信抓密钥」
 * 二次确认（那条路在微信 4.2 上抓不到密钥，表现为「重启完微信后一直没反应」）。
 * 409 时把服务端的中文原因直接显示出来，且不自动重试。
 */
describe("微信导入：单一来源与密钥错误提示", () => {
  it("不再显示平台 pill，输入框说明指向 xwechat_files", () => {
    renderChat(chatPort());

    expect(screen.queryByTestId("sources-chat-platform-qq")).toBeNull();
    expect(screen.queryByTestId("sources-chat-platform-douyin")).toBeNull();
    expect(screen.getAllByText(/xwechat_files/).length).toBeGreaterThan(0);
  });

  it("缺密钥（409）→ 直接显示可操作错误，不弹重启对话框、不重试", async () => {
    const importChat = vi
      .fn()
      .mockRejectedValueOnce(new WechatKeyRequiredError("请先登录微信并保持窗口打开"));
    const port = chatPort({ importChat } as never);
    const { input } = renderChat(port);

    fireEvent.change(input, { target: { value: "C:\\Data\\xwechat_files" } });
    fireEvent.click(screen.getByTestId("sources-submit"));

    const alert = await screen.findByTestId("sources-add-error");
    expect(alert.textContent).toContain("请先登录微信");
    expect(screen.queryByTestId("wechat-key-capture-dialog")).toBeNull();
    // 不再带 capture_key 重试：只发一次请求，且请求体里没有该字段
    expect(importChat).toHaveBeenCalledTimes(1);
    expect(importChat.mock.calls[0]![0]).toEqual({ wechat_root: "C:\\Data\\xwechat_files" });
  });
});
