import { useState, useCallback, useRef } from "react";
import { Button } from "./ui/button";
import { useT } from "../lib/i18n";
import { useTransport } from "../stores/transport-context";
import { Upload, AlertTriangle } from "lucide-react";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const t = useT();
  const transport = useTransport();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"dry-run" | "merge" | "replace">("dry-run");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setResult(null);
    setError(null);
  }, []);

  const handleImport = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await transport.importProfile(file, mode);
      const tableSummary = Object.entries(res.imported.tables)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const conflictNote =
        res.conflicts.length > 0 ? `（${res.conflicts.length} 条冲突，已按策略处理）` : "";
      setResult(`已导入 ${tableSummary}${conflictNote}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("import.fail"));
    } finally {
      setLoading(false);
    }
  }, [file, mode, transport, t]);

  const handleSelectFile = useCallback(() => {
    fileRef.current?.click();
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-6 shadow-lg">
        <h2 className="text-[16px] font-semibold mb-1 text-[var(--color-fg)]">
          {t("import.title")}
        </h2>
        <p className="text-[13px] text-[var(--color-fg-muted)] mb-5">{t("import.desc")}</p>

        <label className="block text-[13px] font-medium mb-2 text-[var(--color-fg)]">
          {t("import.file_label")}
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".zip"
          onChange={handleFileChange}
          className="hidden"
        />
        <button
          type="button"
          onClick={handleSelectFile}
          className="w-full mb-5 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--color-border)] p-4 text-center text-[13px] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors cursor-pointer"
        >
          {file ? `${file.name}（${(file.size / 1024).toFixed(1)} KB）` : t("import.select_file")}
        </button>

        <label className="block text-[13px] font-medium mb-2 text-[var(--color-fg)]">
          {t("import.mode_label")}
        </label>
        <div className="space-y-2 mb-5">
          {(["dry-run", "merge", "replace"] as const).map((m) => (
            <label
              key={m}
              className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3 cursor-pointer hover:border-[var(--color-border-strong)] transition-colors"
            >
              <input
                type="radio"
                name="import-mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                className="accent-[var(--color-accent)]"
              />
              <div>
                <span className="text-[13px] font-medium text-[var(--color-fg)]">
                  {t(`import.mode_${m}`)}
                </span>
                <p className="text-[12px] text-[var(--color-fg-muted)]">
                  {t(`import.mode_${m}_desc`)}
                </p>
              </div>
            </label>
          ))}
        </div>

        {mode === "replace" && (
          <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--color-danger-soft)] border border-[var(--color-danger)]/30 flex items-start gap-2">
            <AlertTriangle className="size-4 text-[var(--color-danger)] mt-0.5 shrink-0" />
            <p className="text-[12.5px] text-[var(--color-danger)]">
              {t("import.replace_warning")}
            </p>
          </div>
        )}

        {result && (
          <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-subtle)] border border-[var(--color-border-subtle)]">
            <p className="text-[12.5px] text-[var(--color-fg)]">{result}</p>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--color-danger-soft)] border border-[var(--color-danger)]/30">
            <p className="text-[12.5px] text-[var(--color-danger)]">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t("import.close")}
          </Button>
          <Button
            onClick={() => void handleImport()}
            loading={loading}
            disabled={!file}
            iconLeft={<Upload className="size-4" />}
          >
            {t("import.btn")}
          </Button>
        </div>
      </div>
    </div>
  );
}
