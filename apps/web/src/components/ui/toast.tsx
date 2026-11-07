/**
 * Toast — 出场动画的轻量提示。useToast hook 使用。
 * variant: info / success / warning / danger
 */
import { type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface ToastProps {
  variant?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
  testId?: string;
}

const VARIANT_CLASSES = {
  info: "bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-[var(--color-accent)]/20",
  success:
    "bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success)]/20",
  warning:
    "bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]/20",
  danger:
    "bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[var(--color-danger)]/20",
};

export function Toast({ variant = "info", children, testId }: ToastProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "slide-up pointer-events-auto",
        "rounded-[var(--radius-md)] border px-4 py-2.5 text-[13.5px] font-medium",
        "shadow-[var(--shadow-md)] backdrop-blur-md",
        VARIANT_CLASSES[variant],
      )}
    >
      {children}
    </div>
  );
}

/** ToastViewport — 全局浮层容器。固定右下角 */
export function ToastViewport({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {children}
    </div>
  );
}
