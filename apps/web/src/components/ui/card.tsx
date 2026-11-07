/**
 * Card — 内容容器卡片。极轻浮起感。
 * 默认无阴影，靠边框；hoverable 时鼠标悬停才有微浮起。
 */
import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hoverable?: boolean;
  /** 紧凑模式：12px padding；默认 20px */
  compact?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, hoverable, compact, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)]",
        "bg-[var(--color-bg)]",
        compact ? "p-3" : "p-5",
        hoverable &&
          "transition-[border-color,box-shadow,transform] duration-[var(--duration-base)] ease-[var(--ease-standard)] " +
            "hover:border-[var(--color-border)] hover:shadow-[var(--shadow-sm)] hover:-translate-y-px",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-3", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "text-[16px] font-semibold tracking-[-0.005em] text-[var(--color-fg)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("mt-0.5 text-[13px] leading-[1.4] text-[var(--color-fg-muted)]", className)}
      {...props}
    />
  );
}
