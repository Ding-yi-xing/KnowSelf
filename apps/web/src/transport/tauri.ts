import type { Transport } from "./types";
import { createHttpTransport } from "./http";

/**
 * TauriTransport — 桌面端传输层。
 *
 * 当 Tauri 侧载的后端 server 运行在 127.0.0.1:9527 时，
 * 所有请求直接走 fetch()，与 HttpTransport 行为一致，
 * 只是 baseUrl 固定指向 sidecar 端口。
 */
export function createTauriTransport(): Transport {
  return createHttpTransport("http://127.0.0.1:9527");
}
