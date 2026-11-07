/**
 * Spinner — 旋转加载指示器。三种尺寸。
 * 直接用作 inline-block，不带文字。
 */
import { cn } from "../../lib/cn";

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLASSES = {
  sm: "size-3.5",
  md: "size-5",
  lg: "size-7",
};

export function Spinner({ size = "md", className }: SpinnerProps) {
  return (
    <svg
      className={cn("animate-spin text-current", SIZE_CLASSES[size], className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-label="加载中"
      role="status"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Skeleton — 占位条。 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton h-4 w-full", className)} {...props} />;
}
