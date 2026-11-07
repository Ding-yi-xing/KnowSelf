import { useState, useEffect, useCallback, type ReactNode } from "react";
import type { McpServerConfig } from "@knowself/contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useT } from "../lib/i18n";

interface McpServerDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (config: McpServerConfig) => void;
  initial?: McpServerConfig | undefined;
}

export function McpServerDialog({ open, onClose, onSave, initial }: McpServerDialogProps) {
  const t = useT();
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<"stdio" | "streamable_http">("stdio");
  const [command, setCommand] = useState("");
  const [argsStr, setArgsStr] = useState("");
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [purpose, setPurpose] = useState("");
  const [startupTimeoutMs, setStartupTimeoutMs] = useState(30000);
  const [requestTimeoutMs, setRequestTimeoutMs] = useState(60000);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setId(initial.id);
      setLabel(initial.label);
      setTransport(initial.transport_config.transport);
      if (initial.transport_config.transport === "stdio") {
        setCommand(initial.transport_config.command);
        setArgsStr(initial.transport_config.args.join(", "));
        setUrl("");
      } else {
        setCommand("");
        setArgsStr("");
        setUrl(initial.transport_config.url);
      }
      setEnabled(initial.enabled);
      setPurpose(initial.purpose);
      setStartupTimeoutMs(initial.startup_timeout_ms);
      setRequestTimeoutMs(initial.request_timeout_ms);
    } else {
      setId("");
      setLabel("");
      setTransport("stdio");
      setCommand("");
      setArgsStr("");
      setUrl("");
      setEnabled(true);
      setPurpose("");
      setStartupTimeoutMs(30000);
      setRequestTimeoutMs(60000);
    }
    setErrors({});
  }, [open, initial]);

  const validate = useCallback((): boolean => {
    const errs: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !id) errs.id = t("settings.mcp_dialog.err_id");
    if (id.length > 48) errs.id = t("settings.mcp_dialog.err_label");
    if (id.includes("__")) errs.id = t("settings.mcp_dialog.err_no_double_underscore");
    if (!label || label.length > 64) errs.label = t("settings.mcp_dialog.err_name");
    if (transport === "stdio") {
      if (!command) errs.command = t("settings.mcp_dialog.err_command");
    } else {
      if (!url) errs.url = t("settings.mcp_dialog.err_url");
      try {
        new URL(url);
      } catch {
        errs.url = t("settings.mcp_dialog.err_url_invalid");
      }
    }
    if (purpose.length > 64) errs.purpose = t("settings.mcp_dialog.err_purpose");
    if (isNaN(startupTimeoutMs) || startupTimeoutMs < 5000 || startupTimeoutMs > 120000)
      errs.startupTimeoutMs = "5000-120000";
    if (isNaN(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 600000)
      errs.requestTimeoutMs = "1000-600000";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }, [id, label, transport, command, url, purpose, startupTimeoutMs, requestTimeoutMs]);

  const handleSave = useCallback(() => {
    if (!validate()) return;

    const args = argsStr
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    let transportConfig: McpServerConfig["transport_config"];

    if (transport === "stdio") {
      const env: Record<string, string> = {};
      let cwd: string | undefined;
      if (initial) {
        const tc = initial.transport_config;
        if (tc.transport === "stdio") {
          Object.assign(env, tc.env);
          cwd = tc.cwd;
        }
      }
      transportConfig = {
        transport: "stdio",
        command,
        args,
        env,
        ...(cwd !== undefined ? { cwd } : {}),
      };
    } else {
      const headers: Record<string, string> = {};
      let authToken: string | undefined;
      if (initial) {
        const tc = initial.transport_config;
        if (tc.transport === "streamable_http") {
          Object.assign(headers, tc.headers);
          authToken = tc.auth_token;
        }
      }
      transportConfig = {
        transport: "streamable_http",
        url,
        headers,
        ...(authToken !== undefined ? { auth_token: authToken } : {}),
      };
    }

    onSave({
      id,
      label,
      transport_config: transportConfig,
      enabled,
      purpose,
      startup_timeout_ms: startupTimeoutMs,
      request_timeout_ms: requestTimeoutMs,
      max_concurrency: initial?.max_concurrency ?? 4,
      restart_on_crash: initial?.restart_on_crash ?? true,
      max_restarts: initial?.max_restarts ?? 3,
      dead_cooldown_ms: initial?.dead_cooldown_ms ?? 300_000,
    });
  }, [
    id,
    label,
    transport,
    command,
    argsStr,
    url,
    enabled,
    purpose,
    startupTimeoutMs,
    requestTimeoutMs,
    initial,
    onSave,
    validate,
  ]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-6 shadow-lg max-h-[80vh] overflow-y-auto">
        <h2 className="text-[16px] font-semibold mb-4 text-[var(--color-fg)]">
          {initial ? t("settings.mcp_dialog.title_edit") : t("settings.mcp_dialog.title_new")}
        </h2>
        <div className="space-y-4">
          <Field label={t("settings.mcp_dialog.id")} error={errors.id}>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-server"
              maxLength={48}
            />
          </Field>
          <Field label={t("settings.mcp_dialog.name")} error={errors.label}>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("settings.mcp_dialog.name_placeholder")}
              maxLength={64}
            />
          </Field>
          <div>
            <label className="block text-[13px] font-medium mb-1.5 text-[var(--color-fg)]">
              {t("settings.mcp_dialog.transport")}
            </label>
            <div className="flex gap-2">
              {(["stdio", "streamable_http"] as const).map((tItem) => (
                <button
                  key={tItem}
                  type="button"
                  onClick={() => setTransport(tItem)}
                  className={`px-3 py-1.5 text-[13px] rounded-[var(--radius-md)] border transition-colors cursor-pointer ${
                    transport === tItem
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                      : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  {tItem === "stdio"
                    ? t("settings.mcp_dialog.stdio")
                    : t("settings.mcp_dialog.http")}
                </button>
              ))}
            </div>
          </div>
          {transport === "stdio" ? (
            <>
              <Field label={t("settings.mcp_dialog.command")} error={errors.command}>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                />
              </Field>
              <Field label={t("settings.mcp_dialog.args")} error={undefined}>
                <Input
                  value={argsStr}
                  onChange={(e) => setArgsStr(e.target.value)}
                  placeholder={t("settings.mcp_dialog.args_placeholder")}
                />
              </Field>
            </>
          ) : (
            <Field label={t("settings.mcp_dialog.url")} error={errors.url}>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                type="url"
              />
            </Field>
          )}
          <label className="flex items-center gap-1.5 text-[13px] cursor-pointer text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            {t("settings.mcp_dialog.enabled")}
          </label>
          <Field label={t("settings.mcp_dialog.purpose")} error={errors.purpose}>
            <Input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="primary_web_reader"
              maxLength={64}
            />
          </Field>
          <Field label={t("settings.mcp_dialog.startup_timeout")} error={errors.startupTimeoutMs}>
            <Input
              value={startupTimeoutMs}
              onChange={(e) => setStartupTimeoutMs(Number(e.target.value))}
              type="number"
              min={5000}
              max={120000}
            />
          </Field>
          <Field label={t("settings.mcp_dialog.request_timeout")} error={errors.requestTimeoutMs}>
            <Input
              value={requestTimeoutMs}
              onChange={(e) => setRequestTimeoutMs(Number(e.target.value))}
              type="number"
              min={1000}
              max={600000}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 mt-6 pt-2 border-t border-[var(--color-border-subtle)]">
          <Button variant="ghost" onClick={onClose}>
            {t("settings.mcp_dialog.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("settings.mcp_dialog.save")}</Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-[13px] font-medium mb-1.5 text-[var(--color-fg)]">{label}</label>
      {children}
      {error && <p className="text-[12px] text-[var(--color-danger)] mt-1">{error}</p>}
    </div>
  );
}
