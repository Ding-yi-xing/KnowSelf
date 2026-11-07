/**
 * embedding.ts — 句向量嵌入管线（V3：Ollama HTTP）
 *
 * 变更（K-37 / SRS §2.4 A4 / DESIGN-10 §7.1 修订 1）：
 *   原 `@xenova/transformers` + `Xenova/bge-small-zh-v1.5`（384 维）方案作废——
 *   权重下载被网络策略拦截（A4 已证伪）→ 改用本机 Ollama `qwen3-embedding:0.6b`（1024 维）。
 *
 * 接口语义保持不变：`loadEmbeddingPipeline(modelId, cacheDir)` 返回 `EmbedFn`；
 * 失败时抛 `EmbedModelLoadFailedError`，由 `createContextRouter` 捕获后降级（`fallback_when_no_embed`）。
 * `cacheDir` 参数保留仅为**调用方兼容**，Ollama 侧不使用（模型由 Ollama 管理）。
 */

import { EmbedModelLoadFailedError } from "./errors";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface EmbeddingOptions {
  /** Ollama 根地址；默认读 `KNOWSELF_OLLAMA_BASE_URL`，再退回 `http://127.0.0.1:11434`。 */
  baseUrl?: string | undefined;
  /** 单次请求超时（ms），默认 30s。 */
  timeoutMs?: number | undefined;
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch | undefined;
  /** 期望维度；给定时校验返回值，不符抛错（默认不校验）。 */
  dim?: number | undefined;
}

interface EmbedResponse {
  embeddings?: number[][];
  /** 旧版 `/api/embeddings` 单条返回 */
  embedding?: number[];
}

function resolveBaseUrl(opts: EmbeddingOptions): string {
  const raw = opts.baseUrl ?? process.env.KNOWSELF_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

interface CacheEntry {
  modelId: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  dim: number | undefined;
  fn: EmbedFn;
}

let _cached: CacheEntry | null = null;
let _loading: Promise<EmbedFn> | null = null;

/**
 * 探测 Ollama 是否可达。
 *
 * 只校验 `/api/tags` 能通——不校验模型是否已 pull：未 pull 的模型在 embed 阶段会报错，
 * 由上层按 `fallback_when_no_embed` 降级；此处若严格校验会把「模型名带 :latest 后缀」等
 * 正常差异误判为加载失败。
 */
async function probeOllama(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/api/tags`, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama /api/tags responded ${res.status}`);
}

function createEmbedFn(
  modelId: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  dim?: number,
): EmbedFn {
  return async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];

    const res = await fetchImpl(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama /api/embed responded ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as EmbedResponse;
    const rows = data.embeddings ?? (data.embedding ? [data.embedding] : []);
    if (rows.length !== texts.length) {
      throw new Error(
        `Ollama 返回向量条数不匹配：期望 ${texts.length}，实际 ${rows.length}（model=${modelId}）`,
      );
    }

    const out = rows.map((row) => Float32Array.from(row));
    if (dim !== undefined) {
      const actual = out[0]?.length ?? 0;
      if (actual !== dim) {
        throw new Error(
          `embedding 维度不符：期望 ${dim}，实际 ${actual}（model=${modelId}）——请确认 ${modelId} 与 §7.2 DDL 的 float[${dim}] 一致`,
        );
      }
    }
    return out;
  };
}

export async function loadEmbeddingPipeline(
  modelId: string,
  _cacheDir: string,
  opts: EmbeddingOptions = {},
): Promise<EmbedFn> {
  const baseUrl = resolveBaseUrl(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  if (_cached && _cached.modelId === modelId && _cached.baseUrl === baseUrl) {
    return _cached.fn;
  }
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      await probeOllama(baseUrl, fetchImpl, timeoutMs);
    } catch (e) {
      _loading = null;
      throw new EmbedModelLoadFailedError(
        `无法连接 Ollama（${baseUrl}）：${String(e)}。请先启动 Ollama 并 pull ${modelId}。`,
      );
    }

    const fn = createEmbedFn(modelId, baseUrl, fetchImpl, timeoutMs, opts.dim);
    _cached = { modelId, baseUrl, fetchImpl, dim: opts.dim, fn };
    _loading = null;
    return fn;
  })();

  return _loading;
}

export function __resetEmbeddingPipelineForTests(): void {
  _cached = null;
  _loading = null;
}
