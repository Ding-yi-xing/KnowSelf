import { useEffect } from "react";
import { useTransport } from "../stores/transport-context";
import { useSystemStore } from "../stores/system";

/**
 * 启动 system status 轮询，组件卸载时自动清理。
 */
export function usePollSystemStatus(intervalMs: number = 5000) {
  const transport = useTransport();
  const system = useSystemStore();

  useEffect(() => {
    const stop = system.startPolling(intervalMs, transport);
    return stop;
  }, [intervalMs, transport, system.startPolling]);
}
