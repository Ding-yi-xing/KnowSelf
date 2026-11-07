import type { ProfileChangeEvent } from "@knowself/contracts";

type Listener = (e: ProfileChangeEvent) => void;

export function createEventBus() {
  const listeners = new Set<Listener>();

  return {
    emit(event: ProfileChangeEvent): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // 隔离订阅者抛错，不影响其他订阅者
        }
      }
    },

    on(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
