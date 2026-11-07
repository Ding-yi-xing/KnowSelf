/**
 * validate.ts — Zod 校验中间件
 *
 * zValidate(schema, "json" | "query") → Hono middleware。
 *
 * - "json": 读 c.req.json() → schema.parse
 * - "query": 读 c.req.query() → schema.parse（query param 全部是 string，先转 object）
 *
 * 校验后结果写入 c.set("validated", parsed)。
 * 校验失败抛 ZodError，由 errorMiddleware 捕获 → 422。
 */

import type { MiddlewareHandler } from "hono";
import type { z } from "zod";

type ValidationSource = "json" | "query";

export function zValidate<T extends z.ZodTypeAny>(
  schema: T,
  source: ValidationSource,
): MiddlewareHandler {
  return async (c, next) => {
    let raw: unknown;

    if (source === "json") {
      raw = await c.req.json().catch(() => ({}));
    } else {
      // query：Hono 的 c.req.query() 返回 Record<string, string>
      // 用 c.req.queries() 或直接从 URL searchParams 构造
      const url = new URL(c.req.url);
      const obj: Record<string, string | number> = {};
      for (const [k, v] of url.searchParams.entries()) {
        // 数字字符自动转 number
        obj[k] = /^\d+$/.test(v) ? Number(v) : v;
      }
      raw = obj;
    }

    const parsed = schema.parse(raw);
    c.set("validated", parsed);
    await next();
  };
}
