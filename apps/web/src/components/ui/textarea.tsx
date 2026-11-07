/**
 * Textarea — 多行文本输入。自动高度可由父级配 rows / 自定义 onInput 实现。
 */
import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full rounded-[var(--radius-md)] border border-[var(--color-border)]",
      "bg-[var(--color-bg)] px-3 py-2.5 text-[14px] text-[var(--color-fg)]",
      "placeholder:text-[var(--color-fg-subtle)]",
      "transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
      "hover:border-[var(--color-border-strong)]",
      "focus:outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--shadow-focus)]",
      "disabled:bg-[var(--color-bg-muted)] disabled:text-[var(--color-fg-subtle)] disabled:cursor-not-allowed",
      "resize-none",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
