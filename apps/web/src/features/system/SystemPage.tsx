/**
 * SystemPage — 系统状态总览。
 * 迁移前行为：状态卡 + provider/MCP/检索/蒸馏/环境详情 + 手动刷新；加载态、失败态与重试。
 */
import { useCallback, useEffect, useState } from "react";
import { profileApi, type ProfileApi } from "../../transport/profileApi";
import type { SystemStatus } from "../../transport/types";
import { Badge, Button, Card, EmptyState, PageHeader, Spinner, ErrorBanner } from "../../ui/primitives";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [d > 0 ? `${d}天` : "", h > 0 ? `${h}小时` : "", `${m}分`, `${s}秒`].filter(Boolean).join(" ");
}

export function SystemPage({ client = profileApi }: { client?: ProfileApi }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await client.systemStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && status === null) return <div className="content-inner"><Spinner label="加载系统状态" /></div>;
  if (status === null) {
    return (
      <div className="content-inner">
        <PageHeader title="系统" subtitle="运行时状态与健康检查" />
        {error !== null && <ErrorBanner message={error} />}
        <EmptyState title="系统状态加载失败" description="请确认后端服务已启动，然后重试。" />
        <div className="card-actions" style={{ justifyContent: "center" }}>
          <Button variant="primary" onClick={() => void load()}>重试</Button>
        </div>
      </div>
    );
  }

  const readyEntries = Object.entries(status.ready ?? {}).filter(([key]) => key !== "overall");
  const details: Array<[string, unknown]> = [
    ["模型供应商", status.providers],
    ["MCP", status.mcp],
    ["检索索引", status.retriever],
    ["蒸馏", status.ingestion],
    ["运行环境", status.environment],
  ].filter(([, value]) => value !== undefined) as Array<[string, unknown]>;

  return (
    <div className="content-inner">
      <PageHeader title="系统" subtitle="运行时状态与健康检查" />
      <div className="card-actions" style={{ marginBottom: 16, justifyContent: "space-between" }}>
        <span className="card-meta">
          v{status.app_version} · 已运行 {formatUptime(status.uptime_seconds)} · 采集于 {status.collected_at}
        </span>
        <Button onClick={() => void load()}>刷新</Button>
      </div>

      <Card>
        <div className="stat-grid">
          {readyEntries.map(([key, ready]) => (
            <div className="stat" key={key}>
              <span className="card-meta">{key}</span>
              <Badge tone={ready ? "success" : "neutral"}>{ready ? "就绪" : "未就绪"}</Badge>
            </div>
          ))}
        </div>
      </Card>

      {details.map(([label, value]) => (
        <Card key={label}>
          <div className="card-head"><strong>{label}</strong></div>
          <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>
        </Card>
      ))}
    </div>
  );
}
