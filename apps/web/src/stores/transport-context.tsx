import { createContext, useContext, type ReactNode } from "react";
import type { Transport } from "../transport/types";

const TransportCtx = createContext<Transport | null>(null);

/**
 * 将 transport 实例注入组件树。所有 store 与 hook 通过 useTransport 获取。
 */
export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: ReactNode;
}) {
  return <TransportCtx.Provider value={transport}>{children}</TransportCtx.Provider>;
}

/**
 * 获取 transport 实例。若不在 TransportProvider 作用域内，抛错。
 */
export function useTransport(): Transport {
  const t = useContext(TransportCtx);
  if (!t) {
    throw new Error("useTransport 必须在 TransportProvider 内部使用");
  }
  return t;
}
