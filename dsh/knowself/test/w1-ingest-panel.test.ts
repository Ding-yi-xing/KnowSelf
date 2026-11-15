// @vitest-environment jsdom
/**
 * W-1 资料摄入入口的 client 侧真实渲染补测（jsdom + @testing-library/react）。
 *
 * 覆盖（a~d 为基础形态，e~j 为补测）：
 *   a) 资料面板出现「添加资料」按钮；
 *   b) 点击后展开表单与三个 tab；
 *   c) 粘贴文本提交 → createSource 收到正确的线上 DTO 且表单收起；
 *   d) 提交失败（普通 Error）→ 表单内显示可读中文错误且不收起表单；
 *   e) url tab → createSource 收到 {kind:"url",url,title}；
 *   f) file tab 的 .exe 扩展名被前端拦截，中文提示且不提交；
 *   g) file tab 的 .txt 正常路径 → base64 非空且不含 data: 前缀；
 *   h) 资料行「重新蒸馏」按钮 → runDistill 以该 source.id 被调用一次；
 *   i) SessionExpiredError → 显示「会话已失效」中文文案且表单不收起；
 *   j) createRestProfilePort 写请求形态（/write 前缀 + 四个头 + JSON body）
 *      与 GET 形态零回退（不带 /write、不显式带 method）。
 *
 * 假 port 只实现组件实际会调用的方法（两个读 + 两个写），其余用
 * `as unknown as KnowselfProfilePort` 规避完备性；不触网、不依赖宿主。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SourceStored } from "@knowself/contracts";
import {
  createRestProfilePort,
  SessionExpiredError,
  type KnowselfProfilePort,
} from "../src/client/profile-port.js";
import { SourcesPanelView } from "../src/client/sources-panel.js";

/** createSource 的可替换实现（用于制造失败分支）。 */
type CreateSourceImpl = () => Promise<unknown>;
interface PortOptions {
  createSourceImpl?: CreateSourceImpl;
  sources?: SourceStored[];
}

/**
 * 构造假 port。兼容两种入参：直接传 createSource 实现（旧用例），
 * 或传 options（新用例可指定列表数据）。
 */
function makePort(arg: CreateSourceImpl | PortOptions = {}) {
  const options: PortOptions = typeof arg === "function" ? { createSourceImpl: arg } : arg;
  const createSource = vi.fn(options.createSourceImpl ?? (async () => ({ id: "s1" })));
  const runDistill = vi.fn(async () => ({ source_id: "s1", proposal_count: 0 }));
  const listSources = vi.fn(async () => options.sources ?? []);
  const port = {
    listSources,
    listProposals: vi.fn(async () => []),
    createSource,
    runDistill,
  } as unknown as KnowselfProfilePort;
  return { port, createSource, runDistill, listSources };
}

/** 与 test/w1-ingest-route.test.ts 的 makeSource 形状一致的真实资料行。 */
function makeSource(id: string, text: string): SourceStored {
  return {
    id,
    kind: "paste",
    original_name: "测试资料",
    mime_type: "text/plain",
    file_path: null,
    url: null,
    extracted_text: text,
    truncated: false,
    char_count: text.length,
    user_note: "",
    user_tags: [],
    status: "raw",
    metadata: {},
    created_at: "2026-11-11T00:00:00.000Z",
    last_ingested_at: null,
    last_error: null,
  } as unknown as SourceStored;
}

/** 把单个 File 塞进 file input（jsdom 下 files 是只读 FileList，用 defineProperty 注入）。 */
function setFiles(input: HTMLElement, file: File): void {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  // React 18 act() 需要该标志，避免 "not configured to support act" 噪声。
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  // 还原 fetch / FileReader 等全局桩，避免用例间互相污染。
  vi.unstubAllGlobals();
});

describe("W-1 资料摄入入口（SourcesPanelView）", () => {
  it("a) 渲染资料面板 → 出现 data-testid=sources-add-button 且文案含「添加资料」", async () => {
    const { port } = makePort();
    render(createElement(SourcesPanelView, { port }));
    const button = await waitFor(() => screen.getByTestId("sources-add-button"));
    expect(button.textContent).toContain("添加资料");
  });

  it("b) 点击按钮 → 出现 sources-add-form 与三个 tab", () => {
    const { port } = makePort();
    render(createElement(SourcesPanelView, { port }));
    fireEvent.click(screen.getByTestId("sources-add-button"));
    expect(screen.getByTestId("sources-add-form")).toBeDefined();
    expect(screen.getByTestId("sources-tab-paste")).toBeDefined();
    expect(screen.getByTestId("sources-tab-url")).toBeDefined();
    expect(screen.getByTestId("sources-tab-file")).toBeDefined();
  });

  it("c) 粘贴文本提交 → createSource 收到 {kind:'paste',text} 且表单收起", async () => {
    const { port, createSource } = makePort();
    render(createElement(SourcesPanelView, { port }));
    fireEvent.click(screen.getByTestId("sources-add-button"));
    fireEvent.change(screen.getByTestId("sources-paste-text"), {
      target: { value: "一段资料文本" },
    });
    fireEvent.click(screen.getByTestId("sources-submit"));

    await waitFor(() =>
      expect(createSource).toHaveBeenCalledWith({
        kind: "paste",
        text: "一段资料文本",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("sources-add-form")).toBeNull(),
    );
  });

  it("d) 提交失败（普通 Error）→ 表单内显示可读中文错误、不吞异常且不收起表单", async () => {
    const { port } = makePort(async () => {
      throw new Error("提交被拒绝：服务端不可用");
    });
    render(createElement(SourcesPanelView, { port }));
    fireEvent.click(screen.getByTestId("sources-add-button"));
    fireEvent.change(screen.getByTestId("sources-paste-text"), {
      target: { value: "待提交文本" },
    });
    fireEvent.click(screen.getByTestId("sources-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("sources-add-error").textContent).toContain(
        "提交被拒绝：服务端不可用",
      ),
    );
    expect(screen.getByTestId("sources-add-form")).toBeDefined();
  });

  // ── 补测：三 tab 与写入口的完整行为 ──────────────────────────────────────

  it("e) url tab：填 URL + 标题提交 → createSource 收到 {kind:'url',url,title}", async () => {
    const { port, createSource } = makePort();
    render(createElement(SourcesPanelView, { port }));
    fireEvent.click(screen.getByTestId("sources-add-button"));
    fireEvent.click(screen.getByTestId("sources-tab-url"));

    const urlInput = screen.getByTestId("sources-url-input");
    expect(urlInput).toBeDefined();
    fireEvent.change(screen.getByTestId("sources-add-title"), {
      target: { value: "示例链接" },
    });
    fireEvent.change(urlInput, { target: { value: "https://example.com/a" } });
    fireEvent.click(screen.getByTestId("sources-submit"));

    await waitFor(() =>
      expect(createSource).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "url",
          url: "https://example.com/a",
          title: "示例链接",
        }),
      ),
    );
  });

  it("f) file tab：.exe 扩展名被前端拦截，显示中文提示且不调用 createSource", async () => {
    const { port, createSource } = makePort();
    render(createElement(SourcesPanelView, { port }));
    fireEvent.click(screen.getByTestId("sources-add-button"));
    fireEvent.click(screen.getByTestId("sources-tab-file"));

    const input = screen.getByTestId("sources-file-input");
    expect(input).toBeDefined();
    setFiles(input, new File(["x"], "bad.exe", { type: "application/octet-stream" }));

    // 选择文件时即拦截；再点提交也必须被拦（buildInput 二次校验）。
    // 用 waitFor 收敛异步状态更新，避免 React act 警告噪声。
    await waitFor(() =>
      expect(screen.getByTestId("sources-add-error").textContent).toContain(
        "仅支持 .txt / .md / .json 文件",
      ),
    );
    fireEvent.click(screen.getByTestId("sources-submit"));
    await waitFor(() => expect(createSource).not.toHaveBeenCalled());
  });

  it("g) file tab：.txt 正常路径 → base64 非空、含正确 mime/title 且不含 data: 前缀", async () => {
    const { port, createSource } = makePort();
    render(createElement(SourcesPanelView, { port }));
    fireEvent.click(screen.getByTestId("sources-add-button"));
    fireEvent.click(screen.getByTestId("sources-tab-file"));

    const input = screen.getByTestId("sources-file-input");
    setFiles(input, new File(["中文内容"], "note.txt", { type: "text/plain" }));
    fireEvent.click(screen.getByTestId("sources-submit"));

    await waitFor(() => expect(createSource).toHaveBeenCalledTimes(1));
    const payload = createSource.mock.calls[0]![0] as {
      kind: string;
      mime_type: string;
      title: string;
      content_base64: string;
    };
    expect(payload.kind).toBe("file");
    expect(payload.mime_type).toBe("text/plain");
    expect(payload.title).toBe("note.txt");
    expect(typeof payload.content_base64).toBe("string");
    expect(payload.content_base64.length).toBeGreaterThan(0);
    expect(payload.content_base64.startsWith("data:")).toBe(false);
  });

  it("h) 资料行「重新蒸馏」按钮 → runDistill 以该 source.id 被调用一次", async () => {
    const source = makeSource("s-001", "一条资料");
    const { port, runDistill } = makePort({ sources: [source] });
    render(createElement(SourcesPanelView, { port }));

    const button = await waitFor(() => screen.getByTestId("sources-redistill"));
    fireEvent.click(button);
    await waitFor(() => expect(runDistill).toHaveBeenCalledWith("s-001"));
    expect(runDistill).toHaveBeenCalledTimes(1);
  });

  it("i) SessionExpiredError → 显示「会话已失效」中文文案且表单不收起", async () => {
    const { port } = makePort(async () => {
      throw new SessionExpiredError();
    });
    render(createElement(SourcesPanelView, { port }));
    fireEvent.click(screen.getByTestId("sources-add-button"));
    fireEvent.change(screen.getByTestId("sources-paste-text"), {
      target: { value: "待提交文本" },
    });
    fireEvent.click(screen.getByTestId("sources-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("sources-add-error").textContent).toContain(
        "会话已失效，请重新打开 dsh web",
      ),
    );
    expect(screen.getByTestId("sources-add-form")).toBeDefined();
  });

  it("j) createRestProfilePort 写请求形态 + GET 形态零回退", async () => {
    // 打一个最小 fetch 桩：只记录调用参数并返回 2xx JSON。
    const fetchStub = vi.fn(async (_url: string, _init?: unknown) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ source_id: "s1", proposal_count: 0 }),
      }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchStub);
    const port = createRestProfilePort();

    // ① 写：URL / 方法 / 四个头 / 合法 JSON body
    await port.createSource({ kind: "paste", text: "中文" });
    const [writeUrl, writeInit] = fetchStub.mock.calls[0]! as [string, RequestInit];
    expect(writeUrl).toBe("/knowself-api/write/sources");
    expect(writeInit.method).toBe("POST");
    const headers = writeInit.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["accept"]).toBe("application/json");
    expect(headers["x-knowself-write"]).toBe("1");
    expect(typeof headers["x-knowself-idempotency-key"]).toBe("string");
    expect((headers["x-knowself-idempotency-key"] ?? "").length).toBeGreaterThan(0);
    const parsedBody: unknown = JSON.parse(String(writeInit.body));
    expect(parsedBody).toMatchObject({ kind: "paste", text: "中文" });

    // ② 重新蒸馏同样走 /write 前缀，且路径带 encodeURIComponent 的 id
    await port.runDistill("abc");
    expect(fetchStub.mock.calls[1]![0]).toBe(
      "/knowself-api/write/sources/abc/distill",
    );

    // ③ GET 零回退：不带 /write、不显式带 method
    await port.listSources();
    const [getUrl, getInit] = fetchStub.mock.calls[2]! as [string, RequestInit];
    expect(getUrl).toBe("/knowself-api/sources");
    expect(getUrl).not.toContain("/write");
    expect(getInit.method).toBeUndefined();
  });
});
