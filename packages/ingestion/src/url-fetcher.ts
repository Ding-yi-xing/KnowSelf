/**
 * url-fetcher.ts — 拉取 URL 内容并返回文本 + content-type
 *
 * 通过 mcp-host ToolRegistry 调 fetch__fetch 工具完成 HTTP GET。
 * 返回的 contentType 用于后续 MIME 校验与 extractor 选择。
 */

import type { ToolRegistry } from "@knowself/mcp-host";
import { UrlFetchFailedError } from "./errors";

/**
 * URL 拉取需要的依赖。
 */
export interface UrlFetcherDeps {
  toolRegistry: ToolRegistry;
  /** 用于生成 tool_use_id；调用方提供。 */
  conversationId: string;
}

/**
 * 拉取单个 URL 的内容。
 * 返回解析后的文本 body 与 HTTP 响应的 content-type。
 */
export async function fetchUrlAsSource(
  deps: UrlFetcherDeps,
  url: string,
): Promise<{ text: string; contentType: string }> {
  const traceId = `url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const toolUseId = `url-${Date.now().toString(36)}`;

  const result = await deps.toolRegistry.invoke({
    tool_use_id: toolUseId,
    name: "fetch__fetch",
    input: { url },
    conversation_id: deps.conversationId,
    message_id: deps.conversationId,
    trace_id: traceId,
    request_id: traceId,
  });

  if (result.is_error) {
    throw new UrlFetchFailedError(url, result.output || "Unknown fetch error");
  }

  const parsed = parseFetchOutput(result.output);
  if (!parsed) {
    throw new UrlFetchFailedError(url, "Unable to parse fetch output");
  }

  return parsed;
}

/**
 * 解析 fetch__fetch 的 output（JSON 字符串）。
 * 预期形状：{ text: string; contentType: string } 或 { body: string; headers: Record<string,string> }
 */
function parseFetchOutput(output: string): { text: string; contentType: string } | null {
  try {
    const obj = JSON.parse(output);
    // 标准形状：{ text, contentType }
    if (typeof obj.text === "string") {
      return {
        text: obj.text,
        contentType: obj.contentType ?? "text/html",
      };
    }
    // 备选形状：{ body, headers: { "content-type": ... } }
    if (typeof obj.body === "string") {
      const ct = obj.headers?.["content-type"] ?? obj.headers?.["Content-Type"] ?? "text/html";
      return { text: obj.body, contentType: ct };
    }
    return null;
  } catch {
    return null;
  }
}
