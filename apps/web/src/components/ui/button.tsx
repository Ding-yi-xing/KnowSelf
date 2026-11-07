/**
 * Button — 多变体按钮。
 * 默认 primary（Apple Blue）；secondary（灰边）；ghost（无背景）；
 * destructive（红色，用于不可逆操作）；subtle（浅灰底）。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "destructive" | "subtle";
type Size = "sm" | "md" | "lg" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[var(--color-fg-on-accent)] " +
    "hover:bg-[var(--color-accent-hover)] active:bg-[var(--color-accent-active)] " +
    "shadow-[var(--shadow-xs)]",
  secondary:
    "bg-[var(--color-bg)] text-[var(--color-fg)] border border-[var(--color-border)] " +
    "hover:bg-[var(--color-bg-subtle)] active:bg-[var(--color-bg-muted)]",
  ghost:
    "bg-transparent text-[var(--color-fg-muted)] " +
    "hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)] " +
    "active:bg-[var(--color-border-subtle)]",
  destructive:
    "bg-[var(--color-danger)] text-white " +
    "hover:opacity-92 active:opacity-85 shadow-[var(--shadow-xs)]",
  subtle:
    "bg-[var(--color-bg-muted)] text-[var(--color-fg)] " +
    "hover:bg-[var(--color-border-subtle)] active:bg-[var(--color-border)]",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-9 px-4 text-[14px] gap-2",
  lg: "h-11 px-6 text-[15px] gap-2",
  icon: "h-9 w-9 p-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      iconLeft,
      iconRight,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={cn(
          "inline-flex items-center justify-center font-medium rounded-[var(--radius-md)]",
          "transition-[background-color,color,opacity,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
          "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
          "disabled:opacity-50 disabled:pointer-events-none",
          "select-none whitespace-nowrap",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...props}
      >
        {loading ? (
          <Spinner />
        ) : (
          <>
            {iconLeft && <span className="shrink-0">{iconLeft}</span>}
            {children}
            {iconRight && <span className="shrink-0">{iconRight}</span>}
          </>
        )}
      </button>
    );
  },
);
Button.displayName = "Button";

function Spinner() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
