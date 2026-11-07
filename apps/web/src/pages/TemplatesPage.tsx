import { useState, useCallback, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { useTransport } from "../stores/transport-context";
import { useTemplateStore } from "../stores/templates";
import type { TemplateRecord, TemplateVariable } from "@knowself/contracts";

export function TemplatesPage() {
  const t = useT();
  const transport = useTransport();
  const templates = useTemplateStore((s) => s.templates);
  const fetchTemplates = useTemplateStore((s) => s.fetchTemplates);
  const deleteTemplate = useTemplateStore((s) => s.deleteTemplate);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void fetchTemplates(transport);
  }, [fetchTemplates, transport]);

  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(id);
    }
  }, [toast]);

  const builtins = templates.filter((t) => t.id.startsWith("builtin-"));
  const customs = templates.filter((t) => !t.id.startsWith("builtin-"));

  const handleDelete = useCallback(
    async (id: string) => {
      if (id.startsWith("builtin-")) {
        setToast(t("templates.delete_builtin_fail"));
        return;
      }
      try {
        await deleteTemplate(id, transport);
        setToast(t("templates.toast.deleted"));
      } catch {
        setToast(t("templates.delete_builtin_fail"));
      }
      setDeleteConfirm(null);
    },
    [deleteTemplate, transport, t],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto px-6 py-6">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h1 className="text-[18.5px] font-semibold text-[var(--color-fg)] leading-tight">
            {t("templates.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-fg-muted)]">
            {t("templates.subtitle")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-white px-3 py-1.5 text-[13px] font-medium hover:bg-[var(--color-accent-hover)]"
        >
          <Plus className="size-4" />
          {t("templates.new")}
        </button>
      </div>

      {/* 内置模板 */}
      <section className="mt-6">
        <h2 className="text-[13px] font-semibold text-[var(--color-fg-muted)] uppercase tracking-wide mb-3">
          {t("templates.builtin")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {builtins.map((tmpl) => (
            <TemplateCard key={tmpl.id} template={tmpl} builtin />
          ))}
        </div>
      </section>

      {/* 自定义模板 */}
      <section className="mt-6">
        <h2 className="text-[13px] font-semibold text-[var(--color-fg-muted)] uppercase tracking-wide mb-3">
          {t("templates.custom")}
        </h2>
        {customs.length === 0 ? (
          <p className="text-[13px] text-[var(--color-fg-subtle)] py-4 text-center">
            {t("templates.empty")}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {customs.map((tmpl) => (
              <TemplateCard
                key={tmpl.id}
                template={tmpl}
                onDelete={() => setDeleteConfirm(tmpl.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 新建模板 Dialog */}
      {dialogOpen && (
        <CreateTemplateDialog
          onClose={() => setDialogOpen(false)}
          onCreated={() => {
            setDialogOpen(false);
            setToast(t("templates.toast.created"));
            void fetchTemplates(transport);
          }}
        />
      )}

      {/* 删除确认 Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setDeleteConfirm(null)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-6 shadow-lg">
            <p className="text-[14px] text-[var(--color-fg)] mb-5">
              {t("templates.delete_confirm", {
                name: templates.find((t) => t.id === deleteConfirm)?.name ?? deleteConfirm,
              })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-[13px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              >
                {t("templates.dialog.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(deleteConfirm)}
                className="px-3 py-1.5 text-[13px] font-medium text-white bg-[var(--color-danger)] rounded-[var(--radius-md)] hover:opacity-90"
              >
                {t("import.btn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-4 py-2.5 shadow-lg text-[13px] text-[var(--color-fg)]">
          {toast}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  builtin,
  onDelete,
}: {
  template: TemplateRecord;
  builtin?: boolean;
  onDelete?: () => void;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--color-border-subtle)] p-4",
        "bg-[var(--color-bg-subtle)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[13.5px] font-semibold text-[var(--color-fg)] truncate">
              {template.name}
            </h3>
            {builtin && (
              <span className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--color-bg-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-subtle)] font-medium">
                {t("templates.builtin_badge")}
              </span>
            )}
          </div>
          {template.description && (
            <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)] line-clamp-2">
              {template.description}
            </p>
          )}
        </div>
        {!builtin && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="shrink-0 grid size-7 place-items-center rounded-[var(--radius-md)] text-[var(--color-fg-subtle)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {template.variables.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {template.variables.map((v) => (
            <span
              key={v.key}
              className="rounded-[var(--radius-pill)] bg-[var(--color-bg)] border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)]"
            >
              {`{{${v.key}}}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTemplateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const transport = useTransport();
  const createTemplate = useTemplateStore((s) => s.createTemplate);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPromptInject, setSystemPromptInject] = useState("");
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [saving, setSaving] = useState(false);

  const handleAddVar = useCallback(() => {
    setVariables((prev) => [
      ...prev,
      { key: "", label: "", type: "text" as const, required: true },
    ]);
  }, []);

  const handleVarChange = useCallback((index: number, field: string, val: string | boolean) => {
    setVariables((prev) => {
      const next = [...prev];
      next[index] = { ...next[index]!, [field]: val };
      return next;
    });
  }, []);

  const handleRemoveVar = useCallback((index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const id = `custom-${Date.now()}`;
      await createTemplate(
        {
          id,
          name: name.trim(),
          description: description.trim(),
          system_prompt_inject: systemPromptInject,
          variables: variables.map((v) => ({
            ...v,
            key: v.key || v.label,
            required: v.required ?? true,
          })),
        },
        transport,
      );
      onCreated();
    } finally {
      setSaving(false);
    }
  }, [name, description, systemPromptInject, variables, createTemplate, transport, onCreated]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-6 shadow-lg max-h-[70vh] overflow-y-auto">
        <h2 className="text-[16px] font-semibold mb-4 text-[var(--color-fg)]">
          {t("templates.dialog.title")}
        </h2>

        <div className="space-y-4">
          <div>
            <label className="block text-[12.5px] font-medium text-[var(--color-fg-muted)] mb-1">
              {t("templates.dialog.name")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("templates.dialog.name_placeholder")}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-fg)]"
            />
          </div>

          <div>
            <label className="block text-[12.5px] font-medium text-[var(--color-fg-muted)] mb-1">
              {t("templates.dialog.desc")}
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("templates.dialog.desc_placeholder")}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-fg)]"
            />
          </div>

          <div>
            <label className="block text-[12.5px] font-medium text-[var(--color-fg-muted)] mb-1">
              {t("templates.dialog.system_prompt")}
            </label>
            <textarea
              value={systemPromptInject}
              onChange={(e) => setSystemPromptInject(e.target.value)}
              placeholder={t("templates.dialog.system_prompt_placeholder")}
              rows={3}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] resize-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12.5px] font-medium text-[var(--color-fg-muted)]">
                {t("templates.dialog.variables")}
              </span>
              <button
                type="button"
                onClick={handleAddVar}
                className="text-[11px] text-[var(--color-accent)] hover:underline"
              >
                + {t("templates.dialog.add_var")}
              </button>
            </div>
            <div className="space-y-2">
              {variables.map((v, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] p-2"
                >
                  <input
                    type="text"
                    value={v.key}
                    onChange={(e) => handleVarChange(i, "key", e.target.value)}
                    placeholder={t("templates.dialog.var_key")}
                    className="w-20 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11px] text-[var(--color-fg)]"
                  />
                  <input
                    type="text"
                    value={v.label}
                    onChange={(e) => handleVarChange(i, "label", e.target.value)}
                    placeholder={t("templates.dialog.var_label")}
                    className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11px] text-[var(--color-fg)]"
                  />
                  <select
                    value={v.type}
                    onChange={(e) => handleVarChange(i, "type", e.target.value)}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-1 text-[10px] text-[var(--color-fg)]"
                  >
                    <option value="text">text</option>
                    <option value="textarea">textarea</option>
                    <option value="select">select</option>
                  </select>
                  <label className="flex items-center gap-1 text-[10px] text-[var(--color-fg-muted)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={v.required ?? true}
                      onChange={(e) => handleVarChange(i, "required", e.target.checked)}
                      className="size-3"
                    />
                    {t("templates.dialog.var_required")}
                  </label>
                  <button
                    type="button"
                    onClick={() => handleRemoveVar(i)}
                    className="shrink-0 text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6 pt-2 border-t border-[var(--color-border-subtle)]">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[13px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            {t("templates.dialog.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="px-3 py-1.5 text-[13px] font-medium text-white bg-[var(--color-accent)] rounded-[var(--radius-md)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "..." : t("templates.dialog.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
