import { useState, useCallback } from "react";
import { Button } from "./ui/button";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { useTransport } from "../stores/transport-context";
import { Download, Copy, Check } from "lucide-react";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

const FORMATS = [
  { value: "zip-full", labelKey: "export.format.zip" },
  { value: "markdown-snapshot", labelKey: "export.format.md" },
  { value: "json", labelKey: "export.format.json" },
] as const;

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const t = useT();
  const transport = useTransport();
  const [format, setFormat] = useState<"zip-full" | "markdown-snapshot" | "json">("zip-full");
  const [loading, setLoading] = useState(false);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResultPath(null);
    try {
      const res = await transport.exportProfile({ format });
      setResultPath(res.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("export.fail"));
    } finally {
      setLoading(false);
    }
  }, [transport, format, t]);

  const handleDownload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResultPath(null);
    try {
      const blob = await transport.exportDownload(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `knowself-export-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setResultPath("downloaded");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("export.fail"));
    } finally {
      setLoading(false);
    }
  }, [transport, format, t]);

  const handleCopy = useCallback(() => {
    if (!resultPath) return;
    navigator.clipboard.writeText(resultPath).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  }, [resultPath]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-6 shadow-lg">
        <h2 className="text-[16px] font-semibold mb-1 text-[var(--color-fg)]">
          {t("export.title")}
        </h2>
        <p className="text-[13px] text-[var(--color-fg-muted)] mb-5">{t("export.desc")}</p>

        <label className="block text-[13px] font-medium mb-2 text-[var(--color-fg)]">
          {t("export.format_label")}
        </label>
        <div className="flex gap-2 mb-5">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFormat(f.value)}
              className={cn(
                "px-3 py-1.5 text-[13px] rounded-[var(--radius-md)] border transition-colors cursor-pointer",
                format === f.value
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]",
              )}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>

        {resultPath && (
          <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-subtle)] border border-[var(--color-border-subtle)]">
            <p className="text-[12.5px] text-[var(--color-fg)] mb-2 break-all">
              {resultPath === "downloaded"
                ? t("export.downloaded")
                : t("export.exported_to", { path: resultPath })}
            </p>
            <div className="flex gap-2">
              {resultPath !== "downloaded" && (
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  onClick={handleCopy}
                >
                  {copied ? t("export.copied") : t("export.copy")}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Download className="size-3.5" />}
                onClick={() => void handleDownload()}
              >
                {t("export.download_btn")}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--color-danger-soft)] border border-[var(--color-danger)]/30">
            <p className="text-[12.5px] text-[var(--color-danger)]">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t("export.close")}
          </Button>
          <Button
            onClick={() => void handleExport()}
            loading={loading}
            iconLeft={<Download className="size-4" />}
          >
            {t("export.btn")}
          </Button>
        </div>
      </div>
    </div>
  );
}
