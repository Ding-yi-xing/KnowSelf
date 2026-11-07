/**
 * Input — 单行文本输入。
 * 与 Button 配套的视觉规范：高度 36，圆角 10，焦点态 Apple Blue 环。
 */
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)]",
        "bg-[var(--color-bg)] px-3 text-[14px] text-[var(--color-fg)]",
        "placeholder:text-[var(--color-fg-subtle)]",
        "transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "hover:border-[var(--color-border-strong)]",
        "focus:outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--shadow-focus)]",
        "disabled:bg-[var(--color-bg-muted)] disabled:text-[var(--color-fg-subtle)] disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
