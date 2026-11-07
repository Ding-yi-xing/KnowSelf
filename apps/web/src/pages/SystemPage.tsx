/**
 * SystemPage — 系统状态总览。Stat cards + Provider/MCP 详情。
 */
import { useEffect } from "react";
import { Activity, Clock, Cpu, RefreshCw } from "lucide-react";
import { useSystemStore } from "../stores/system";
import { useTransport } from "../stores/transport-context";
import { StatusPill } from "../components/StatusPill";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { formatDuration } from "../lib/format";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";

export function SystemPage() {
  const t = useT();
  const transport = useTransport();
  const status = useSystemStore((s) => s.status);
  const loading = useSystemStore((s) => s.loading);
  const fetch = useSystemStore((s) => s.fetch);

  useEffect(() => {
    void fetch(transport);
  }, [fetch, transport]);

  if (loading && !status)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" className="text-[var(--color-fg-subtle)]" />
      </div>
    );

  if (!status)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<Activity className="size-6" strokeWidth={1.8} />}
          title={t("system.load_fail")}
          description={t("system.load_fail_desc")}
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => void fetch(transport)}
              iconLeft={<RefreshCw className="size-3.5" strokeWidth={2.4} />}
            >
              {t("system.retry")}
            </Button>
          }
        />
      </div>
    );

  const readyEntries: [string, boolean][] = Object.entries(status.ready).filter(
    ([k]) => k !== "overall",
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("system.title")}
        subtitle={t("system.subtitle")}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetch(transport)}
            iconLeft={<RefreshCw className="size-3.5" strokeWidth={2.4} />}
            disabled={loading}
          >
            {t("system.refresh")}
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-8 pb-12">
          {/* Stat cards row */}
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              icon={<Activity className="size-4" strokeWidth={2} />}
              label={t("system.overall")}
              value={status.ready.overall ? t("system.healthy") : t("system.not_ready")}
              tone={status.ready.overall ? "success" : "warning"}
            />
            <StatCard
              icon={<Clock className="size-4" strokeWidth={2} />}
              label={t("system.uptime")}
              value={formatDuration(status.uptime_seconds * 1000)}
            />
            <StatCard
              icon={<Cpu className="size-4" strokeWidth={2} />}
              label={t("system.version")}
              value={`v${status.app_version}`}
              mono
            />
          </div>

          {/* 子模块 ready */}
          <Section title={t("system.components")}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {readyEntries.map(([name, ready]) => (
                <div
                  key={name}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2"
                >
                  <span className="text-[13px] text-[var(--color-fg)]">{LABEL[name] ?? name}</span>
                  <StatusPill state={ready ? "healthy" : "starting"} dotOnly />
                </div>
              ))}
            </div>
          </Section>

          {/* Providers */}
          <Section title={t("settings.providers.title")}>
            {status.providers.length === 0 ? (
              <p className="text-[13px] text-[var(--color-fg-subtle)]">
                {t("system.no_providers")}
              </p>
            ) : (
              <div className="space-y-1.5">
                {status.providers.map((p) => (
                  <div
                    key={p.provider_id}
                    className={cn(
                      "flex items-center gap-3 rounded-[var(--radius-md)]",
                      "border border-[var(--color-border-subtle)] bg-[var(--color-bg)]",
                      "px-3 py-2",
                    )}
                  >
                    <StatusPill state={p.state} dotOnly />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--color-fg)]">
                      {p.provider_id}
                    </span>
                    {p.probed_supports_tools && <Badge variant="info">tools</Badge>}
                    {p.consecutive_failures > 0 && (
                      <Badge variant="warning">
                        {t("system.failed")}
                        {p.consecutive_failures}
                      </Badge>
                    )}
                    {p.latency_p50_ms != null && (
                      <span className="font-mono text-[11.5px] text-[var(--color-fg-subtle)]">
                        {formatDuration(p.latency_p50_ms)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* MCP servers */}
          {status.mcp.servers.length > 0 && (
            <Section title={t("system.mcp_title")}>
              <div className="space-y-1.5">
                {status.mcp.servers.map((s) => (
                  <div
                    key={s.server_id}
                    className={cn(
                      "flex items-center gap-3 rounded-[var(--radius-md)]",
                      "border border-[var(--color-border-subtle)] bg-[var(--color-bg)]",
                      "px-3 py-2",
                    )}
                  >
                    <StatusPill state={s.state} dotOnly />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--color-fg)]">
                      {s.server_id}
                    </span>
                    {s.restart_count > 0 && (
                      <Badge variant="warning">
                        {t("system.restart")}
                        {s.restart_count}
                      </Badge>
                    )}
                    <span className="font-mono text-[11.5px] text-[var(--color-fg-subtle)]">
                      {t("system.tools_count", { n: String(s.tool_names.length) })}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

const LABEL: Record<string, string> = {
  profile_store: "Profile Store",
  context_router: "Context Router",
  provider_adapter: "Provider Adapter",
  mcp_host: "MCP Host",
  ingestion: "Ingestion",
};

function StatCard({
  icon,
  label,
  value,
  tone,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "success" | "warning" | "danger";
  mono?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-2 py-4">
      <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
        {icon}
        <span className="text-[12px] tracking-[0.02em] uppercase">{label}</span>
      </div>
      <div
        className={cn(
          "text-[20px] font-semibold tracking-[-0.01em]",
          mono && "font-mono",
          tone === "success" && "text-[var(--color-success)]",
          tone === "warning" && "text-[var(--color-warning)]",
          tone === "danger" && "text-[var(--color-danger)]",
          !tone && "text-[var(--color-fg)]",
        )}
      >
        {value}
      </div>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-subtle)]">
        {title}
      </h3>
      {children}
    </section>
  );
}
