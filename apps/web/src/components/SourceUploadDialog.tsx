import { useState, useRef, type FC } from "react";
import { Upload, Link, FileText, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ProgressBar } from "./ui/progress-bar";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import type { SourceCreateInput } from "../transport/types";

interface SourceUploadDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: SourceCreateInput) => Promise<void>;
  uploadProgress?: number | null;
}

type TabKind = "file" | "url" | "paste";

const TABS: { id: TabKind; labelKey: string; icon: typeof Upload }[] = [
  { id: "file", labelKey: "sources.upload.tab.file", icon: Upload },
  { id: "url", labelKey: "sources.upload.tab.url", icon: Link },
  { id: "paste", labelKey: "sources.upload.tab.paste", icon: FileText },
];

export const SourceUploadDialog: FC<SourceUploadDialogProps> = ({
  open,
  onClose,
  onSubmit,
  uploadProgress,
}) => {
  const [tab, setTab] = useState<TabKind>("file");
  const [file, setFile] = useState<File | null>(null);
  const [fileNote, setFileNote] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [textName, setTextName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();

  if (!open) return null;

  const handleSubmit = async () => {
    let input: SourceCreateInput;
    switch (tab) {
      case "file":
        if (!file) return;
        input = { kind: "file", file, original_name: file.name };
        if (fileNote.trim()) input.user_note = fileNote.trim();
        break;
      case "url": {
        if (!url.trim()) return;
        const urlInput: SourceCreateInput = { kind: "url", url: url.trim() };
        if (description) (urlInput as Record<string, unknown>).user_note = description;
        input = urlInput;
        break;
      }
      case "paste": {
        if (!text.trim()) return;
        const pasteInput: SourceCreateInput = { kind: "paste", text: text.trim() };
        if (textName) (pasteInput as Record<string, unknown>).original_name = textName;
        input = pasteInput;
        break;
      }
    }
    setSubmitting(true);
    try {
      await onSubmit(input);
      onClose();
      setFile(null);
      setFileNote("");
      setUrl("");
      setDescription("");
      setText("");
      setTextName("");
      setTab("file");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-6 shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">{t("sources.upload.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-sm)] p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>

        <div className="mb-5 flex gap-1 rounded-[var(--radius-md)] bg-[var(--color-bg-muted)] p-1">
          {TABS.map((tabItem) => {
            const active = tab === tabItem.id;
            const Icon = tabItem.icon;
            return (
              <button
                key={tabItem.id}
                type="button"
                onClick={() => setTab(tabItem.id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition",
                  active
                    ? "bg-[var(--color-bg)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                <Icon className="size-3.5" strokeWidth={2} />
                {t(tabItem.labelKey)}
              </button>
            );
          })}
        </div>

        {tab === "file" && (
          <div className="space-y-3">
            <div
              className="flex cursor-pointer flex-col items-center gap-3 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--color-border)] p-8 text-center hover:border-[var(--color-accent)]"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-8 text-[var(--color-fg-subtle)]" strokeWidth={1.5} />
              <div>
                <p className="text-[14px] font-medium text-[var(--color-fg)]">
                  {file ? file.name : t("sources.upload.file_btn")}
                </p>
                <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)]">
                  .md .txt .pdf .docx .html .csv .xlsx .png .jpg .webp .gif
                </p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.txt,.pdf,.docx,.html,.htm,.csv,.xlsx,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <Textarea
              placeholder={t("sources.upload.notes_placeholder")}
              rows={3}
              value={fileNote}
              onChange={(e) => setFileNote(e.target.value)}
            />
          </div>
        )}
        {tab === "file" && submitting && uploadProgress != null && (
          <div className="mt-3 space-y-1">
            <div className="flex items-center justify-between text-[12px] text-[var(--color-fg-muted)]">
              <span>{t("sources.upload.uploading")}</span>
              <span>{uploadProgress}%</span>
            </div>
            <ProgressBar value={uploadProgress} />
          </div>
        )}

        {tab === "url" && (
          <div className="space-y-3">
            <Input
              placeholder="https://example.com/article"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Textarea
              placeholder={t("sources.upload.notes_placeholder")}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        )}

        {tab === "paste" && (
          <div className="space-y-3">
            <Input
              placeholder={t("sources.upload.name_placeholder")}
              value={textName}
              onChange={(e) => setTextName(e.target.value)}
            />
            <Textarea
              placeholder={t("sources.upload.paste_placeholder")}
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t("sources.upload.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={
              (tab === "file" && !file) ||
              (tab === "url" && !url.trim()) ||
              (tab === "paste" && !text.trim())
            }
          >
            {t("sources.upload.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
};
