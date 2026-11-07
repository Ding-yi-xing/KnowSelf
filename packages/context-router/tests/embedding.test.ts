/**
 * embedding.test.ts — 嵌入管线单元测试（V3：Ollama HTTP）
 *
 * 用注入的 fetch 桩替代真实 Ollama，禁止发网络请求。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbedModelLoadFailedError } from "../src/errors";
import { loadEmbeddingPipeline, __resetEmbeddingPipelineForTests } from "../src/embedding";

const BASE = "http://127.0.0.1:11434";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(embeddingDim = 4) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen3-embedding:0.6b" }] });
    if (url.endsWith("/api/embed")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const n = body.input?.length ?? 1;
      return jsonResponse({
        embeddings: Array.from({ length: n }, () => new Array(embeddingDim).fill(0.5)),
      });
    }
    return jsonResponse({ error: "not found" }, 404);
  });
}

describe("loadEmbeddingPipeline（Ollama）", () => {
  beforeEach(() => {
    __resetEmbeddingPipelineForTests();
    vi.clearAllMocks();
  });

  it("首次调用探测 /api/tags 并返回 EmbedFn", async () => {
    const fetchImpl = makeFetch();
    const fn = await loadEmbeddingPipeline("qwen3-embedding:0.6b", "/tmp/cache", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${BASE}/api/tags`);
    expect(typeof fn).toBe("function");
  });

  it("第二次调用复用单例，不再探测", async () => {
    const fetchImpl = makeFetch();
    const opts = { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch };
    await loadEmbeddingPipeline("qwen3-embedding:0.6b", "/tmp/cache", opts);
    await loadEmbeddingPipeline("qwen3-embedding:0.6b", "/tmp/cache", opts);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Ollama 不可达时抛 EmbedModelLoadFailedError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(
      loadEmbeddingPipeline("qwen3-embedding:0.6b", "/tmp/cache", {
        baseUrl: BASE,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(EmbedModelLoadFailedError);
  });

  it("reset 后下次调用重新探测", async () => {
    const fetchImpl = makeFetch();
    const opts = { baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch };
    await loadEmbeddingPipeline("m", "/tmp/cache", opts);
    __resetEmbeddingPipelineForTests();
    await loadEmbeddingPipeline("m", "/tmp/cache", opts);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("embed 走 /api/embed 并返回 Float32Array[]", async () => {
    const fetchImpl = makeFetch(4);
    const fn = await loadEmbeddingPipeline("m", "/tmp/cache", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = await fn(["你好", "再见"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]!.length).toBe(4);

    const embedCall = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith("/api/embed"));
    expect(embedCall).toBeTruthy();
    expect(JSON.parse(String(embedCall![1]!.body))).toEqual({
      model: "m",
      input: ["你好", "再见"],
    });
  });

  it("维度校验不符时抛错", async () => {
    const fetchImpl = makeFetch(4);
    const fn = await loadEmbeddingPipeline("m", "/tmp/cache", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dim: 1024,
    });

    await expect(fn(["x"])).rejects.toThrow(/维度不符/);
  });

  it("空输入不发请求", async () => {
    const fetchImpl = makeFetch();
    const fn = await loadEmbeddingPipeline("m", "/tmp/cache", {
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const before = fetchImpl.mock.calls.length;
    expect(await fn([])).toEqual([]);
    expect(fetchImpl.mock.calls.length).toBe(before);
  });
});
