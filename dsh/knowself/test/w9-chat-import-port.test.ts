/**
 * W-9：`chat-import-port` 与路径校验测试（纯函数 + fetch 桩，不触网）。
 *
 * 校验的重点是 `validateLocalPath`：这是最容易误解的地方——输入框看起来像能填 URL，
 * 但 reader 读的是文件系统，填 URL 只会白跑一趟请求。前端必须先拦。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatImportPort, validateLocalPath } from "../src/client/chat-import-port.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateLocalPath（仅支持本地目录）", () => {
  it("http:// 与 https:// 一律拦下并给出可执行提示", () => {
    expect(validateLocalPath("http://example.com/export")).toContain("仅支持本地目录");
    expect(validateLocalPath("https://example.com/export")).toContain("仅支持本地目录");
  });

  it("Windows 本地路径通过", () => {
    expect(validateLocalPath("C:\\dsh-lab\\tmp\\w9-fixture")).toBeNull();
    expect(validateLocalPath("D:/data/export")).toBeNull();
  });

  it("空输入 → 提示填写", () => {
    expect(validateLocalPath("   ")).toBe("请填写本地目录路径");
  });
});

describe("createChatImportPort", () => {
  it("importChat 走写通道：URL、方法、x-knowself-write 头都对", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ source_id: "s1", messages: { parsed: 40, committed: 0, ignored: 0, unattributed: 0 }, auto_committed: 0 }),
      };
    });

    const port = createChatImportPort();
    const result = await port.importChat({ source_path: "C:\\tmp\\a" });

    expect(calls[0]!.url).toBe("/knowself-api/write/chat-import");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["x-knowself-write"]).toBe("1");
    expect(result.source_id).toBe("s1");
  });

  it("非 2xx 抛错（不静默当成成功）", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 400, json: async () => ({}) }));
    const port = createChatImportPort();
    await expect(port.importChat({ source_path: "C:\\tmp\\a" })).rejects.toThrow("HTTP 400");
  });

  it("acceptBatch 用 source_id 调批量采纳端点", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ accepted: 40, failed: 0, failed_ids: [] }) };
    });

    const port = createChatImportPort();
    const result = await port.acceptBatch("src-1");

    expect(calls[0]!.url).toBe("/knowself-api/write/proposals-accept-batch");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ source_id: "src-1" });
    expect(result.accepted).toBe(40);
  });
});
