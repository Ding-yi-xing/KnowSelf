/**
 * error.ts — 错误中间件 + onError 处理器
 *
 * 双模式：
 *   errorMiddleware  — app.use 注入 traceId（不含错误处理）
 *   onError          — app.onError 统一错误处理
 *
 * 处理：
 *   - ZodError-like（有 .issues 数组）→ 422
 *   - 有 .toPayload() 方法的 Error → 映射 HTTP 状态
 *   - 有 .code 属性的 Error → 映射 HTTP 状态
 *   - 其他 → 500 INTERNAL（不暴露 message）
 */

import type { Context } from "hono";
import { toHttpStatus } from "../errors";
import { getTraceId } from "../lib/trace";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasCode(err: any): err is Error & { code: string } {
  return typeof (err as { code?: unknown }).code === "string";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasToPayload(err: any): err is Error & { toPayload(): Record<string, unknown> } {
  return typeof (err as { toPayload?: unknown }).toPayload === "function";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasZodIssues(err: any): boolean {
  return Array.isArray((err as { issues?: unknown }).issues);
}

/** App.onError 处理器：统一 JSON 错误响应 */
export function onError(err: Error, c: Context): Response {
  const traceId = (() => {
    try {
      return getTraceId(c);
    } catch {
      return "unknown";
    }
  })();

  if (err instanceof Error && hasZodIssues(err)) {
    const first = (err as Error & { issues: Array<{ message: string; path: (string | number)[] }> })
      .issues[0];
    const path = first ? first.path.join(".") : "";
    return c.json(
      {
        code: "VALIDATION",
        message: `校验失败${path ? "：" + path + " " + first?.message : ""}`,
        trace_id: traceId,
        path: path || undefined,
      },
      422 as never,
    );
  }

  if (hasToPayload(err)) {
    const payload = err.toPayload();
    const code = (payload.code as string) ?? "INTERNAL";
    return c.json(
      { ...payload, trace_id: payload.trace_id ?? traceId },
      toHttpStatus(code) as never,
    );
  }

  if (hasCode(err)) {
    return c.json(
      { code: err.code, message: err.message, trace_id: traceId },
      toHttpStatus(err.code) as never,
    );
  }

  // 未知错误
  console.error(`[error] unhandled [${traceId}]:`, err);
  return c.json(
    { code: "INTERNAL", message: "Internal server error", trace_id: traceId },
    500 as never,
  );
}
