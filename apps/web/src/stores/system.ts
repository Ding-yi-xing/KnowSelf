import { create } from "zustand";
import type { SystemStatusResponse } from "@knowself/contracts";
import type { TransportError } from "../transport/types";
import type { useTransport } from "./transport-context";

interface SystemState {
  status: SystemStatusResponse | null;
  loading: boolean;
  lastFetchedAt: string | null;
  error: TransportError | null;

  fetch: (t: ReturnType<typeof useTransport>) => Promise<void>;
  startPolling: (intervalMs: number, t: ReturnType<typeof useTransport>) => () => void;
}

export const useSystemStore = create<SystemState>((set, get) => ({
  status: null,
  loading: false,
  lastFetchedAt: null,
  error: null,

  fetch: async (t) => {
    set({ loading: true, error: null });
    try {
      const status = await t.getSystemStatus();
      set({
        status,
        loading: false,
        lastFetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  startPolling: (intervalMs, t) => {
    // 立即拉一次
    void get().fetch(t);

    const id = setInterval(() => {
      void get().fetch(t);
    }, intervalMs);

    return () => clearInterval(id);
  },
}));
