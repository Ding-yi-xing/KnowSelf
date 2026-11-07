/**
 * trace.ts — trace ID 生成与上下文存取
 *
 * 每个请求中间件注入 trace ID；全链路追踪。
 * 生成：crypto.randomUUID()。
 * 存取：Hono context 的 "traceId" key。
 */

import { randomUUID } from "node:crypto";
import type { Context } from "hono";

/** 生成新 trace ID。走 crypto.randomUUID()，保证全局唯一。 */
export function newTraceId(): string {
  return randomUUID();
}

/** 从 Hono context 读取 trace ID。 */
export function getTraceId(c: Context): string {
  const val: unknown = c.get("traceId");
  return typeof val === "string" ? val : "unknown";
}
