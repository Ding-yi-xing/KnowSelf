/**
 * EmptyState — 空状态。
 * 用大字号标题 + 副文 + 可选行动按钮，居中显示。
 */
import { type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** 紧凑模式：缩小 padding 与字号 */
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-10 px-6" : "py-20 px-8",
        "fade-in",
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "mb-4 flex items-center justify-center rounded-[var(--radius-xl)]",
            "bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]",
            compact ? "h-12 w-12" : "h-14 w-14",
          )}
        >
          {icon}
        </div>
      )}
      <h3
        className={cn(
          "font-semibold tracking-[-0.01em] text-[var(--color-fg)]",
          compact ? "text-[16px]" : "text-[18px]",
        )}
      >
        {title}
      </h3>
      {description && (
        <p
          className={cn(
            "mt-1.5 max-w-sm leading-[1.5] text-[var(--color-fg-muted)]",
            compact ? "text-[13px]" : "text-[14px]",
          )}
        >
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
