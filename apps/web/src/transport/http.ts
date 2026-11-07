/**
 * HTTP 传输 —— 重写，零复用旧前端 transport。
 * 端点与迁移前一致：/api/proposals、/api/proposals/:id/decide、/api/system/status。
 * 同源请求由 Vite proxy 转发到后端 9527。
 */
import type { DecideBody, DecideResult, Proposal, SystemStatus } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      /* 响应体不可读时保留状态文本 */
    }
    throw new ApiError(`${method} ${path} → ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface KnowSelfApi {
  listPending(): Promise<Proposal[]>;
  decide(id: string, body: DecideBody): Promise<DecideResult>;
  systemStatus(): Promise<SystemStatus>;
}

export function createHttpApi(base = ""): KnowSelfApi {
  return {
    listPending: () => request<Proposal[]>("GET", `${base}/api/proposals?status=pending`),
    decide: (id, body) =>
      request<DecideResult>("PATCH", `${base}/api/proposals/${encodeURIComponent(id)}/decide`, body),
    systemStatus: () => request<SystemStatus>("GET", `${base}/api/system/status`),
  };
}

export const api: KnowSelfApi = createHttpApi();
