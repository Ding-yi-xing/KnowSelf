import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Edit3, Trash2, PanelLeftClose, Search } from "lucide-react";
import { useChatStore } from "../stores/chat";
import { useTransport } from "../stores/transport-context";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";

interface ConversationListProps {
  open: boolean;
  onClose: () => void;
}

function relativeTime(iso: string, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("time.just_now");
  if (mins < 60) return t("time.min_ago", { n: String(mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("time.hour_ago", { n: String(hours) });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.day_ago", { n: String(days) });
  const months = Math.floor(days / 30);
  if (months < 12) return t("time.month_ago", { n: String(months) });
  return t("time.year_ago", { n: String(Math.floor(months / 12)) });
}

export function ConversationList({ open, onClose }: ConversationListProps) {
  const t = useT();
  const transport = useTransport();
  const conversations = useChatStore((s) => s.conversations);
  const conversationsLoading = useChatStore((s) => s.conversationsLoading);
  const currentConversationId = useChatStore((s) => s.currentConversationId);
  const loadConversationList = useChatStore((s) => s.loadConversationList);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const startConversation = useChatStore((s) => s.startConversation);
  const reset = useChatStore((s) => s.reset);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);

  const [searchQuery, setSearchQuery] = useState("");

  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.trim().toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, searchQuery]);

  useEffect(() => {
    if (open) {
      loadConversationList(transport).catch(() => {});
    }
  }, [open, loadConversationList, transport]);

  const handleNew = useCallback(() => {
    reset();
    startConversation();
  }, [reset, startConversation]);

  const handleSelect = useCallback(
    (id: string) => {
      loadConversation(id, transport).catch(() => {});
    },
    [loadConversation, transport],
  );

  const handleRename = useCallback(
    (id: string, currentTitle: string) => {
      const title = window.prompt(t("chat.sidebar.rename_prompt"), currentTitle);
      if (title?.trim()) {
        renameConversation(id, title.trim(), transport).catch(() => {});
      }
    },
    [renameConversation, transport],
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (window.confirm(t("chat.sidebar.delete_confirm"))) {
        deleteConversation(id, transport).catch(() => {});
      }
    },
    [deleteConversation, transport],
  );

  if (!open) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
        <span className="text-[13px] font-semibold">{t("chat.sidebar.history")}</span>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <PanelLeftClose className="size-4" />
        </Button>
      </div>

      <div className="shrink-0 px-3 pt-3 pb-2">
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={handleNew}
          iconLeft={<Plus className="size-3.5" strokeWidth={2.4} />}
        >
          {t("chat.sidebar.new")}
        </Button>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("chat.sidebar.search")}
            className="pl-8"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {conversationsLoading ? (
          <div className="flex justify-center pt-8">
            <Spinner size="sm" />
          </div>
        ) : filteredConversations.length === 0 ? (
          <p className="pt-8 text-center text-[12px] text-[var(--color-fg-subtle)]">
            {searchQuery ? t("chat.sidebar.no_match") : t("chat.sidebar.no_history")}
          </p>
        ) : (
          <ul className="space-y-1">
            {filteredConversations.map((conv) => {
              const isActive = conv.id === currentConversationId;
              return (
                <li key={conv.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelect(conv.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelect(conv.id);
                      }
                    }}
                    className={cn(
                      "group w-full cursor-pointer rounded-[var(--radius-md)] px-3 py-2 text-left text-[13px] transition-colors",
                      isActive
                        ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                        : "hover:bg-[var(--color-bg-muted)] text-[var(--color-fg)]",
                    )}
                  >
                    <div className="truncate font-medium" title={conv.title}>
                      {conv.title}
                    </div>
                    <div className="mt-0.5 flex min-h-6 items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[11px] text-[var(--color-fg-subtle)]">
                        {relativeTime(conv.updated_at, t)}
                        {" · "}
                        {t("chat.sidebar.msg_count", { n: String(conv.message_count) })}
                      </span>
                      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRename(conv.id, conv.title);
                          }}
                          className="grid size-6 place-items-center rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                          title={t("chat.sidebar.rename_btn")}
                          aria-label={t("chat.sidebar.rename_btn")}
                        >
                          <Edit3 className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(conv.id);
                          }}
                          className="grid size-6 place-items-center rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                          title={t("chat.sidebar.delete_btn")}
                          aria-label={t("chat.sidebar.delete_btn")}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
