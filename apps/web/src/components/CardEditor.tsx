/**
 * CardEditor — 卡片编辑表单（title / summary / sections）。
 * 视觉：每段 section 一张子卡片，添加/删除微动画。
 */
import { useState, useCallback, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CardStored } from "@knowself/contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Card } from "./ui/card";
import { useT } from "../lib/i18n";

interface CardEditorProps {
  initial?: CardStored | null;
  onSave: (data: {
    title: string;
    summary: string;
    sections: { title: string; body: string }[];
  }) => void;
  onCancel: () => void;
  saving: boolean;
}

export function CardEditor({ initial, onSave, onCancel, saving }: CardEditorProps) {
  const t = useT();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [sections, setSections] = useState(
    initial
      ? ((initial as unknown as { sections?: { title: string; body: string }[] }).sections?.map(
          (s) => ({ title: s.title, body: s.body }),
        ) ?? [])
      : [],
  );

  const addSection = useCallback(() => {
    setSections((prev) => [...prev, { title: "", body: "" }]);
  }, []);

  const updateSection = useCallback((i: number, field: "title" | "body", value: string) => {
    setSections((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  }, []);

  const removeSection = useCallback((i: number) => {
    setSections((prev) => prev.filter((_, idx) => idx !== i));
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      // 若 summary 为空，用 title 前 30 字兜底（§5.4 方案 b，不动契约 schema）
      const fallbackSummary = summary.trim() || title.slice(0, 30);
      onSave({ title, summary: fallbackSummary, sections });
    },
    [title, summary, sections, onSave],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <label className="text-[13px] font-medium text-[var(--color-fg)]">
          {t("card_editor.title")}
        </label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          placeholder={t("card_editor.title_placeholder")}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[13px] font-medium text-[var(--color-fg)]">
          {t("card_editor.summary")}
        </label>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          placeholder={t("card_editor.summary_placeholder")}
        />
      </div>

      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <label className="text-[13px] font-medium text-[var(--color-fg)]">
            {t("card_editor.sections", { n: String(sections.length) })}{" "}
            <span className="ml-1 text-[12px] text-[var(--color-fg-subtle)]">
              {sections.length}
            </span>
          </label>
          <Button
            type="button"
            variant="subtle"
            size="sm"
            onClick={addSection}
            iconLeft={<Plus className="size-3.5" strokeWidth={2.4} />}
          >
            {t("card_editor.add_section")}
          </Button>
        </div>

        {sections.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] py-6 text-center text-[12.5px] text-[var(--color-fg-subtle)]">
            {t("card_editor.no_sections")}
          </p>
        ) : (
          <div className="space-y-2.5">
            {sections.map((sec, i) => (
              <Card key={i} compact className="fade-in space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={sec.title}
                    onChange={(e) => updateSection(i, "title", e.target.value)}
                    placeholder={t("card_editor.section_title_placeholder")}
                    className="h-8 text-[13px]"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeSection(i)}
                    aria-label={t("card_editor.delete_section_aria")}
                    className="text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 className="size-4" strokeWidth={2} />
                  </Button>
                </div>
                <Textarea
                  value={sec.body}
                  onChange={(e) => updateSection(i, "body", e.target.value)}
                  placeholder={t("card_editor.section_body_placeholder")}
                  rows={3}
                  className="text-[13px]"
                />
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--color-border-subtle)] pt-5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t("card_editor.cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {t("card_editor.save")}
        </Button>
      </div>
    </form>
  );
}
