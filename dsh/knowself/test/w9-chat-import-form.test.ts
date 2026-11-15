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
import { CHAT_IMPORT_PLATFORMS } from "../src/client/chat-import-port.js";
import type { ChatImportPort } from "../src/client/chat-import-port.js";
// 契约的**真实值域**：从源码引入，而不是 `import … from "@knowself/contracts"`。
// 原因：包入口指向 `dist/*`，而本轮不重建 contracts（实测 `dist.ChatPlatformSchema === undefined`），
// 走包入口会拿到 undefined、断言直接 TypeError。源码引入能让防漂移断言在 dist 更新前就生效。
import { ChatPlatformSchema } from "../../../packages/contracts/src/chat.js";

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

  it("auto_commit=false → 回执「等待确认」+【全部采纳本批】", async () => {
    const port = chatPort();
    const { input } = renderChat(port);

    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture" } });
    fireEvent.click(screen.getByTestId("sources-submit"));

    const receipt = await screen.findByTestId("sources-chat-receipt");
    expect(receipt.textContent).toContain("已导入 40 条，等待确认");
    expect(screen.getByTestId("sources-chat-accept-batch")).toBeDefined();
    // 传的参数里没有 auto_commit；W-34-T02 起请求体固定带 platform（默认 wechat）
    expect((port.importChat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toEqual({
      source_path: "C:\\dsh-lab\\tmp\\w9-fixture",
      platform: "wechat",
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
 * W-34-T02：来源平台三选一（微信可用 / QQ·抖音占位）。
 *
 * 为什么 QQ/抖音 用 `aria-disabled` 而不是原生 `disabled`：
 * 需求同时要求「(a) 按钮处于禁用语义」和「(b) 选中 QQ 后提交不发请求」。
 * 原生 disabled 的按钮在浏览器与 jsdom 里**连 click 事件都不派发**（实测 onClick 调用 0 次），
 * 于是 (b) 永远不可达、只能写个空断言。用 aria-disabled 保住对辅助技术的禁用语义，
 * 同时让「点了会选中 → 提交置灰 → 不发请求」这条真实链路可被测到。
 */
describe("聊天导入平台三选一（W-34-T02）", () => {
  /**
   * **防漂移**：客户端那份平台清单是 contracts 的镜像（因为本轮不重建 contracts/dist）。
   * 两份真相源迟早会漂——契约加一个平台、镜像忘改，用户会在 UI 上看到一个"选不了"的平台，
   * 或者服务端闸放行一个 UI 根本没有的取值。这条断言把两者钉死（含**顺序**）。
   */
  it("本地平台镜像与 contracts 的 ChatPlatformSchema 值域一致（防漂移）", () => {
    expect([...CHAT_IMPORT_PLATFORMS]).toEqual([...ChatPlatformSchema.options]);
  });

  it("三个平台 pill 都在；微信默认选中；QQ/抖音 aria-disabled 且无承诺式文案", () => {
    renderChat(chatPort());

    const wechat = screen.getByTestId("sources-chat-platform-wechat");
    const qq = screen.getByTestId("sources-chat-platform-qq");
    const douyin = screen.getByTestId("sources-chat-platform-douyin");
    expect(wechat).toBeDefined();
    expect(qq).toBeDefined();
    expect(douyin).toBeDefined();

    // 微信默认选中
    expect(wechat.getAttribute("aria-pressed")).toBe("true");
    expect(qq.getAttribute("aria-pressed")).toBe("false");
    expect(douyin.getAttribute("aria-pressed")).toBe("false");

    // QQ / 抖音：禁用语义 + 「暂未开放」
    expect(qq.getAttribute("aria-disabled")).toBe("true");
    expect(douyin.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/暂未开放/)).toBeDefined();

    // 禁止承诺式文案（已定：那是承诺，用户会来催）
    expect(screen.queryByText(/即将支持/)).toBeNull();
    expect(screen.queryByText(/敬请期待/)).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it("选 QQ → 提交按钮置灰，且**不发任何请求**", () => {
    const port = chatPort();
    const { input } = renderChat(port);
    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture" } });

    fireEvent.click(screen.getByTestId("sources-chat-platform-qq"));
    expect(screen.getByTestId("sources-chat-platform-qq").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("sources-chat-platform-wechat").getAttribute("aria-pressed")).toBe("false");

    const submit = screen.getByTestId("sources-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(submit);
    expect(port.importChat).not.toHaveBeenCalled();
  });

  it("切回微信 → 提交恢复可用，并真的发出 platform=wechat 的请求", async () => {
    const port = chatPort();
    const { input } = renderChat(port);
    fireEvent.change(input, { target: { value: "C:\\dsh-lab\\tmp\\w9-fixture" } });

    fireEvent.click(screen.getByTestId("sources-chat-platform-qq"));
    fireEvent.click(screen.getByTestId("sources-chat-platform-wechat"));
    expect((screen.getByTestId("sources-submit") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("sources-submit"));
    await waitFor(() => expect(port.importChat).toHaveBeenCalledTimes(1));
    expect((port.importChat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toEqual({
      source_path: "C:\\dsh-lab\\tmp\\w9-fixture",
      platform: "wechat",
    });
  });
});
