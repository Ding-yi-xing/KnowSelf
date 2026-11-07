import { useState, useEffect, useCallback, type ReactNode } from "react";
import type { ProviderConfig } from "@knowself/contracts";
import { Button } from "./ui/button";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./ui/input";
import { useT } from "../lib/i18n";

const PROTOCOLS = ["openai", "anthropic", "custom"] as const;
const PROTOCOL_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  custom: "settings.provider_dialog.protocol_custom",
};
const ALL_PURPOSES = ["chat", "rerank", "classify", "distill", "embed"] as const;
const PURPOSE_LABEL: Record<string, string> = {
  chat: "settings.provider_dialog.purpose_chat",
  rerank: "settings.provider_dialog.purpose_rerank",
  classify: "settings.provider_dialog.purpose_classify",
  distill: "settings.provider_dialog.purpose_distill",
  embed: "settings.provider_dialog.purpose_embed",
};

interface ProviderEditDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (config: ProviderConfig) => void;
  initial?: ProviderConfig | undefined;
  scanOllama?: (baseUrl?: string) => Promise<{ state: string; models: string[] }>;
}

export function ProviderEditDialog({
  open,
  onClose,
  onSave,
  initial,
  scanOllama,
}: ProviderEditDialogProps) {
  const t = useT();
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<"openai" | "anthropic" | "custom">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState("");
  const [purposes, setPurposes] = useState<Set<string>>(new Set());
  const [declaredSupportsTools, setDeclaredSupportsTools] = useState(false);
  const [declaredSupportsCaching, setDeclaredSupportsCaching] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ollamaScanning, setOllamaScanning] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setOllamaModels([]);
    setOllamaError(null);
    setOllamaScanning(false);
    setShowApiKey(false);
    if (initial) {
      setId(initial.id);
      setLabel(initial.label);
      setProtocol(initial.protocol);
      setBaseUrl(initial.base_url);
      setApiKey(initial.api_key);
      setModel(initial.model);
      setPurposes(new Set(initial.purposes));
      setDeclaredSupportsTools(initial.declared_supports_tools);
      setDeclaredSupportsCaching(initial.declared_supports_caching);
    } else {
      setId("");
      setLabel("");
      setProtocol("openai");
      setBaseUrl("");
      setApiKey("");
      setModel("");
      setPurposes(new Set());
      setDeclaredSupportsTools(false);
      setDeclaredSupportsCaching(false);
    }
    setErrors({});
  }, [open, initial]);

  const togglePurpose = useCallback((p: string) => {
    setPurposes((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  }, []);

  const handleScanOllama = useCallback(async () => {
    if (!scanOllama) return;
    setOllamaScanning(true);
    setOllamaError(null);
    setOllamaModels([]);
    try {
      const result = await scanOllama();
      if (result.state === "healthy" && result.models.length > 0) {
        setId("ollama");
        setLabel("Ollama Local");
        setProtocol("openai");
        setBaseUrl("http://localhost:11434/v1");
        setOllamaModels(result.models);
      } else {
        setOllamaError(t("settings.provider_dialog.ollama_not_found"));
      }
    } catch {
      setOllamaError(t("settings.provider_dialog.ollama_not_found"));
    } finally {
      setOllamaScanning(false);
    }
  }, [scanOllama]);

  const validate = useCallback((): boolean => {
    const errs: Record<string, string> = {};
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || !id) errs.id = t("settings.provider_dialog.err_id");
    if (id.length > 64) errs.id = t("settings.provider_dialog.err_label");
    if (!label || label.length > 64) errs.label = t("settings.provider_dialog.err_label");
    if (!baseUrl) errs.baseUrl = t("settings.provider_dialog.err_base_url");
    try {
      new URL(baseUrl);
    } catch {
      errs.baseUrl = t("settings.provider_dialog.err_url_invalid");
    }
    if (!apiKey || apiKey.length > 512) errs.apiKey = t("settings.provider_dialog.err_api_key");
    if (!model || model.length > 128) errs.model = t("settings.provider_dialog.err_model");
    if (purposes.size === 0) errs.purposes = t("settings.provider_dialog.err_purposes");
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }, [id, label, baseUrl, apiKey, model, purposes]);

  const handleSave = useCallback(() => {
    if (!validate()) return;
    onSave({
      id,
      label,
      protocol,
      base_url: baseUrl,
      api_key: apiKey,
      model,
      purposes: Array.from(purposes) as ProviderConfig["purposes"],
      default_for: initial?.default_for ?? [],
      request_timeout_ms: initial?.request_timeout_ms ?? 120_000,
      max_retries: initial?.max_retries ?? 2,
      max_concurrency: initial?.max_concurrency ?? 4,
      extra_headers: initial?.extra_headers ?? {},
      declared_supports_tools: declaredSupportsTools,
      declared_supports_caching: declaredSupportsCaching,
      tags: initial?.tags ?? [],
    });
  }, [
    id,
    label,
    protocol,
    baseUrl,
    apiKey,
    model,
    purposes,
    declaredSupportsTools,
    declaredSupportsCaching,
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
          {initial
            ? t("settings.provider_dialog.title_edit")
            : t("settings.provider_dialog.title_new")}
        </h2>
        <div className="space-y-4">
          <Field label={t("settings.provider_dialog.id")} error={errors.id}>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-provider"
              maxLength={64}
            />
          </Field>
          <Field label={t("settings.provider_dialog.name")} error={errors.label}>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("settings.provider_dialog.name_placeholder")}
              maxLength={64}
            />
          </Field>
          <div>
            <label className="block text-[13px] font-medium mb-1.5 text-[var(--color-fg)]">
              {t("settings.provider_dialog.protocol")}
            </label>
            <div className="flex gap-2">
              {PROTOCOLS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProtocol(p)}
                  className={`px-3 py-1.5 text-[13px] rounded-[var(--radius-md)] border transition-colors cursor-pointer ${
                    protocol === p
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                      : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  {t(PROTOCOL_LABEL[p] ?? p)}
                </button>
              ))}
            </div>
          </div>
          {scanOllama && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleScanOllama()}
                disabled={ollamaScanning}
              >
                {ollamaScanning
                  ? t("settings.provider_dialog.ollama_scanning")
                  : t("settings.provider_dialog.ollama_btn")}
              </Button>
              {ollamaError && (
                <span className="text-[12px] text-[var(--color-danger)]">{ollamaError}</span>
              )}
            </div>
          )}
          <Field label={t("settings.provider_dialog.base_url")} error={errors.baseUrl}>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              type="url"
            />
          </Field>
          <Field label={t("settings.provider_dialog.api_key")} error={errors.apiKey}>
            <div className="relative">
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                type={showApiKey ? "text" : "password"}
                maxLength={512}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
          <Field label={t("settings.provider_dialog.model")} error={errors.model}>
            {ollamaModels.length > 0 ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">{t("settings.provider_dialog.ollama_select_model")}</option>
                {ollamaModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o"
                maxLength={128}
              />
            )}
          </Field>
          <div>
            <label className="block text-[13px] font-medium mb-1.5 text-[var(--color-fg)]">
              {t("settings.provider_dialog.purposes")}
            </label>
            {errors.purposes && (
              <p className="text-[12px] text-[var(--color-danger)] mb-1.5">{errors.purposes}</p>
            )}
            <div className="flex flex-wrap gap-3">
              {ALL_PURPOSES.map((p) => (
                <label
                  key={p}
                  className="flex items-center gap-1.5 text-[13px] cursor-pointer text-[var(--color-fg)]"
                >
                  <input
                    type="checkbox"
                    checked={purposes.has(p)}
                    onChange={() => togglePurpose(p)}
                    className="accent-[var(--color-accent)]"
                  />
                  {t(PURPOSE_LABEL[p] ?? p)}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-4 pt-1">
            <label className="flex items-center gap-1.5 text-[13px] cursor-pointer text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={declaredSupportsTools}
                onChange={(e) => setDeclaredSupportsTools(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              {t("settings.provider_dialog.support_tools")}
            </label>
            <label className="flex items-center gap-1.5 text-[13px] cursor-pointer text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={declaredSupportsCaching}
                onChange={(e) => setDeclaredSupportsCaching(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              {t("settings.provider_dialog.support_caching")}
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6 pt-2 border-t border-[var(--color-border-subtle)]">
          <Button variant="ghost" onClick={onClose}>
            {t("settings.provider_dialog.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("settings.provider_dialog.save")}</Button>
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
