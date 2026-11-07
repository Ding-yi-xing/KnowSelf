/**
 * Badge — 状态标签。default / success / warning / danger / info / outline。
 */
import { type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "default" | "success" | "warning" | "danger" | "info" | "outline";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default: "bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  info: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  outline: "border border-[var(--color-border)] bg-transparent text-[var(--color-fg-muted)]",
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-pill)]",
        "px-2 py-0.5 text-[11px] font-medium tracking-[0.02em]",
        "whitespace-nowrap",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  );
}
