import { useState, useCallback, useRef } from "react";

export interface ToastMessage {
  id: number;
  text: string;
  type: "info" | "error" | "success";
}

let nextId = 0;

/**
 * 简单的全局消息提示 hook。
 * 使用 state 驱动的 toast 队列，非粘性。
 */
export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const show = useCallback((text: string, type: "info" | "error" | "success" = "info") => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, text, type }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, 4000);
    timersRef.current.set(id, timer);
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, show, dismiss };
}
