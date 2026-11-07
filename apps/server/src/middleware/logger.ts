/**
 * logger.ts — 简单请求日志 + trace ID 注入
 *
 * 职责：
 *   - 生成 trace ID 并注入 c.set("traceId") + 响应头 X-Trace-Id
 *   - 打印 method + path + status + duration 行
 */

import type { MiddlewareHandler } from "hono";
import { newTraceId } from "../lib/trace";

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const traceId = newTraceId();
  c.set("traceId", traceId);
  c.header("X-Trace-Id", traceId);

  const start = Date.now();
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  console.log(
    `[${new Date().toISOString()}] ${method} ${path} ${status} ${duration}ms trace=${traceId}`,
  );
};
