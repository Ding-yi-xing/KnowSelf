import type { Transport } from "./types";
import { createHttpTransport } from "./http";
import { createTauriTransport } from "./tauri";

export type { Transport } from "./types";
export { TransportError } from "./types";

/**
 * 按运行环境自动选择传输实现。
 * - 浏览器中：HTTP（/api 走 Vite proxy → server）
 * - Tauri 环境中：Tauri IPC（非流式方法用 invoke，chat SSE 用 fetch 直连）
 */
export function getTransport(): Transport {
  const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

  if (isTauri) {
    return createTauriTransport();
  }

  return createHttpTransport("");
}
