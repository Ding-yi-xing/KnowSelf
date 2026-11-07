/**
 * StatusPill — 服务健康状态指示器。
 * 仅用一颗有 ping 动效的圆点 + 简短文字。Apple 路线不靠强色。
 */
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";

type State = "healthy" | "degraded" | "dead" | "starting" | "disabled" | "unknown";

interface StatusPillProps {
  state: State;
  label?: string;
  /** 紧凑：仅圆点不显示文字 */
  dotOnly?: boolean;
}

const STATE: Record<State, { dot: string; ping: boolean; labelKey: string }> = {
  healthy: { dot: "bg-[var(--color-success)]", ping: true, labelKey: "status_pill.healthy" },
  degraded: { dot: "bg-[var(--color-warning)]", ping: false, labelKey: "status_pill.degraded" },
  dead: { dot: "bg-[var(--color-danger)]", ping: false, labelKey: "status_pill.dead" },
  starting: { dot: "bg-[var(--color-accent)]", ping: true, labelKey: "status_pill.starting" },
  disabled: { dot: "bg-[var(--color-fg-subtle)]", ping: false, labelKey: "status_pill.disabled" },
  unknown: { dot: "bg-[var(--color-border-strong)]", ping: false, labelKey: "status_pill.unknown" },
};

export function StatusPill({ state, label, dotOnly = false }: StatusPillProps) {
  const t = useT();
  const meta = STATE[state];
  const text = label ?? t(meta.labelKey);

  return (
    <span className="inline-flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
      <span className="relative flex size-2">
        {meta.ping && (
          <span
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-60",
              meta.dot,
              "animate-ping",
            )}
            style={{ animationDuration: "1.6s" }}
          />
        )}
        <span className={cn("relative inline-flex size-2 rounded-full", meta.dot)} />
      </span>
      {!dotOnly && <span>{text}</span>}
    </span>
  );
}
