import { z } from "zod";
import type { ProviderMessage } from "@knowself/contracts";
import { chat } from "./chat";
import { ProviderError } from "./errors";
import type { createRegistry } from "./registry";

export async function requestStructured<T extends z.ZodTypeAny>(
  deps: {
    registry: ReturnType<typeof createRegistry>;
    fetchImpl?: typeof fetch;
  },
  req: {
    provider_id: string;
    messages: ProviderMessage[];
    schema: T;
    schemaName: string;
    maxRepairAttempts?: number;
  },
): Promise<z.infer<T>> {
  const maxAttempts = req.maxRepairAttempts ?? 1;
  const providerConfig = deps.registry.getConfig(req.provider_id);
  const timeoutMs = providerConfig?.request_timeout_ms ?? 120_000;

  let lastText = "";
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const msgBlocks: ProviderMessage[] = [
      ...req.messages,
      {
        role: "user",
        content: [
          {
            kind: "text" as const,
            text: `Respond ONLY with valid JSON conforming to the "${req.schemaName}" schema. No explanations.`,
          },
        ],
      },
    ];

    const abortController = new AbortController();
    const timer = setTimeout(() => {
      try { abortController.abort(); } catch { /* race */ }
    }, timeoutMs);
    const chunks: string[] = [];
    try {
      try {
        for await (const chunk of chat(
          deps,
          {
            provider_id: req.provider_id,
            messages: msgBlocks,
            tools: [],
            stream: true,
            max_tokens: 4096,
            temperature: 0,
            stop_sequences: [],
            metadata: {},
          },
          abortController.signal,
        )) {
          if (chunk.type === "text") chunks.push(chunk.delta);
          if (chunk.type === "error") {
            throw new ProviderError(
              "UPSTREAM_5XX",
              chunk.message,
              req.provider_id,
              chunk.upstream_status,
              chunk.retryable,
            );
          }
          if (chunk.type === "message_end") break;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Abort/timeout — allow retry if attempts remain
      continue;
    }

    lastText = chunks.join("");
    const jsonText = extractJsonBlock(lastText);
    try {
      if (!jsonText) throw new SyntaxError("No JSON block found in output");
      const parsed = JSON.parse(jsonText);
      return req.schema.parse(parsed) as z.infer<T>;
    } catch (err) {
      if (attempt < maxAttempts) {
        // Push repair message
        req.messages.push(
          {
            role: "assistant",
            content: [{ kind: "text" as const, text: lastText }],
          },
          {
            role: "user",
            content: [
              {
                kind: "text" as const,
                text: `Invalid output. Error: ${err instanceof Error ? err.message : String(err)}. Please fix and retry.`,
              },
            ],
          },
        );
      }
    }
  }

  throw new ProviderError(
    "UPSTREAM_5XX",
    `Structured output validation failed after ${maxAttempts + 1} attempts`,
    req.provider_id,
    null,
    false,
  );
}

/**
 * 从 LLM 输出字符串中提取 JSON 块：
 * 1. 剥离 markdown 代码围栏（```json ... ``` 或 ``` ... ```）
 * 2. 如果以 [ 开头、] 结尾 → 直接做 array 切片
 * 3. 否则取第一个 { 到最后一个 } 的子串
 * 4. 如果提取结果看似多个根对象（{...},{...}），则外包为数组
 * 5. 若找不到有效 JSON 块则返回空串
 */
function extractJsonBlock(text: string): string {
  const noFence = text.replace(/```[a-z]*\s*([\s\S]*?)\s*```/g, "$1").trim();
  if (noFence.startsWith("[") && noFence.endsWith("]")) {
    return noFence;
  }
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return "";
  const block = noFence.slice(start, end + 1);
  // If block has multiple root objects ({...},{...}) with a comma between them,
  // wrap as array preserving the comma
  const commaPos = block.indexOf("},");
  if (commaPos > 0 && block.slice(commaPos + 2).trimStart().startsWith("{")) {
    return "[" + block.slice(0, commaPos + 1) + block.slice(commaPos + 1) + "]";
  }
  return block;
}
