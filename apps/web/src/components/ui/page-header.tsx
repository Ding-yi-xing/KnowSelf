/**
 * PageHeader — 页面顶部统一的标题区。
 * 提供 title / subtitle / 右侧操作三个槽位。
 */
import { type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  /** 是否带底部分隔线 */
  bordered?: boolean;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
  bordered = true,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-end justify-between gap-4 px-8 py-5",
        bordered && "border-b border-[var(--color-border-subtle)]",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-[var(--color-fg)]">
          {title}
        </h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-[var(--color-fg-muted)]">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
