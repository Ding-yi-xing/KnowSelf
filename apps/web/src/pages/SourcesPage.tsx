import { useEffect, useState, useCallback } from "react";
import { Upload, Link, FileText, File, X, Trash2, RefreshCw, FlaskConical, CheckSquare } from "lucide-react";
import type { SourceId, DecideProposalRequest } from "@knowself/contracts";
import { useSourcesStore } from "../stores/sources";
import { useTransport } from "../stores/transport-context";
import { SourceUploadDialog } from "../components/SourceUploadDialog";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { EmptyState } from "../components/ui/empty-state";
import { Toast, ToastViewport } from "../components/ui/toast";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import type { SourceCreateInput } from "../transport/types";

const STATUS_LABEL: Record<string, string> = {
  raw: "sources.status.raw",
  distilling: "sources.status.distilling",
  pending_review: "sources.status.pending_review",
  completed: "sources.status.completed",
  rejected: "sources.status.rejected",
  distill_failed: "sources.status.distill_failed",
};

const STATUS_VARIANT: Record<string, "default" | "info" | "danger" | "outline"> = {
  raw: "default",
  distilling: "info",
  pending_review: "info",
  completed: "outline",
  rejected: "outline",
  distill_failed: "danger",
};

const KIND_ICON: Record<string, typeof File> = {
  file: File,
  url: Link,
  paste: FileText,
};

const KIND_LABEL: Record<string, string> = {
  file: "sources.kind.file",
  url: "sources.kind.url",
  paste: "sources.kind.paste",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function SourcesPage() {
  const transport = useTransport();
  const sources = useSourcesStore((s) => s.sources);
  const current = useSourcesStore((s) => s.current);
  const loading = useSourcesStore((s) => s.loading);
  const uploadProgress = useSourcesStore((s) => s.uploadProgress);
  const load = useSourcesStore((s) => s.load);
  const create = useSourcesStore((s) => s.create);
  const get = useSourcesStore((s) => s.get);
  const remove = useSourcesStore((s) => s.remove);
  const removeMany = useSourcesStore((s) => s.removeMany);
  const runIngest = useSourcesStore((s) => s.runIngest);
  const decideProposal = useSourcesStore((s) => s.decideProposal);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<Set<SourceId>>(new Set());
  const t = useT();
  const [toast, setToast] = useState<{ message: string; variant: "success" | "danger" } | null>(
    null,
  );

  useEffect(() => {
    void load(transport);
  }, [load, transport]);

  const showToast = useCallback((message: string, variant: "success" | "danger") => {
    setToast({ message, variant });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleCreate = useCallback(
    async (input: SourceCreateInput) => {
      await create(input, transport);
      showToast(t("sources.toast.added"), "success");
    },
    [create, transport, showToast],
  );

  const handleSelect = useCallback(
    (id: SourceId) => {
      void get(id, transport);
    },
    [get, transport],
  );

  const handleDelete = useCallback(
    async (id: SourceId) => {
      await remove(id, transport);
      showToast(t("sources.toast.deleted"), "success");
    },
    [remove, transport, showToast],
  );

  const handleBatchDelete = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await removeMany(ids, transport);
    setSelected(new Set());
    showToast(t("sources.toast.batch_deleted", { n: String(ids.length) }), "success");
  }, [selected, removeMany, transport, showToast]);

  const toggleSelect = useCallback((id: SourceId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === sources.length) return new Set();
      return new Set(sources.map((s) => s.id));
    });
  }, [sources]);

  const handleIngest = useCallback(
    async (id: SourceId) => {
      try {
        await runIngest(id, transport);
        showToast(t("sources.toast.distill_done"), "success");
      } catch {
        showToast(t("sources.toast.distill_fail"), "danger");
      }
    },
    [runIngest, transport, showToast],
  );

  const handleCloseDetail = useCallback(() => {
    useSourcesStore.setState({ current: null });
  }, []);

  const [editTarget, setEditTarget] = useState<{ id: string; body: string } | null>(null);
  const [expandedBody, setExpandedBody] = useState<Record<string, boolean>>({});
  const [expandedExcerpt, setExpandedExcerpt] = useState<Record<string, boolean>>({});

  const toggleBody = useCallback((id: string) => {
    setExpandedBody((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const toggleExcerpt = useCallback((id: string) => {
    setExpandedExcerpt((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleDecide = useCallback(
    async (id: string, body: DecideProposalRequest) => {
      try {
        await decideProposal(id, body, transport);
        showToast(t("sources.toast.accepted"), "success");
      } catch {
        showToast(t("sources.toast.decide_fail"), "danger");
      }
    },
    [decideProposal, transport, showToast],
  );

  const handleEditSubmit = useCallback(async () => {
    if (!editTarget) return;
    try {
      await decideProposal(editTarget.id, { decision: "edit", body: editTarget.body }, transport);
      setEditTarget(null);
      showToast(t("sources.toast.accepted"), "success");
    } catch {
      showToast(t("sources.toast.decide_fail"), "danger");
    }
  }, [editTarget, decideProposal, transport, showToast]);

  const proposalStatusLabel: Record<string, string> = {
    pending: "sources.proposal.pending",
    accepted: "sources.proposal.accepted",
    edited: "sources.proposal.edited",
    rejected: "sources.proposal.rejected",
  };

  const proposalStatusVariant: Record<string, "default" | "info" | "outline"> = {
    pending: "default",
    accepted: "info",
    edited: "info",
    rejected: "outline",
  };

  if (loading && sources.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" className="text-[var(--color-fg-subtle)]" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("sources.title")}
        subtitle={selected.size > 0 ? t("sources.batch_selected", { n: String(selected.size) }) : t("sources.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleBatchDelete()}
                iconLeft={<Trash2 className="size-3.5" strokeWidth={2.4} />}
              >
                {t("sources.batch_delete", { n: String(selected.size) })}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => setDialogOpen(true)}
              iconLeft={<Upload className="size-3.5" strokeWidth={2.4} />}
            >
              {t("sources.add")}
            </Button>
          </div>
        }
      />

      <div className="relative flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6">
          {sources.length === 0 ? (
            <EmptyState
              icon={<FileText className="size-6" strokeWidth={1.8} />}
              title={t("sources.empty.title")}
              description={t("sources.empty.desc")}
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setDialogOpen(true)}
                  iconLeft={<Upload className="size-3.5" strokeWidth={2.4} />}
                >
                  {t("sources.add")}
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {sources.map((s) => {
                const Icon = KIND_ICON[s.kind] ?? File;
                const isDetailOpen = current?.source.id === s.id;
                const isSelected = selected.has(s.id);
                return (
                  <Card
                    key={s.id}
                    hoverable
                    compact
                    className={cn("cursor-pointer", isDetailOpen && "border-[var(--color-accent)]")}
                    onClick={() => handleSelect(s.id)}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        onClick={(e) => { e.stopPropagation(); toggleSelect(s.id); }}
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border transition-colors mt-1",
                          isSelected
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-fg-on-accent)]"
                            : "border-[var(--color-border)] hover:border-[var(--color-fg-muted)]",
                        )}
                      >
                        {isSelected && <CheckSquare className="size-3.5" strokeWidth={3} />}
                      </div>
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]">
                        <Icon className="size-4" strokeWidth={1.8} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">
                          {s.original_name || t(KIND_LABEL[s.kind] ?? "")}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge variant={STATUS_VARIANT[s.status] ?? "default"}>
                            {t(STATUS_LABEL[s.status] ?? s.status ?? "")}
                          </Badge>
                          <span className="text-[11px] text-[var(--color-fg-subtle)]">
                            {formatTime(s.created_at)}
                          </span>
                        </div>
                      </div>
                    </div>
                    {(s.status === "raw" || s.status === "distill_failed") && (
                      <div className="mt-3 flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleIngest(s.id);
                          }}
                          iconLeft={<FlaskConical className="size-3.5" strokeWidth={2} />}
                        >
                          {t("sources.distill_btn")}
                        </Button>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {current && (
          <aside
            className={cn(
              "flex w-[400px] shrink-0 flex-col overflow-hidden border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]",
              "fade-in",
            )}
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-3">
              <h3 className="truncate text-[14px] font-semibold">
                {current.source.original_name || t("sources.detail.title")}
              </h3>
              <button
                type="button"
                onClick={handleCloseDetail}
                className="rounded-[var(--radius-sm)] p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="mb-4 flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[current.source.status] ?? "default"}>
                  {t(STATUS_LABEL[current.source.status] ?? current.source.status)}
                </Badge>
                <span className="text-[12px] text-[var(--color-fg-subtle)]">
                  {t(KIND_LABEL[current.source.kind] ?? "")}
                </span>
              </div>

              {current.source.extracted_text && (
                <div className="mb-4">
                  <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-subtle)]">
                    {t("sources.detail.preview")}
                  </h4>
                  <p className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-3 text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">
                    {current.source.extracted_text.slice(0, 2000)}
                    {current.source.extracted_text.length > 2000 ? "..." : ""}
                  </p>
                </div>
              )}

              {current.proposals.length > 0 && (
                <div className="mb-4">
                  <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-subtle)]">
                    {t("sources.detail.distill")}
                  </h4>
                  <div className="space-y-3">
                    {current.proposals.map((p) => {
                      const pending = p.status === "pending";
                      return (
                        <Card key={p.id} compact className={cn(!pending && "opacity-60")}>
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Badge variant="info" className="text-[10px]">
                                {p.target.kind === "core"
                                  ? t("sources.detail.target.core")
                                  : p.target.kind === "card_section"
                                    ? t("sources.detail.target.card", {
                                        k: p.target.card_key,
                                        s: p.target.section,
                                      })
                                    : p.target.kind === "chat_message"
                                      ? t("sources.detail.target.chat_message", {
                                          n: String(p.target.message_ids.length),
                                        })
                                      : t("sources.detail.target.journal", {
                                          d: p.target.date,
                                        })}
                              </Badge>
                              {!pending && (
                                <Badge variant={proposalStatusVariant[p.status] ?? "default"}>
                                  {t(proposalStatusLabel[p.status] ?? p.status)}
                                </Badge>
                              )}
                            </div>
                            <div>
                              <p className="whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--color-fg)]">
                                {expandedBody[p.id] || p.proposed_body.length <= 150
                                  ? p.proposed_body
                                  : p.proposed_body.slice(0, 150) + "..."}
                              </p>
                              {p.proposed_body.length > 150 && (
                                <button
                                  type="button"
                                  onClick={() => toggleBody(p.id)}
                                  className="mt-1 text-[11px] text-[var(--color-accent)] hover:underline"
                                >
                                  {expandedBody[p.id]
                                    ? t("sources.detail.collapse")
                                    : t("sources.detail.expand")}
                                </button>
                              )}
                            </div>
                            {p.source_excerpts.length > 0 && (
                              <div>
                                <button
                                  type="button"
                                  onClick={() => toggleExcerpt(p.id)}
                                  className="text-[11px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                                >
                                  {expandedExcerpt[p.id]
                                    ? t("sources.detail.collapse_refs")
                                    : t("sources.detail.view_refs", {
                                        n: String(p.source_excerpts.length),
                                      })}
                                </button>
                                {expandedExcerpt[p.id] && (
                                  <div className="mt-1 space-y-1">
                                    {p.source_excerpts.map((ex, i) => (
                                      <p
                                        key={i}
                                        className="rounded-[var(--radius-sm)] bg-[var(--color-bg-muted)] p-2 text-[11px] leading-[1.5] text-[var(--color-fg-muted)]"
                                      >
                                        {current.source.extracted_text.slice(ex.start, ex.end)}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                            {pending && (
                              <div className="flex gap-2 pt-1">
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => {
                                    void handleDecide(p.id, { decision: "accept" });
                                  }}
                                >
                                  {t("sources.detail.accept")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setEditTarget({
                                      id: p.id,
                                      body: p.proposed_body,
                                    })
                                  }
                                >
                                  {t("sources.detail.edit")}
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => {
                                    void handleDecide(p.id, { decision: "reject" });
                                  }}
                                >
                                  {t("sources.detail.reject")}
                                </Button>
                              </div>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleIngest(current.source.id)}
                  iconLeft={<RefreshCw className="size-3.5" strokeWidth={2} />}
                >
                  {t("sources.detail.redistill")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    void handleDelete(current.source.id);
                    handleCloseDetail();
                  }}
                  iconLeft={<Trash2 className="size-3.5" strokeWidth={2} />}
                >
                  {t("sources.detail.delete")}
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>

      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="mx-4 w-full max-w-[420px] rounded-[var(--radius-lg)] bg-[var(--color-bg)] p-5 shadow-lg">
            <h4 className="mb-3 text-[14px] font-semibold">{t("sources.detail.edit_title")}</h4>
            <textarea
              className="min-h-[120px] w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[13px] leading-[1.55]"
              value={editTarget.body}
              onChange={(e) => setEditTarget({ ...editTarget, body: e.target.value })}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditTarget(null)}>
                {t("sources.detail.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void handleEditSubmit();
                }}
              >
                {t("sources.detail.submit")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <SourceUploadDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleCreate}
        uploadProgress={uploadProgress}
      />

      {toast && (
        <ToastViewport>
          <Toast variant={toast.variant === "success" ? "success" : "danger"}>
            {toast.message}
          </Toast>
        </ToastViewport>
      )}
    </div>
  );
}
