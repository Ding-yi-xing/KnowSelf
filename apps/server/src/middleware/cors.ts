/**
 * cors.ts — CORS 中间件
 *
 * 设计前提：server 监听 127.0.0.1（仅本机回环，不对外暴露），所以放宽到
 * "本地 web / 桌面 webview origin 全部放行" 是安全的。
 *
 * 命中规则（任一即放行）：
 *   - http(s)://localhost / http(s)://localhost:<port>
 *   - http(s)://127.0.0.1 / http(s)://127.0.0.1:<port>
 *   - tauri://<任意 host>
 *   - http(s)://tauri.localhost / http(s)://*.tauri.localhost
 *
 * 实现要点：
 *   - 必须在 await next() 之后再写 CORS 头到 c.res.headers。Hono 的路由层
 *     处理函数会用 c.json/Response.json 创建新的 Response 对象赋给 c.res，
 *     之前写的 c.header(...) 在新 Response 上**不会保留**。所以非 OPTIONS
 *     请求要走 next() 后再设 header；OPTIONS 由本中间件直接回 204。
 */

import type { MiddlewareHandler } from "hono";

function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const protocol = url.protocol;
  const hostname = url.hostname.toLowerCase();

  if (protocol === "tauri:") return true;

  if (protocol === "http:" || protocol === "https:") {
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname === "tauri.localhost" || hostname.endsWith(".tauri.localhost")) {
      return true;
    }
  }

  return false;
}

function applyCorsHeaders(headers: Headers, origin: string): void {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
}

export const corsMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = origin ? isAllowedOrigin(origin) : false;

  // OPTIONS 预检：本中间件直接答复，不进路由层。命中 origin 时附 CORS 头；
  // 不命中也回 204（不写 ACAO，浏览器会自行拒绝，等价拦截，避免路由层 404 噪声）。
  if (c.req.method === "OPTIONS") {
    const headers = new Headers();
    if (origin && allowed) {
      applyCorsHeaders(headers, origin);
    }
    return new Response(null, { status: 204, headers });
  }

  await next();

  // 非 OPTIONS：next() 之后，c.res 是路由层产生的真实 Response。
  // 把 CORS 头**直接**写到它的 Headers 上，确保返客户端时 ACAO 在响应中。
  if (origin && allowed) {
    applyCorsHeaders(c.res.headers, origin);
  }
};
