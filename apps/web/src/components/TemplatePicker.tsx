import { useState, useCallback, useEffect, useRef } from "react";
import { FileSpreadsheet, ChevronDown, Play } from "lucide-react";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { useTransport } from "../stores/transport-context";
import { useTemplateStore } from "../stores/templates";
import type { TemplateRecord, TemplateVariable } from "@knowself/contracts";

interface TemplatePickerProps {
  onInsert: (text: string) => void;
}

export function TemplatePicker({ onInsert }: TemplatePickerProps) {
  const t = useT();
  const transport = useTransport();
  const templates = useTemplateStore((s) => s.templates);
  const fetchTemplates = useTemplateStore((s) => s.fetchTemplates);
  const buildPrompt = useTemplateStore((s) => s.buildPrompt);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<TemplateRecord | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && templates.length === 0) {
      void fetchTemplates(transport);
    }
  }, [open, templates.length, fetchTemplates, transport]);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setValues({});
      setResult(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = useCallback((tmpl: TemplateRecord) => {
    setSelected(tmpl);
    setValues({});
    setResult(null);
    setError(null);
    const initial: Record<string, string> = {};
    for (const v of tmpl.variables) {
      initial[v.key] = "";
    }
    setValues(initial);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selected) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await buildPrompt(selected.id, values, "", transport);
      const text = res.user_message.trim() || res.system_prompt.trim();
      if (!text) {
        setResult(null);
        setError(t("templates.picker.empty_result"));
        return;
      }
      setResult(text);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : t("templates.picker.generate_fail"));
    } finally {
      setGenerating(false);
    }
  }, [selected, values, buildPrompt, transport, t]);

  const handleUse = useCallback(() => {
    const text = result?.trim();
    if (text) {
      onInsert(text);
      setOpen(false);
    }
  }, [result, onInsert]);

  const handleBackToList = useCallback(() => {
    setSelected(null);
    setValues({});
    setResult(null);
    setError(null);
  }, []);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[11px] font-medium",
          "bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]",
          "transition-[background-color,color] duration-[var(--duration-fast)]",
        )}
      >
        <FileSpreadsheet className="size-3.5" />
        {t("templates.picker.btn")}
        <ChevronDown className="size-3" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute bottom-full left-0 mb-2 z-50 w-[340px]",
            "rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] shadow-lg",
          )}
        >
          {!selected ? (
            <div className="max-h-[300px] overflow-y-auto p-2">
              {templates.length === 0 && (
                <p className="px-2 py-4 text-[12.5px] text-[var(--color-fg-muted)] text-center">
                  {t("templates.picker.placeholder")}
                </p>
              )}
              {templates.map((tmpl) => (
                <button
                  key={tmpl.id}
                  type="button"
                  onClick={() => handleSelect(tmpl)}
                  className="w-full text-left px-3 py-2.5 rounded-[var(--radius-md)] hover:bg-[var(--color-bg-muted)]"
                >
                  <div className="text-[13px] font-medium text-[var(--color-fg)]">
                    {tmpl.name}
                    {tmpl.id.startsWith("builtin-") && (
                      <span className="ml-1.5 text-[10px] text-[var(--color-fg-subtle)]">
                        ({t("templates.builtin_badge")})
                      </span>
                    )}
                  </div>
                  {tmpl.description && (
                    <div className="mt-0.5 text-[11.5px] text-[var(--color-fg-muted)] line-clamp-2">
                      {tmpl.description}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-[13px] font-semibold text-[var(--color-fg)]">
                  {selected.name}
                </h4>
                <button
                  type="button"
                  onClick={handleBackToList}
                  className="text-[11px] text-[var(--color-accent)] hover:underline"
                >
                  {t("templates.dialog.cancel")}
                </button>
              </div>

              <div className="space-y-3">
                {selected.variables.map((v) => (
                  <VariableInput
                    key={v.key}
                    variable={v}
                    value={values[v.key] ?? ""}
                    onChange={(val) => setValues((prev) => ({ ...prev, [v.key]: val }))}
                  />
                ))}

                {result !== null && (
                  <div className="p-2.5 rounded-[var(--radius-md)] bg-[var(--color-bg-subtle)] border border-[var(--color-border-subtle)]">
                    <div className="text-[11px] text-[var(--color-fg-muted)] mb-1">
                      {t("templates.picker.result")}
                    </div>
                    <div className="text-[12px] text-[var(--color-fg)] whitespace-pre-wrap max-h-[80px] overflow-y-auto">
                      {result}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] px-2.5 py-2 text-[12px] text-[var(--color-danger)]">
                    {error}
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleGenerate()}
                    disabled={generating}
                    className={cn(
                      "flex-1 inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-[12px] font-medium",
                      "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  >
                    <Play className="size-3.5" />
                    {generating ? "..." : t("templates.picker.generate")}
                  </button>
                  {result?.trim() && (
                    <button
                      type="button"
                      onClick={handleUse}
                      className={cn(
                        "flex-1 inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-[12px] font-medium",
                        "bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white",
                      )}
                    >
                      {t("templates.dialog.save")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VariableInput({
  variable,
  value,
  onChange,
}: {
  variable: TemplateVariable;
  value: string;
  onChange: (val: string) => void;
}) {
  const label = variable.label || variable.key;

  if (variable.type === "select" && variable.options) {
    return (
      <div>
        <label className="block text-[11.5px] font-medium text-[var(--color-fg-muted)] mb-1">
          {label}
          {variable.required && <span className="text-[var(--color-danger)] ml-0.5">*</span>}
        </label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-fg)]"
        >
          <option value="">—</option>
          {variable.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (variable.type === "textarea") {
    return (
      <div>
        <label className="block text-[11.5px] font-medium text-[var(--color-fg-muted)] mb-1">
          {label}
          {variable.required && <span className="text-[var(--color-danger)] ml-0.5">*</span>}
        </label>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-fg)] resize-none"
        />
      </div>
    );
  }

  return (
    <div>
      <label className="block text-[11.5px] font-medium text-[var(--color-fg-muted)] mb-1">
        {label}
        {variable.required && <span className="text-[var(--color-danger)] ml-0.5">*</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-fg)]"
      />
    </div>
  );
}
