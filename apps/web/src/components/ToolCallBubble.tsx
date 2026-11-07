/**
 * ToolCallBubble — 工具调用展示。
 * dark 模式下用于嵌在 user 气泡内（用户气泡是 Apple Blue 实色）。
 */
import { useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/format";

export interface ToolCallInfo {
  tool_use_id: string;
  name: string;
  input?: unknown;
  output?: string;
  is_error?: boolean;
  duration_ms?: number;
  phase: string;
}

interface ToolCallBubbleProps {
  tool: ToolCallInfo;
  /** 嵌在深色背景气泡内 */
  dark?: boolean;
}

export function ToolCallBubble({ tool, dark = false }: ToolCallBubbleProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isDone = tool.phase === "done" || tool.phase === "error";
  const isErr = tool.is_error || tool.phase === "error";

  return (
    <div
      className={cn(
        "rounded-[var(--radius-md)] border text-[12.5px]",
        dark
          ? "border-white/15 bg-white/5 text-white"
          : "border-[var(--color-border-subtle)] bg-[var(--color-bg)] text-[var(--color-fg)]",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left",
          "transition-colors duration-[var(--duration-fast)]",
          dark ? "hover:bg-white/5" : "hover:bg-[var(--color-bg-muted)]",
          "rounded-[var(--radius-md)]",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-[var(--duration-fast)]",
            expanded && "rotate-90",
            dark ? "text-white/60" : "text-[var(--color-fg-subtle)]",
          )}
          strokeWidth={2.5}
        />
        <Wrench
          className={cn(
            "size-3.5 shrink-0",
            dark ? "text-white/60" : "text-[var(--color-fg-subtle)]",
          )}
          strokeWidth={2}
        />
        <span className={cn("font-mono", dark ? "text-white/85" : "text-[var(--color-fg-muted)]")}>
          {tool.name}
        </span>
        {isDone ? (
          <span
            className={cn(
              "ml-auto rounded-[var(--radius-pill)] px-1.5 py-px text-[10.5px] font-medium tracking-[0.02em]",
              isErr
                ? cn(
                    dark
                      ? "bg-white/10 text-white"
                      : "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
                  )
                : cn(
                    dark
                      ? "bg-white/10 text-white"
                      : "bg-[var(--color-success-soft)] text-[var(--color-success)]",
                  ),
            )}
          >
            {isErr ? t("tool_call.status_fail") : t("tool_call.status_done")}
          </span>
        ) : (
          <span
            className={cn(
              "ml-auto animate-pulse text-[10.5px] tracking-[0.02em]",
              dark ? "text-white/55" : "text-[var(--color-fg-subtle)]",
            )}
          >
            {tool.phase}
          </span>
        )}
      </button>

      {expanded && (
        <div
          className={cn(
            "border-t px-3 py-2 space-y-2",
            dark ? "border-white/10" : "border-[var(--color-border-subtle)]",
          )}
        >
          {tool.input !== undefined && (
            <div>
              <div
                className={cn(
                  "mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em]",
                  dark ? "text-white/55" : "text-[var(--color-fg-subtle)]",
                )}
              >
                {t("tool_call.input")}
              </div>
              <pre
                className={cn(
                  "max-h-32 overflow-auto rounded-[var(--radius-sm)] p-2 font-mono text-[11.5px]",
                  dark
                    ? "bg-black/20 text-white/90"
                    : "bg-[var(--color-bg-muted)] text-[var(--color-fg)]",
                )}
              >
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div
                className={cn(
                  "mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em]",
                  dark ? "text-white/55" : "text-[var(--color-fg-subtle)]",
                )}
              >
                {t("tool_call.output")}
              </div>
              <pre
                className={cn(
                  "max-h-48 overflow-auto rounded-[var(--radius-sm)] p-2 font-mono text-[11.5px]",
                  dark
                    ? "bg-black/20 text-white/90"
                    : "bg-[var(--color-bg-muted)] text-[var(--color-fg)]",
                )}
              >
                {tool.output}
              </pre>
            </div>
          )}
          {tool.duration_ms !== undefined && (
            <div
              className={cn(
                "text-[10.5px] tracking-[0.02em]",
                dark ? "text-white/45" : "text-[var(--color-fg-subtle)]",
              )}
            >
              {t("tool_call.duration")}
              {formatDuration(tool.duration_ms)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
