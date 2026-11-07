import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind 类名，自动去重冲突。
 * 例：cn("px-2", condition && "px-4") → 仅保留后者。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
