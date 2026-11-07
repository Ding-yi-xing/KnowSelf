import { useEffect, useState, useCallback, type FormEvent } from "react";
import type { ProviderConfig, McpServerConfig } from "@knowself/contracts";
import { useSettingsStore, useSettingsPreview } from "../stores/settings";
import { useTransport } from "../stores/transport-context";
import { useTheme } from "../hooks/useTheme";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Toast, ToastViewport } from "../components/ui/toast";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { Download, Eye, EyeOff } from "lucide-react";

const PROTOCOL_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  custom: "settings.provider_dialog.protocol_custom",
};
import { ProviderEditDialog } from "../components/ProviderEditDialog";
import { ExportDialog } from "../components/ExportDialog";
import { ImportDialog } from "../components/ImportDialog";
import { McpServerDialog } from "../components/McpServerDialog";

export function SettingsPage() {
  const t = useT();
  const transport = useTransport();
  const settings = useSettingsStore((s) => s.settings);
  const dirty = useSettingsStore((s) => s.dirty);
  const saving = useSettingsStore((s) => s.saving);
  const load = useSettingsStore((s) => s.load);
  const patch = useSettingsStore((s) => s.patch);
  const save = useSettingsStore((s) => s.save);
  const revert = useSettingsStore((s) => s.revert);
  const preview = useSettingsPreview();
  const { setTheme: applyTheme } = useTheme();

  const [locale, setLocale] = useState("zh-CN");
  const [theme, setLocalTheme] = useState<string>("system");
  const [toast, setToast] = useState<string | null>(null);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | undefined>(undefined);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [editingMcpServer, setEditingMcpServer] = useState<McpServerConfig | undefined>(undefined);

  useEffect(() => {
    if (!settings) void load(transport);
  }, [load, transport]); // eslint-disable-line

  useEffect(() => {
    if (preview) {
      setLocale(preview.app.locale);
      setLocalTheme(preview.app.theme);
    }
  }, [preview]);

  const hasChanges = Object.keys(dirty).length > 0;

  const handleDeleteProvider = useCallback(
    (id: string) => {
      if (!window.confirm(t("settings.providers.delete_confirm", { id }))) return;
      const current = preview?.providers ?? [];
      patch({ providers: current.filter((p) => p.id !== id) });
    },
    [preview, patch],
  );

  const handleSaveProvider = useCallback(
    (config: ProviderConfig) => {
      const current = preview?.providers ?? [];
      const idx = current.findIndex((p) => p.id === config.id);
      const next =
        idx >= 0 ? current.map((p, i) => (i === idx ? config : p)) : [...current, config];
      patch({ providers: next });
      setProviderDialogOpen(false);
      setEditingProvider(undefined);
    },
    [preview, patch],
  );

  const handleDeleteMcpServer = useCallback(
    (id: string) => {
      if (!window.confirm(t("settings.mcp.delete_confirm", { id }))) return;
      const current = preview?.mcp_servers ?? [];
      patch({ mcp_servers: current.filter((s) => s.id !== id) });
    },
    [preview, patch],
  );

  const handleSaveMcpServer = useCallback(
    (config: McpServerConfig) => {
      const current = preview?.mcp_servers ?? [];
      const idx = current.findIndex((s) => s.id === config.id);
      const next =
        idx >= 0 ? current.map((s, i) => (i === idx ? config : s)) : [...current, config];
      patch({ mcp_servers: next });
      setMcpDialogOpen(false);
      setEditingMcpServer(undefined);
    },
    [preview, patch],
  );

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      patch({
        app: {
          locale: locale as "zh-CN" | "en-US",
          theme: theme as "system" | "light" | "dark",
        },
      });
      // 立即把主题作用到 DOM；等服务端落盘也用同一值
      applyTheme(theme as "system" | "light" | "dark");
      await save(transport);
      setToast(t("settings.saved"));
      setTimeout(() => setToast(null), 2200);
    },
    [locale, theme, patch, save, transport, applyTheme],
  );

  if (!settings)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" className="text-[var(--color-fg-subtle)]" />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-8 pb-24">
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>{t("settings.preferences")}</CardTitle>
                  <CardDescription>{t("settings.preferences.desc")}</CardDescription>
                </div>
              </CardHeader>

              <div className="space-y-4">
                <SegmentedField
                  label={t("settings.language")}
                  value={locale}
                  options={[
                    { value: "zh-CN", label: t("settings.lang_zh") },
                    { value: "en-US", label: t("settings.lang_en") },
                  ]}
                  onChange={(v) => {
                    setLocale(v);
                    patch({
                      app: {
                        locale: v as "zh-CN" | "en-US",
                        theme: theme as "system" | "light" | "dark",
                      },
                    });
                  }}
                />
                <SegmentedField
                  label={t("settings.theme")}
                  value={theme}
                  options={[
                    { value: "system", label: t("theme.system") },
                    { value: "light", label: t("theme.light") },
                    { value: "dark", label: t("theme.dark") },
                  ]}
                  onChange={(v) => {
                    setLocalTheme(v);
                    applyTheme(v as "system" | "light" | "dark");
                    patch({
                      app: {
                        locale: locale as "zh-CN" | "en-US",
                        theme: v as "system" | "light" | "dark",
                      },
                    });
                  }}
                />
              </div>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex w-full items-center justify-between">
                  <div>
                    <CardTitle>{t("settings.providers.title")}</CardTitle>
                    <CardDescription>{t("settings.providers.desc")}</CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditingProvider(undefined);
                      setProviderDialogOpen(true);
                    }}
                  >
                    {t("settings.providers.add")}
                  </Button>
                </div>
              </CardHeader>

              {(preview?.providers ?? []).length === 0 ? (
                <p className="text-[12.5px] text-[var(--color-fg-subtle)] px-1 pb-1">
                  {t("settings.providers.empty")}
                </p>
              ) : (
                <div className="space-y-2">
                  {(preview?.providers ?? []).map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-medium text-[var(--color-fg)] truncate">
                          {p.id}
                        </span>
                        <span className="text-[13px] text-[var(--color-fg-muted)] truncate">
                          {p.label}
                        </span>
                        <Badge variant="info">{t(PROTOCOL_LABEL[p.protocol] ?? p.protocol)}</Badge>
                        <ApiKeyDisplay value={p.api_key} />
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingProvider(p);
                            setProviderDialogOpen(true);
                          }}
                        >
                          {t("settings.providers.edit")}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDeleteProvider(p.id)}
                        >
                          {t("settings.providers.delete")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader>
                <div className="flex w-full items-center justify-between">
                  <div>
                    <CardTitle>{t("settings.mcp.title")}</CardTitle>
                    <CardDescription>{t("settings.mcp.desc")}</CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditingMcpServer(undefined);
                      setMcpDialogOpen(true);
                    }}
                  >
                    {t("settings.mcp.add")}
                  </Button>
                </div>
              </CardHeader>

              {(preview?.mcp_servers ?? []).length === 0 ? (
                <p className="text-[12.5px] text-[var(--color-fg-subtle)] px-1 pb-1">
                  {t("settings.mcp.empty")}
                </p>
              ) : (
                <div className="space-y-2">
                  {(preview?.mcp_servers ?? []).map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-medium text-[var(--color-fg)] truncate">
                          {s.id}
                        </span>
                        <span className="text-[13px] text-[var(--color-fg-muted)] truncate">
                          {s.label}
                        </span>
                        <Badge variant={s.enabled ? "success" : "default"}>
                          {s.enabled ? t("settings.mcp.enabled") : t("settings.mcp.disabled")}
                        </Badge>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingMcpServer(s);
                            setMcpDialogOpen(true);
                          }}
                        >
                          {t("settings.mcp.edit")}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDeleteMcpServer(s.id)}
                        >
                          {t("settings.mcp.delete")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader>
                <div className="flex w-full items-center justify-between">
                  <div>
                    <CardTitle>{t("settings.export.title")}</CardTitle>
                    <CardDescription>{t("settings.export.desc")}</CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    iconLeft={<Download className="size-3.5" />}
                    onClick={() => setExportDialogOpen(true)}
                  >
                    {t("settings.export.btn")}
                  </Button>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex w-full items-center justify-between">
                  <div>
                    <CardTitle>{t("settings.import.title")}</CardTitle>
                    <CardDescription>{t("settings.import.desc")}</CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    iconLeft={<Download className="size-3.5" />}
                    onClick={() => setImportDialogOpen(true)}
                  >
                    {t("settings.import.btn")}
                  </Button>
                </div>
              </CardHeader>
            </Card>
          </form>
        </div>
      </div>

      {/* 底部工具栏（dirty 时浮起） */}
      <div
        className={cn(
          "shrink-0 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg)]/85 backdrop-blur-md",
          "transition-[transform,opacity] duration-[var(--duration-base)] ease-[var(--ease-spring)]",
          hasChanges ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0",
        )}
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-8 py-3">
          <span className="text-[13px] text-[var(--color-fg-muted)]">
            {t("settings.dirty_bar")}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={revert} disabled={saving}>
              {t("settings.dirty_revert")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void handleSubmit()}
              loading={saving}
            >
              {t("settings.dirty_save")}
            </Button>
          </div>
        </div>
      </div>

      {toast && (
        <ToastViewport>
          <Toast variant="success">{toast}</Toast>
        </ToastViewport>
      )}

      <ExportDialog open={exportDialogOpen} onClose={() => setExportDialogOpen(false)} />
      <ImportDialog open={importDialogOpen} onClose={() => setImportDialogOpen(false)} />
      <ProviderEditDialog
        open={providerDialogOpen}
        onClose={() => {
          setProviderDialogOpen(false);
          setEditingProvider(undefined);
        }}
        onSave={handleSaveProvider}
        initial={editingProvider}
        scanOllama={(baseUrl) => transport.scanOllama(baseUrl)}
      />
      <McpServerDialog
        open={mcpDialogOpen}
        onClose={() => {
          setMcpDialogOpen(false);
          setEditingMcpServer(undefined);
        }}
        onSave={handleSaveMcpServer}
        initial={editingMcpServer}
      />
    </div>
  );
}

interface SegmentedFieldProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}

function SegmentedField({ label, value, options, onChange }: SegmentedFieldProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-[13.5px] font-medium text-[var(--color-fg)]">{label}</label>
      <div
        className={cn("inline-flex rounded-[var(--radius-md)] bg-[var(--color-bg-muted)] p-0.5")}
      >
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                "rounded-[var(--radius-sm)] px-3 py-1.5 text-[12.5px] font-medium",
                "transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                active
                  ? "bg-[var(--color-bg)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ApiKeyDisplay({ value }: { value: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-fg-subtle)] font-mono shrink-0">
      <span className="max-w-[140px] truncate">
        {show ? value : "•".repeat(Math.min(value.length, 16))}
      </span>
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        tabIndex={-1}
      >
        {show ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
      </button>
    </span>
  );
}
